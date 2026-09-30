// Service worker: единственное место, которое реально управляет вкладками и
// последовательно выполняет шаги макроса. content.js выполняет только один
// шаг за раз по команде отсюда - вся оркестрация (навигация, ожидание,
// циклы, условия, переменные, повторы при ошибке, планировщик) живёт здесь.

import { substitute, loadMacros, STORAGE_KEY, patternToRegex } from "./common.js";

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

async function doNavigate(ctx, step) {
  const url = substitute(step.url, ctx.vars);
  await chrome.tabs.update(ctx.tabId, { url });
  await waitForTabComplete(ctx.tabId, Number(step.timeoutMs) || 25000);
  await sleep(250);
  await ensureContentScript(ctx.tabId);
}

function subStep(step, vars) {
  const out = { ...step };
  for (const k of ["url", "selector", "value", "rowSelector"]) {
    if (typeof out[k] === "string") out[k] = substitute(out[k], vars);
  }
  return out;
}

function resolveList(ctx, step) {
  const raw = ctx.vars[step.sourceKey];
  if (Array.isArray(raw)) return raw.map(String);
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
        await runSteps(ctx, step.steps);
      }
      return;
    }
    case "loopList": {
      const list = resolveList(ctx, step);
      for (const item of list) {
        if (ctx.cancelled()) return;
        ctx.vars[step.itemVar || "item"] = item;
        await runSteps(ctx, step.steps);
      }
      return;
    }
    case "condition": {
      const res = await sendToContent(
        ctx,
        { action: "check", step: subStep(step, ctx.vars) },
        Number(step.timeoutMs) || 5000
      );
      const exists = !!(res && res.exists);
      const branch = step.mode === "notExists" ? !exists : exists;
      await runSteps(ctx, branch ? step.then : step.else);
      return;
    }
    case "customJs": {
      const value = await runCustomJs(ctx, step);
      if (step.saveTo) ctx.vars[step.saveTo] = value;
      return;
    }
    case "loadExcel": {
      const values = Array.isArray(step.values) ? step.values : [];
      if (!values.length) {
        throw new Error("В шаге нет данных - откройте макрос в конструкторе и выберите файл Excel/CSV");
      }
      ctx.vars[step.varName || "list"] = values.slice();
      ctx.log({ type: step.type, status: "info", message: `${values.length} знач. → ${step.varName || "list"}` });
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
        Number(step.timeoutMs) || 15000
      );
      if (!res || !res.ok) throw new Error((res && res.error) || "Шаг завершился с ошибкой");
      if ((step.type === "extract" || step.type === "extractTable") && step.varName) ctx.vars[step.varName] = res.value;
      return;
    }
  }
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] && tabs[0].id;
}

async function runMacro(macro, inputValues, runId, existingTabId) {
  const cancelState = { cancelled: false };
  runs.set(runId, cancelState);
  try {
    let tabId = existingTabId;
    if (macro.openInNewTab || !tabId) {
      const tab = await chrome.tabs.create({ url: "about:blank" });
      tabId = tab.id;
    }
    await ensureContentScript(tabId);

    const ctx = {
      tabId,
      vars: { ...inputValues },
      cancelled: () => !!runs.get(runId)?.cancelled,
      log: (entry) => broadcast({ type: "mb-log", runId, entry }),
    };

    broadcast({ type: "mb-run-start", runId, macroId: macro.id, macroName: macro.name });
    await runSteps(ctx, macro.steps);
    broadcast({ type: "mb-run-done", runId, macroId: macro.id });
  } catch (e) {
    broadcast({ type: "mb-run-error", runId, macroId: macro.id, message: e.message });
  } finally {
    runs.delete(runId);
  }
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
      runMacro(msg.macro, msg.inputValues || {}, msg.runId, tabId);
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
