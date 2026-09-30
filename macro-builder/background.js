// Service worker: единственное место, которое реально управляет вкладками и
// последовательно выполняет шаги макроса. content.js выполняет только один
// шаг за раз по команде отсюда - вся оркестрация (навигация, ожидание,
// циклы, условия, переменные, повторы при ошибке, планировщик) живёт здесь.

import { substitute, problemVars, describeVarProblems, loadMacros, STORAGE_KEY, patternToRegex, REPORTS_KEY, PROGRESS_KEY, progressKey } from "./common.js";
import {
  evaluateCondition,
  planResume,
  rowKey,
  sanitizeReportName,
  appendBlock,
  toBase64Utf8,
  splitReport,
  partFileName,
} from "./logic.js";

// «Следующая строка» / «Выйти из цикла» / «Завершить макрос» реализованы как исключения-сигналы:
// они проходят сквозь вложенные условия до ближайшего цикла и не считаются ошибкой шага
// (не повторяются и не попадают в журнал как ошибки).
class FlowSignal extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // "continue" | "break" | "stop"
  }
}

const runs = new Map(); // runId -> { cancelled }
let recordingTabId = null;
const activeAutoRuns = new Set(); // "tabId:macroId" - защита от само-триггеринга urlMatch

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch (e) {
    // страница нескриптуема (chrome://, webstore и т.п.) - игнорируем
  }
}

function sendToTab(tabId, message, timeoutMs = 15000, frameId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Таймаут ожидания ответа со страницы"));
      }
    }, timeoutMs);
    const cb = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    };
    try {
      if (frameId != null) chrome.tabs.sendMessage(tabId, message, { frameId }, cb);
      else chrome.tabs.sendMessage(tabId, message, cb);
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

// Находит id фрейма по подстроке его URL (для шагов, у которых заполнено
// frameUrlIncludes) - иначе всегда работаем с основным документом (frameId 0),
// чтобы поведение без этого поля не менялось.
async function resolveFrameId(ctx, step) {
  if (!step || !step.frameUrlIncludes) return 0;
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: ctx.tabId });
    const match = frames && frames.find((f) => f.url && f.url.includes(step.frameUrlIncludes));
    if (match) return match.frameId;
  } catch (e) {}
  return 0;
}

// Первая попытка может провалиться, если content.js ещё не успел
// задекларированно проинжектиться (сразу после навигации) - тогда
// подстраховываемся ручной инъекцией и пробуем ещё раз.
async function sendToContent(ctx, message, timeoutMs) {
  const frameId = await resolveFrameId(ctx, message.step);
  try {
    return await sendToTab(ctx.tabId, message, timeoutMs, frameId);
  } catch (e) {
    await ensureContentScript(ctx.tabId);
    await sleep(200);
    return await sendToTab(ctx.tabId, message, timeoutMs, frameId);
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    function finish() {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// Строка шага с подстановкой ${переменных}; незаданная переменная или целая строка таблицы - ошибка,
// а не тихая пустая строка (иначе «Ввести текст» из таблицы молча ничего не вводит)
function substituteChecked(str, vars) {
  const problems = problemVars(str, vars);
  if (problems.length) {
    const text = describeVarProblems(problems);
    throw new Error(text[0].toUpperCase() + text.slice(1));
  }
  return substitute(str, vars);
}

async function doNavigate(ctx, step) {
  const url = substituteChecked(step.url, ctx.vars);
  await chrome.tabs.update(ctx.tabId, { url });
  await waitForTabComplete(ctx.tabId, Number(step.timeoutMs) || 25000);
  await sleep(250);
  await ensureContentScript(ctx.tabId);
}

function subStep(step, vars) {
  const out = { ...step };
  for (const k of ["url", "selector", "value", "rowSelector", "scopeSelector", "scopeText"]) {
    if (typeof out[k] === "string") out[k] = substituteChecked(out[k], vars);
  }
  // «Ввести текст» со значением из таблицы: пустая ячейка - ошибка записи, а не ввод пустоты
  if (step.type === "type" && /\$\{/.test(String(step.value || "")) && out.value.trim() === "") {
    throw new Error(`Нечего вводить: значение ${step.value} пустое (пустая ячейка в таблице)`);
  }
  return out;
}

function resolveList(ctx, step) {
  const raw = ctx.vars[step.sourceKey];
  if (raw === undefined || raw === null) {
    const known = Object.keys(ctx.vars).filter((k) => Array.isArray(ctx.vars[k]));
    throw new Error(
      `Не найден список «${step.sourceKey}»: шаг «Данные из Excel/CSV» с таким именем переменной должен стоять раньше цикла` +
        (known.length ? ` (сейчас есть: ${known.join(", ")})` : " (пока ни одного списка нет)")
    );
  }
  if (Array.isArray(raw) && !raw.length) throw new Error(`Список «${step.sourceKey}» пуст - повторять нечего`);
  if (Array.isArray(raw)) return raw.map((x) => (x !== null && typeof x === "object" ? x : String(x)));
  return String(raw || "")
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toCsv(rows) {
  if (!rows || !rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(";")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(";"));
  return lines.join("\r\n");
}

// ---------------- вкладки: переход в новую вкладку и возврат ----------------

// Вкладка, открытая страницей после клика (target=_blank / window.open): ищем среди созданных
// во время запуска - по вкладке-родителю или, если родителя нет, в том же окне.
function pickNewTab(ctx) {
  for (let i = ctx.created.length - 1; i >= 0; i--) {
    const t = ctx.created[i];
    if (t.id === ctx.tabId || ctx.ignore.has(t.id)) continue;
    const byOpener = t.openerTabId != null && ctx.known.has(t.openerTabId);
    const byWindow = t.openerTabId == null && t.windowId === ctx.windowId;
    if (byOpener || byWindow) {
      ctx.created.splice(i, 1);
      return t;
    }
  }
  return null;
}

// Новая вкладка сначала about:blank, потом грузится - ждём, пока адрес и статус «complete»
// продержатся стабильно, иначе первый же шаг попадёт в пустую страницу.
async function waitTabReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      return;
    }
    const ready = tab.status === "complete" && tab.url && tab.url !== "about:blank" && !tab.pendingUrl;
    if (ready) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 400) return;
    } else {
      stableSince = 0;
    }
    await sleep(150);
  }
}

async function doSwitchTab(ctx, step) {
  const timeout = Number(step.timeoutMs) || 10000;
  let tab = null;
  if (step.source === "href") {
    const res = await sendToContent(
      ctx,
      { action: "exec", step: subStep({ ...step, type: "extract", attr: "hrefAbs", multiple: false }, ctx.vars) },
      timeout
    );
    if (!res || !res.ok || !res.value) throw new Error((res && res.error) || "У найденного элемента нет ссылки (href)");
    tab = await chrome.tabs.create({ url: res.value, openerTabId: ctx.tabId, active: true });
    ctx.ignore.add(tab.id);
  } else {
    const deadline = Date.now() + timeout;
    while (!(tab = pickNewTab(ctx))) {
      if (ctx.cancelled()) throw new Error("Остановлено пользователем");
      if (Date.now() > deadline) {
        throw new Error(
          "Новая вкладка не открылась. Если страница открывает её через window.open, разрешите для сайта " +
            "всплывающие окна в настройках Chrome или выберите вариант «открыть ссылку элемента»"
        );
      }
      await sleep(200);
    }
  }
  ctx.tabStack.push(ctx.tabId);
  ctx.tabId = tab.id;
  ctx.known.add(tab.id);
  await waitTabReady(tab.id, 25000);
  await ensureContentScript(tab.id);
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch (e) {}
  ctx.created.length = 0;
}

async function doCloseTab(ctx, silent) {
  if (!ctx.tabStack.length) {
    if (!silent) ctx.log({ type: "closeTab", status: "warn", message: "нет вкладки, открытой макросом, - ничего не закрыто" });
    return;
  }
  const closing = ctx.tabId;
  ctx.tabId = ctx.tabStack.pop();
  ctx.known.delete(closing);
  try {
    await chrome.tabs.remove(closing);
  } catch (e) {}
  try {
    await chrome.tabs.update(ctx.tabId, { active: true });
  } catch (e) {}
  ctx.created.length = 0;
}

// Закрывает вкладки, которые макрос открыл внутри итерации цикла и не закрыл сам, - иначе на
// каждой строке таблицы их становилось бы всё больше.
async function unwindTabs(ctx, depth) {
  while (ctx.tabStack.length > depth) await doCloseTab(ctx, true);
}

// ---------------- прогресс циклов и MD-отчёты ----------------

async function loadProgress() {
  const data = await chrome.storage.local.get(PROGRESS_KEY);
  return data[PROGRESS_KEY] || {};
}

async function saveProgressEntry(key, entry) {
  const all = await loadProgress();
  if (entry) all[key] = entry;
  else delete all[key];
  await chrome.storage.local.set({ [PROGRESS_KEY]: all });
}

async function loadReports() {
  const data = await chrome.storage.local.get(REPORTS_KEY);
  return data[REPORTS_KEY] || {};
}

// Буфер отчёта дублируется в chrome.storage.local (не чаще раза в секунду), чтобы при обрыве
// запуска накопленное можно было скачать из конструктора; файл в «Загрузки» пишется в конце запуска.
async function persistReports(ctx, force) {
  if (!ctx.reports.size) return;
  if (!force && Date.now() - ctx.lastReportPersist < 1000) return;
  ctx.lastReportPersist = Date.now();
  const all = await loadReports();
  for (const [name, text] of ctx.reports) all[name] = { text, updatedAt: Date.now() };
  await chrome.storage.local.set({ [REPORTS_KEY]: all });
}

async function doAppendReport(ctx, step) {
  const name = sanitizeReportName(substitute(step.filename || "report.md", ctx.vars));
  if (!ctx.reports.has(name)) {
    let buf = "";
    if (step.resetPerRun === false || ctx.continuing) buf = ((await loadReports())[name] || {}).text || "";
    if (!buf && step.header) buf = appendBlock("", substitute(step.header, ctx.vars));
    ctx.reports.set(name, buf);
  }
  ctx.reports.set(name, appendBlock(ctx.reports.get(name), substitute(step.template || "", ctx.vars)));
  await persistReports(ctx, false);
}

async function flushReports(ctx) {
  if (!ctx.reports.size) return;
  await persistReports(ctx, true);
  for (const [name, text] of ctx.reports) {
    const parts = splitReport(text);
    for (let i = 0; i < parts.length; i++) {
      const filename = partFileName(name, i, parts.length);
      await chrome.downloads.download({
        url: "data:text/markdown;charset=utf-8;base64," + toBase64Utf8(parts[i]),
        filename,
        conflictAction: "overwrite",
        saveAs: false,
      });
      ctx.log({ type: "appendReport", status: "ok", message: `отчёт сохранён: Загрузки/${filename}` });
    }
  }
}

// customJs выполняется НЕ через content.js, а через отдельную инъекцию в
// world:"MAIN" (родной JS-контекст самой страницы). Причина: content-скрипты
// в современном Chrome получают свой собственный CSP для изолированного мира,
// который запрещает new Function()/eval независимо от того, что разрешает сама
// страница - т.е. свой JS-код падал бы с "unsafe-eval" на ЛЮБОМ сайте. Запуск
// в MAIN world решает это и как бонус даёт доступ к собственным переменным/
// функциям страницы (в отличие от изолированного мира).
async function runCustomJs(ctx, step) {
  const frameId = await resolveFrameId(ctx, step);
  const injected = await chrome.scripting.executeScript({
    target: { tabId: ctx.tabId, frameIds: [frameId] },
    world: "MAIN",
    func: (code, vars) => {
      return (async () => {
        try {
          const helpers = {
            $: (s) => document.querySelector(s),
            $$: (s) => Array.from(document.querySelectorAll(s)),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          };
          const runner = new Function("vars", "helpers", `return (async () => {\n${code}\n})();`);
          const value = await runner(vars, helpers);
          return { ok: true, value: value === undefined ? null : value };
        } catch (e) {
          return { ok: false, error: e && e.message ? e.message : String(e) };
        }
      })();
    },
    args: [step.code, ctx.vars],
  });
  const r = injected && injected[0] && injected[0].result;
  if (!r || !r.ok) throw new Error((r && r.error) || "Ошибка выполнения JS");
  return r.value;
}

async function runSteps(ctx, steps) {
  for (const step of steps || []) {
    if (ctx.cancelled()) throw new Error("Остановлено пользователем");
    await runStepWithPolicy(ctx, step);
  }
}

// Оборачивает выполнение шага в политику повтора: step.retries доп. попыток
// с паузой step.retryDelayMs, а если так и не получилось - либо прерывает
// макрос (onError:"stop", по умолчанию), либо пропускает шаг и идёт дальше
// (onError:"skip").
async function runStepWithPolicy(ctx, step) {
  const attempts = Math.max(0, Number(step.retries) || 0) + 1;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (ctx.cancelled()) throw new Error("Остановлено пользователем");
    try {
      await runStep(ctx, step);
      ctx.log({ type: step.type, status: "ok" });
      return;
    } catch (e) {
      if (e instanceof FlowSignal) throw e;
      lastErr = e;
      if (i < attempts - 1) {
        ctx.log({ type: step.type, status: "retrying", message: `попытка ${i + 2} из ${attempts}: ${e.message}` });
        await sleep(Number(step.retryDelayMs) || 800);
      }
    }
  }
  if (step.onError === "skip") {
    ctx.log({ type: step.type, status: "warn", message: "пропущен после ошибки: " + lastErr.message });
    return;
  }
  ctx.log({ type: step.type, status: "error", message: lastErr.message });
  throw lastErr;
}

async function runStep(ctx, step) {
  switch (step.type) {
    case "navigate":
      return doNavigate(ctx, step);
    case "wait":
      return sleep(Number(step.ms) || 0);
    case "loopCount": {
      const n = Math.max(0, Number(substitute(String(step.count ?? ""), ctx.vars)) || 0);
      for (let i = 0; i < n; i++) {
        if (ctx.cancelled()) return;
        ctx.vars[step.itemVar || "i"] = i;
        try {
          await runSteps(ctx, step.steps);
        } catch (e) {
          if (!(e instanceof FlowSignal) || e.kind === "stop") throw e;
          if (e.kind === "break") return;
        }
      }
      return;
    }
    case "loopList":
      return runLoopList(ctx, step);
    case "condition": {
      const deps = {
        // t уже с подставленными переменными (см. evaluateCondition)
        probe: (t, wantTexts) =>
          sendToContent(ctx, { action: "check", step: { ...t, wantTexts, visibleOnly: !!t.visibleOnly } }, Number(step.timeoutMs) || 8000),
        sleep,
        now: () => Date.now(),
        cancelled: () => ctx.cancelled(),
      };
      const { result, log } = await evaluateCondition(step, ctx.vars, deps);
      for (const line of log) ctx.log({ type: step.type, status: "info", message: line });
      ctx.log({ type: step.type, status: "info", message: result ? "условие выполнено → «то»" : "условие не выполнено → «иначе»" });
      await runSteps(ctx, result ? step.then : step.else);
      return;
    }
    case "switchTab":
      return doSwitchTab(ctx, step);
    case "closeTab":
      return doCloseTab(ctx, false);
    case "setVar": {
      const name = step.varName;
      if (!name) throw new Error("Не указано имя переменной");
      const val = substitute(step.value ?? "", ctx.vars);
      if (step.mode === "increment") ctx.vars[name] = (Number(ctx.vars[name]) || 0) + (val === "" ? 1 : Number(val) || 0);
      else ctx.vars[name] = val;
      return;
    }
    case "appendReport":
      return doAppendReport(ctx, step);
    case "loopContinue":
      throw new FlowSignal("continue");
    case "loopBreak":
      throw new FlowSignal("break");
    case "stopMacro":
      throw new FlowSignal("stop");
    case "customJs": {
      const value = await runCustomJs(ctx, step);
      if (step.saveTo) ctx.vars[step.saveTo] = value;
      return;
    }
    case "loadExcel": {
      const isRows = step.mode === "rows";
      const data = Array.isArray(isRows ? step.rows : step.values) ? (isRows ? step.rows : step.values) : [];
      if (!data.length) {
        throw new Error(
          step.skipped
            ? `После пропуска по длине значения не осталось записей (пропущено ${step.skipped}) - проверьте правила в шаге`
            : "В шаге нет данных - откройте макрос в конструкторе и выберите файл Excel/CSV"
        );
      }
      const name = step.varName || (isRows ? "rows" : "list");
      ctx.vars[name] = data.slice();
      ctx.log({ type: step.type, status: "info", message: `${data.length} ${isRows ? "строк" : "знач."} → ${name}` });
      return;
    }
    case "exportCsv": {
      const rows = ctx.vars[step.sourceVar];
      if (!Array.isArray(rows)) throw new Error(`Переменная "${step.sourceVar}" не содержит таблицу (массив)`);
      const csv = toCsv(rows);
      const filename = substitute(step.filename || "export.csv", ctx.vars) || "export.csv";
      const url = "data:text/csv;charset=utf-8," + encodeURIComponent("﻿" + csv);
      await chrome.downloads.download({ url, filename, saveAs: false });
      return;
    }
    default: {
      const res = await sendToContent(
        ctx,
        { action: "exec", step: subStep(step, ctx.vars) },
        // + запас: шаг на странице сам ждёт элемент timeoutMs и должен успеть ответить понятным
        // «Элемент не найден», а не упереться в общий таймаут ожидания ответа
        (Number(step.timeoutMs) || 15000) + 4000
      );
      if (!res || !res.ok) throw new Error((res && res.error) || "Шаг завершился с ошибкой");
      if ((step.type === "extract" || step.type === "extractTable") && step.varName) ctx.vars[step.varName] = res.value;
      return;
    }
  }
}

// Цикл по списку значений или строкам таблицы. Для строки-объекта её поля становятся переменными
// (${fio}, ${policy}, ${_row}), плюс ${_index} и ${_total}. См. поля limit / resume / onRowError у шага.
// Прогресс (resume): обработанные записи запоминаются по содержимому, поэтому следующий запуск с той же
// таблицей пропускает уже сделанное, даже если таблицу поправили; по окончании прогресс очищается.
async function runLoopList(ctx, step) {
  const list = resolveList(ctx, step);
  const key = progressKey(ctx.macroId, step.id);
  const useProgress = step.resume && !ctx.trialLimit;
  let skip = list.map(() => false);
  let doneKeys = []; // ключи обработанных записей (прошлых запусков и этого)
  if (useProgress) {
    if (ctx.restartProgress && !ctx.clearedProgress.has(key)) {
      ctx.clearedProgress.add(key);
      await saveProgressEntry(key, null);
      ctx.log({ type: step.type, status: "info", message: "прогресс сброшен, начинаю с первой записи" });
    } else {
      const plan = planResume(list, (await loadProgress())[key]);
      if (plan.done) {
        if (plan.done >= list.length) {
          await saveProgressEntry(key, null);
          ctx.log({ type: step.type, status: "warn", message: `все ${list.length} записей уже обработаны в прошлом запуске; прогресс очищен - запустите ещё раз, чтобы пройти таблицу с начала` });
          return;
        }
        skip = plan.skip;
        doneKeys = list.filter((_, i) => skip[i]).map(rowKey);
        ctx.continuing = true; // отчёты этого запуска дописываются к накопленным, а не начинаются заново
        ctx.log({
          type: step.type,
          status: "info",
          message: `продолжаю с записи ${plan.next} из ${list.length}: уже обработано ${plan.done}` + (plan.foreign ? `, ещё ${plan.foreign} из сохранённых в таблице не найдено (её меняли)` : ""),
        });
      }
    }
  }
  let limit = Math.max(0, Number(step.limit) || 0);
  if (ctx.trialLimit) limit = limit ? Math.min(limit, ctx.trialLimit) : ctx.trialLimit;
  let processed = 0;
  let finished = true;
  let last = "";
  let unsaved = 0;
  // Запись прогресса на диск не после каждой записи (для больших таблиц это сотни КБ каждый раз), а порциями
  const saveEvery = Math.max(1, Math.ceil(list.length / 200));
  const persist = async () => {
    unsaved = 0;
    await saveProgressEntry(key, { v: 2, keys: doneKeys, total: list.length, at: Date.now(), last });
  };
  try {
    for (let i = 0; i < list.length; i++) {
      if (ctx.cancelled()) return;
      if (skip[i]) continue;
      if (limit && processed >= limit) {
        finished = false;
        ctx.log({ type: step.type, status: "info", message: `достигнут лимит ${limit} записей` });
        break;
      }
      const item = list[i];
      ctx.vars[step.itemVar || "item"] = item;
      if (item && typeof item === "object") Object.assign(ctx.vars, item);
      ctx.vars._index = i + 1;
      ctx.vars._total = list.length;
      ctx.log({
        type: step.type,
        status: "info",
        message: `запись ${i + 1} из ${list.length}${item && item._row ? ` (строка Excel ${item._row})` : ""}`,
      });
      // полоса прогресса в интерфейсе: подпись - первое текстовое поле записи
      const label = item && typeof item === "object" ? Object.entries(item).find(([k, v]) => !k.startsWith("_") && v)?.[1] : item;
      broadcast({ type: "mb-progress", runId: ctx.runId, stepId: step.id, index: i + 1, total: list.length, label: String(label ?? "").slice(0, 80) });
      ctx.created.length = 0;
      const depth = ctx.tabStack.length;
      let brk = false;
      try {
        await runSteps(ctx, step.steps);
      } catch (e) {
        if (e instanceof FlowSignal) {
          if (e.kind === "stop") {
            await unwindTabs(ctx, depth);
            throw e;
          }
          brk = e.kind === "break";
        } else if (step.onRowError === "continue" && !ctx.cancelled()) {
          ctx.log({ type: step.type, status: "warn", message: `ошибка в записи ${i + 1}, иду дальше: ${e.message}` });
          ctx.vars._error = e.message;
          await unwindTabs(ctx, depth);
          try {
            await runSteps(ctx, step.catchSteps);
          } catch (e2) {
            if (!(e2 instanceof FlowSignal) || e2.kind === "stop") throw e2;
            brk = e2.kind === "break";
          }
        } else {
          throw e;
        }
      }
      await unwindTabs(ctx, depth);
      processed++;
      if (useProgress) {
        doneKeys.push(rowKey(item));
        last = String(label ?? "").slice(0, 80);
        if (++unsaved >= saveEvery) await persist();
      }
      if (brk) break;
    }
  } finally {
    // остановка, ошибка или пауза: то, что успели обработать, не теряется
    if (useProgress && unsaved) await persist().catch(() => {});
  }
  if (useProgress && finished) await saveProgressEntry(key, null);
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] && tabs[0].id;
}

async function runMacro(macro, inputValues, runId, existingTabId, trialLimit, restartProgress) {
  const cancelState = { cancelled: false };
  runs.set(runId, cancelState);
  const created = [];
  const onCreated = (tab) => created.push(tab);
  chrome.tabs.onCreated.addListener(onCreated);
  const ctx = {
    macroId: macro.id,
    runId,
    trialLimit: Math.max(0, Number(trialLimit) || 0), // пробный прогон: не больше N записей в каждом цикле, прогресс не сохраняется
    restartProgress: !!restartProgress, // «Начать сначала»: сохранённый прогресс циклов сбрасывается
    clearedProgress: new Set(),
    continuing: false, // запуск продолжает прошлый: отчёты дописываются к накопленным
    tabId: null,
    windowId: null,
    tabStack: [], // вкладки, из которых макрос перешёл в новые (для «закрыть и вернуться»)
    known: new Set(), // вкладки макроса - открытые ими новые вкладки считаются «своими»
    ignore: new Set(),
    created,
    reports: new Map(),
    lastReportPersist: 0,
    vars: { ...inputValues },
    cancelled: () => !!runs.get(runId)?.cancelled,
    log: (entry) => broadcast({ type: "mb-log", runId, entry }),
  };
  let failure = null;
  try {
    let tabId = existingTabId;
    if (macro.openInNewTab || !tabId) {
      const tab = await chrome.tabs.create({ url: "about:blank" });
      tabId = tab.id;
    }
    ctx.tabId = tabId;
    ctx.known.add(tabId);
    try {
      ctx.windowId = (await chrome.tabs.get(tabId)).windowId;
    } catch (e) {}
    created.length = 0;
    await ensureContentScript(tabId);

    broadcast({ type: "mb-run-start", runId, macroId: macro.id, macroName: macro.name });
    await runSteps(ctx, macro.steps);
  } catch (e) {
    if (e instanceof FlowSignal) {
      // «Завершить макрос» - штатный выход; «Выйти из цикла»/«Следующая строка» вне цикла - ошибка построения
      if (e.kind !== "stop") failure = { message: "Шаг «" + (e.kind === "break" ? "Выйти из цикла" : "Следующая строка") + "» использован вне цикла" };
    } else {
      failure = { message: e.message };
    }
  }
  chrome.tabs.onCreated.removeListener(onCreated);
  try {
    await flushReports(ctx);
  } catch (e) {
    ctx.log({ type: "appendReport", status: "warn", message: "не удалось сохранить отчёт в файл: " + e.message + " (накопленное можно скачать в конструкторе)" });
  }
  if (failure) broadcast({ type: "mb-run-error", runId, macroId: macro.id, message: failure.message });
  else broadcast({ type: "mb-run-done", runId, macroId: macro.id });
  runs.delete(runId);
}

function defaultInputValues(macro) {
  const values = {};
  for (const inp of macro.inputs || []) values[inp.key] = inp.default || "";
  return values;
}

// ---------------- планировщик: расписание (chrome.alarms) ----------------

function alarmName(macroId, triggerId) {
  return `mb_${macroId}_${triggerId}`;
}

async function syncAlarms() {
  const macros = await loadMacros();
  const existing = await chrome.alarms.getAll();
  const wanted = new Map();
  for (const m of macros) {
    for (const t of m.triggers || []) {
      if (!t.enabled) continue;
      if (t.type === "interval") {
        wanted.set(alarmName(m.id, t.id), { periodInMinutes: Math.max(1, Number(t.everyMinutes) || 60) });
      } else if (t.type === "daily") {
        const [hh, mm] = String(t.atTime || "09:00").split(":").map(Number);
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh || 0, mm || 0, 0, 0);
        if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
        wanted.set(alarmName(m.id, t.id), { when: next.getTime(), periodInMinutes: 1440 });
      }
    }
  }
  for (const a of existing) {
    if (a.name.startsWith("mb_") && !wanted.has(a.name)) chrome.alarms.clear(a.name);
  }
  const existingNames = new Set(existing.map((a) => a.name));
  for (const [name, opts] of wanted) {
    // Пересоздаём только отсутствующие - иначе периодический будильник, уже
    // тикающий по расписанию, будет сбрасываться на каждую синхронизацию.
    if (!existingNames.has(name)) chrome.alarms.create(name, opts);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("mb_")) return;
  const macros = await loadMacros();
  for (const m of macros) {
    const trig = (m.triggers || []).find((t) => alarmName(m.id, t.id) === alarm.name);
    if (trig && trig.enabled) {
      runMacro(m, defaultInputValues(m), "auto_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7), null);
    }
  }
});

chrome.runtime.onInstalled.addListener(syncAlarms);
chrome.runtime.onStartup.addListener(syncAlarms);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) syncAlarms();
});
syncAlarms();

// ---------------- планировщик: автозапуск при открытии URL ----------------

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  const macros = await loadMacros();
  for (const m of macros) {
    for (const t of m.triggers || []) {
      if (t.type !== "urlMatch" || !t.enabled || !t.pattern) continue;
      let re;
      try {
        re = patternToRegex(t.pattern);
      } catch (e) {
        continue;
      }
      if (!re.test(tab.url)) continue;
      const key = tabId + ":" + m.id;
      if (activeAutoRuns.has(key)) continue;
      activeAutoRuns.add(key);
      runMacro(m, defaultInputValues(m), "auto_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7), tabId).finally(
        () => activeAutoRuns.delete(key)
      );
    }
  }
});

// Пока идёт запись, при каждой навигации целевой вкладки на новую страницу
// content.js там подгружается заново "с нуля" (декларативная инъекция), поэтому
// запись нужно каждый раз включать повторно - иначе клики после перехода
// по ссылке молча перестанут записываться.
const onRecordingNav = (tabId, info) => {
  if (tabId !== recordingTabId || info.status !== "complete") return;
  ensureContentScript(tabId).then(async () => {
    chrome.tabs.sendMessage(tabId, { action: "startRecording" }).catch(() => {});
    try {
      const tab = await chrome.tabs.get(tabId);
      broadcast({ action: "recordedEvent", kind: "navigate", url: tab.url });
    } catch (e) {}
  });
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "runMacro") {
    (async () => {
      const tabId = msg.macro.openInNewTab ? null : msg.tabId || (await getActiveTabId());
      runMacro(msg.macro, msg.inputValues || {}, msg.runId, tabId, msg.trialLimit, msg.restartProgress);
    })();
    sendResponse({ started: true });
    return false;
  }
  if (msg.action === "stopRun") {
    const st = runs.get(msg.runId);
    if (st) st.cancelled = true;
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "startRecording") {
    recordingTabId = msg.tabId;
    chrome.tabs.onUpdated.addListener(onRecordingNav);
    ensureContentScript(msg.tabId).then(() =>
      chrome.tabs.sendMessage(msg.tabId, { action: "startRecording" }).catch(() => {})
    );
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "stopRecording") {
    if (recordingTabId) chrome.tabs.sendMessage(recordingTabId, { action: "stopRecording" }).catch(() => {});
    chrome.tabs.onUpdated.removeListener(onRecordingNav);
    recordingTabId = null;
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "syncAlarms") {
    syncAlarms().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
