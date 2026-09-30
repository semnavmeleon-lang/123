// Сквозной тест исполнителя: сценарий «поиск → сравнение → три точки → новая вкладка → отчёт» на сайте-имитации.
// Запуск: NODE_PATH=$(npm root -g) node macro-builder/tests/e2e/backend.e2e.mjs
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright"); // NODE_PATH=$(npm root -g) node ...
const startSite = require("./fakesite.cjs");

import os from "node:os";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mb-e2e-"));
const { defaultStep, defaultTest } = await import(path.join(EXT, "common.js"));
const st = (type, over = {}) => ({ ...defaultStep(type), ...over });

const { server, port } = await startSite();
const base = `http://localhost:${port}/`;

const ROWS = [
  { fio: "Тишин Юрий Романович", policy: "25470CFI4440002174", _row: 2 },
  { fio: "Шапарь Елена Ивановна", policy: "25470CFI4440002995", _row: 3 },
  { fio: "Несуществующий Иван Иванович", policy: "000", _row: 4 },
  { fio: "Сломанов Пётр Ильич", policy: "BROKEN", _row: 5 },
];

function checkerMacro(name, loopOver = {}, reportOver = {}) {
  const report = (template) => st("appendReport", { filename: "e2e-report.md", header: "# Проверка ${_date}\n", template, ...reportOver });
  return {
    id: "m_" + name, name, updatedAt: 0, openInNewTab: true, inputs: [], triggers: [],
    steps: [
      st("loadExcel", { mode: "rows", varName: "rows", rows: ROWS, columns: [{ index: 0, varName: "fio" }] }),
      st("loopList", {
        sourceKey: "rows", itemVar: "item", onRowError: "continue", ...loopOver,
        steps: [
          st("navigate", { url: base }),
          st("type", { selector: "#q", value: "${fio}" }),
          st("click", { selector: "#search" }),
          st("wait", { ms: 800 }),
          st("condition", {
            logic: "all",
            tests: [{ ...defaultTest("elementText"), selector: ".row .name", op: "containsWords", value: "${fio}" }],
            then: [
              st("click", { selector: ".dots", scopeSelector: "tr.row", scopeText: "${fio}" }),
              st("click", { selectorType: "text", selector: "Посмотреть данные полиса", scopeSelector: "tr.row", scopeText: "${fio}" }),
              st("switchTab", { source: "popup" }),
              st("extract", { selector: "#holder", varName: "holder", timeoutMs: 1500 }),
              st("extract", { selector: "#status", varName: "pstatus", timeoutMs: 1500 }),
              st("closeTab"),
              st("condition", {
                tests: [{ ...defaultTest("var"), left: "${holder}", op: "containsWords", right: "${fio}" }],
                then: [st("setVar", { varName: "verdict", value: "OK" })],
                else: [st("setVar", { varName: "verdict", value: "ФИО НЕ СОВПАЛО" })],
              }),
              report("## Строка ${_row}: ${fio}\n- Статус полиса: ${pstatus}\n- Итог: ${verdict}\n"),
            ],
            else: [report("## Строка ${_row}: ${fio}\n- НЕ НАЙДЕНО в результатах поиска\n")],
          }),
        ],
        catchSteps: [report("## Строка ${_row}: ${fio}\n- ОШИБКА: ${_error}\n")],
      }),
    ],
  };
}

const ctx = await chromium.launchPersistentContext(path.join(TMP, "profile"), {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

async function runMacro(b, macro, trialLimit = 0) {
  return b.evaluate(async ([macro, trialLimit]) => {
    await chrome.storage.local.set({ mb_macros: [macro] });
    const runId = "t" + Math.random();
    const logs = [];
    const progress = [];
    return new Promise((resolve) => {
      const fn = (msg) => {
        if (!msg || msg.runId !== runId) return;
        if (msg.type === "mb-progress") progress.push(`${msg.index}/${msg.total}:${msg.label}`);
        if (msg.type === "mb-log") logs.push(`${msg.entry.type} ${msg.entry.status} ${msg.entry.message || ""}`);
        if (msg.type === "mb-run-done") { chrome.runtime.onMessage.removeListener(fn); resolve({ ok: true, logs, progress }); }
        if (msg.type === "mb-run-error") { chrome.runtime.onMessage.removeListener(fn); resolve({ ok: false, error: msg.message, logs, progress }); }
      };
      chrome.runtime.onMessage.addListener(fn);
      chrome.runtime.sendMessage({ action: "runMacro", macro, inputValues: {}, runId, tabId: null, trialLimit });
    });
  }, [macro, trialLimit]);
}
const storage = (b, key) => b.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);

let failed = false;
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const b = await ctx.newPage();
  const errors = [];
  b.on("pageerror", (e) => errors.push(e.message));
  await b.goto(`chrome-extension://${extId}/builder.html`);
  await b.waitForSelector(".side");

  // ---------- 1. сценарий пользователя ----------
  console.log("== 1. проверка строк: поиск -> сравнение -> три точки -> новая вкладка -> отчёт");
  await b.evaluate(() => chrome.storage.local.remove(["mb_reports", "mb_progress"]));
  let r = await runMacro(b, checkerMacro("checker"));
  console.log(r.logs.filter((l) => !/ ok $/.test(l)).join("\n"));
  assert.equal(r.ok, true, "макрос завершился: " + r.error);
  const rep = (await storage(b, "mb_reports"))["e2e-report.md"].text;
  console.log("--- отчёт ---\n" + rep + "-------------");
  assert.match(rep, /## Строка 2: Тишин Юрий Романович\n- Статус полиса: Действует\n- Итог: OK/);
  assert.match(rep, /## Строка 3: Шапарь Елена Ивановна\n- Статус полиса: Действует\n- Итог: OK/, "выбрана строка с Ивановной, а не Игоревной");
  assert.doesNotMatch(rep, /Расторгнут/);
  assert.match(rep, /## Строка 4: Несуществующий Иван Иванович\n- НЕ НАЙДЕНО/);
  assert.match(rep, /## Строка 5: Сломанов Пётр Ильич\n- ОШИБКА: .*#holder/);
  assert.match(rep, /^# Проверка \d{4}-\d{2}-\d{2}\n/);
  const leftovers = ctx.pages().filter((p) => p.url().includes("/policy"));
  assert.equal(leftovers.length, 0, "лишние вкладки карточек полиса закрыты (в т.ч. после ошибки)");
  assert.deepEqual(Object.keys((await storage(b, "mb_progress")) || {}), [], "прогресс не хранится без resume");

  // файл отчёта в «Загрузки»: проверяем через chrome.downloads (Playwright перехватывает загрузки и переименовывает файлы)
  await new Promise((res) => setTimeout(res, 1500));
  const dl = await b.evaluate(async () => (await chrome.downloads.search({ orderBy: ["-startTime"], limit: 5 }))
    .map((d) => ({ state: d.state, bytes: d.fileSize || d.totalBytes || d.bytesReceived, mime: d.mime, name: d.filename, err: d.error, url: d.url.slice(0, 40) })));
  console.log("загрузки:", JSON.stringify(dl));
  assert.ok(dl.length >= 1, "загрузка отчёта создана через chrome.downloads");
  assert.equal(dl[0].state, "complete", "загрузка завершена, ошибка: " + dl[0].err);
  assert.equal(dl[0].bytes, Buffer.byteLength(rep, "utf8"), "размер файла = размеру отчёта в байтах UTF-8");
  assert.match(dl[0].url, /^data:text\/markdown/);

  // ---------- 2. лимит + продолжение с места остановки ----------
  console.log("== 2. limit=2 + resume: два запуска подряд продолжают друг друга");
  await b.evaluate(() => chrome.storage.local.remove(["mb_reports", "mb_progress"]));
  const resumeM = checkerMacro("resume", { limit: 2, resume: true }, { resetPerRun: false }); // один и тот же макрос: id шагов стабильны, как в хранилище
  const resumeMacro = () => resumeM;
  r = await runMacro(b, resumeMacro());
  assert.equal(r.ok, true, r.error);
  let rep1 = (await storage(b, "mb_reports"))["e2e-report.md"].text;
  assert.match(rep1, /Тишин/); assert.match(rep1, /Шапарь/); assert.doesNotMatch(rep1, /Несуществующий/);
  const prog = await storage(b, "mb_progress");
  console.log("прогресс после 1-го запуска:", JSON.stringify(prog));
  assert.equal(Object.values(prog)[0].done, 2);
  r = await runMacro(b, resumeMacro());
  console.log(r.logs.filter((l) => /продолжаю|лимит/.test(l)).join("\n"));
  assert.ok(r.logs.some((l) => /продолжаю с записи 3 из 4/.test(l)));
  const rep2 = (await storage(b, "mb_reports"))["e2e-report.md"].text;
  assert.match(rep2, /Тишин/); assert.match(rep2, /Несуществующий/); assert.match(rep2, /Сломанов/);
  assert.equal(((rep2.match(/# Проверка/g)) || []).length, 1, "заголовок не дублируется при дозаписи");
  assert.deepEqual(Object.keys((await storage(b, "mb_progress")) || {}), [], "цикл дошёл до конца - прогресс очищен");

  // ---------- 2b. пробный прогон ----------
  console.log("== 2b. пробный прогон (trialLimit): ограничивает записи, прогресс не сохраняется, есть события прогресса");
  await b.evaluate(() => chrome.storage.local.remove(["mb_reports", "mb_progress"]));
  const trialM = checkerMacro("trial", { resume: true }, { resetPerRun: false });
  r = await runMacro(b, trialM, 1);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.progress, ["1/4:Тишин Юрий Романович"], "одна запись, подпись - первое поле");
  const trialRep = (await storage(b, "mb_reports"))["e2e-report.md"].text;
  assert.match(trialRep, /Тишин/);
  assert.doesNotMatch(trialRep, /Шапарь/);
  assert.deepEqual(Object.keys((await storage(b, "mb_progress")) || {}), [], "пробный прогон не сохраняет прогресс");
  // обычный прогон после пробного идёт с начала
  r = await runMacro(b, trialM, 0);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.progress.length, 4, "прогресс для каждой из 4 записей");
  assert.ok(!r.logs.some((l) => /продолжаю/.test(l)));

  // ---------- 2c. очистка поля ----------
  console.log("== 2c. «Очистить поле»: стирает текст, обычный «Ввести текст» без очистки дописывает");
  await b.evaluate(() => chrome.storage.local.remove(["mb_reports"]));
  const clearMacro = {
    id: "m_clear", name: "clear", updatedAt: 0, openInNewTab: true, inputs: [], triggers: [],
    steps: [
      st("navigate", { url: base }),
      st("type", { selector: "#q", value: "abc" }),
      st("type", { selector: "#q", value: "def", clear: false }),
      st("extract", { selector: "#q", attr: "value", varName: "v1", timeoutMs: 1500 }),
      st("clearField", { selector: "#q", timeoutMs: 1500 }),
      st("extract", { selector: "#q", attr: "value", varName: "v2", timeoutMs: 1500 }),
      st("clearField", { selector: ".dots-нет", timeoutMs: 800 }),
    ],
  };
  r = await runMacro(b, { ...clearMacro, steps: clearMacro.steps.slice(0, 6).concat([st("appendReport", { filename: "e2e-clear.md", header: "", template: "v1=${v1};v2=${v2}" })]) });
  assert.equal(r.ok, true, r.error);
  assert.equal((await storage(b, "mb_reports"))["e2e-clear.md"].text, "v1=abcdef;v2=\n");
  r = await runMacro(b, clearMacro);
  assert.equal(r.ok, false);
  assert.match(r.error, /Элемент не найден: \.dots-нет/, "нет такого поля - понятная ошибка");

  // ---------- 2d. поле ввода: обёртки, label, contenteditable, shadow DOM ----------
  console.log("== 2d. «Ввести текст» / «Очистить поле»: настоящее поле находится внутри обёртки, понятная ошибка если поля нет");
  const formsUrl = base + "forms";
  const valueOf = (selector, name) => st("extract", { selector, attr: "value", varName: name, timeoutMs: 1500 });
  await b.evaluate(() => chrome.storage.local.remove(["mb_reports"]));
  r = await runMacro(b, {
    id: "m_forms", name: "forms", updatedAt: 0, openInNewTab: true, inputs: [], triggers: [],
    steps: [
      st("navigate", { url: formsUrl }),
      st("type", { selector: "#wrap1", value: "Иванов", timeoutMs: 1500 }), // обёртка -> input внутри
      st("type", { selector: ".ph", value: "!", clear: false, timeoutMs: 1500 }), // placeholder-надпись -> единственное поле блока
      st("type", { selector: "#lbl2", value: "8-900", timeoutMs: 1500 }), // подпись label -> связанное поле
      st("type", { selector: "#ce", value: "новый", timeoutMs: 1500 }), // contenteditable
      st("type", { selector: "#sh", value: "теневой", timeoutMs: 1500 }), // поле в shadow DOM
      st("type", { selector: "#mat-input-123456", value: "Петров", timeoutMs: 1500 }),
      valueOf("#real1", "v1"),
      valueOf("#real2", "v2"),
      st("extract", { selector: "#ce", attr: "text", varName: "v3", timeoutMs: 1500 }),
      valueOf("#sh", "v4"),
      valueOf("#mat-input-123456", "v5"),
      st("clearField", { selector: "#wrap1", timeoutMs: 1500 }), // очистка через обёртку
      valueOf("#real1", "v6"),
      st("appendReport", { filename: "e2e-forms.md", header: "", template: "${v1}|${v2}|${v3}|${v4}|${v5}|${v6}" }),
    ],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal((await storage(b, "mb_reports"))["e2e-forms.md"].text, "Иванов!|8-900|новый|теневой|Петров|\n");
  // календарь PrimeNG: выбрана обёртка span.p-calendar (как на скриншоте пользователя), поле лежит внутри
  await b.evaluate(() => chrome.storage.local.remove(["mb_reports"]));
  r = await runMacro(b, {
    id: "m_cal", name: "cal", updatedAt: 0, openInNewTab: true, inputs: [], triggers: [],
    steps: [
      st("navigate", { url: formsUrl }),
      st("clearField", { selector: 'p-calendar[id$="_contractIssueDate_2"] span.p-calendar', timeoutMs: 1500 }),
      st("type", { selector: 'p-calendar[id$="_contractIssueDate_2"] span.p-calendar', value: "01.10.2026", blur: true, timeoutMs: 1500 }),
      st("extract", { selector: 'p-calendar[id$="_contractIssueDate_2"] input', attr: "value", varName: "d2", timeoutMs: 1500 }),
      st("extract", { selector: 'p-calendar[id$="_contractIssueDate_2"] input', attr: "data-blurred", varName: "b2", timeoutMs: 1500 }),
      st("extract", { selector: 'p-calendar[id$="_contractIssueDate_1"] input', attr: "value", varName: "d1", timeoutMs: 1500 }),
      st("appendReport", { filename: "e2e-cal.md", header: "", template: "d2=${d2};b2=${b2};d1=${d1}" }),
    ],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal((await storage(b, "mb_reports"))["e2e-cal.md"].text, "d2=01.10.2026;b2=yes;d1=\n", "дата записана во второй календарь, первый не тронут, фокус снят");
  // поля нет или их несколько: понятная ошибка вместо записи «не туда»
  for (const [selector, label] of [["#plain", "просто текст"], ["#ambig", "несколько полей"], ["#cb", "флажок"]]) {
    r = await runMacro(b, {
      id: "m_forms_err", name: "forms-err", updatedAt: 0, openInNewTab: true, inputs: [], triggers: [],
      steps: [st("navigate", { url: formsUrl }), st("type", { selector, value: "x", timeoutMs: 1500 })],
    });
    assert.equal(r.ok, false, label);
    assert.match(r.error, /не является полем ввода/, `${label}: ${r.error}`);
    assert.match(r.error, /Выберите само поле ввода/);
  }
  r = await runMacro(b, {
    id: "m_forms_miss", name: "forms-miss", updatedAt: 0, openInNewTab: true, inputs: [], triggers: [],
    steps: [st("navigate", { url: formsUrl }), st("clearField", { selector: "#нет-такого", timeoutMs: 800 })],
  });
  assert.match(r.error, /Элемент не найден: #нет-такого/);

  // ---------- 3. сигналы, setVar, старое условие, stopMacro ----------
  console.log("== 3. continue / break / increment / старое условие / stopMacro");
  const legacyCond = { id: "old1", type: "condition", selectorType: "css", selector: "#q", frameUrlIncludes: "", mode: "notExists", timeoutMs: 3000,
    then: [st("setVar", { varName: "legacy", value: "then" })], else: [st("setVar", { varName: "legacy", value: "else" })] };
  const eq = (v) => ({ ...defaultTest("var"), left: "${item}", op: "equals", right: v });
  const macro3 = {
    id: "m_sig", name: "sig", updatedAt: 0, openInNewTab: true, inputs: [], triggers: [],
    steps: [
      st("navigate", { url: base }),
      legacyCond,
      st("loadExcel", { varName: "letters", values: ["a", "b", "c", "d", "e"] }),
      st("setVar", { varName: "n", value: "0" }),
      st("loopList", { sourceKey: "letters", itemVar: "item", steps: [
        st("condition", { tests: [eq("b")], then: [st("loopContinue")], else: [] }),
        st("condition", { tests: [eq("d")], then: [st("loopBreak")], else: [] }),
        st("setVar", { varName: "n", mode: "increment", value: "" }),
        st("appendReport", { filename: "e2e-sig.md", header: "", template: "letter=${item} n=${n}" }),
      ] }),
      st("appendReport", { filename: "e2e-sig.md", template: "legacy=${legacy} итого=${n}" }),
      st("stopMacro"),
      st("appendReport", { filename: "e2e-sig.md", template: "SHOULD-NOT-APPEAR" }),
    ],
  };
  await b.evaluate(() => chrome.storage.local.remove(["mb_reports"]));
  r = await runMacro(b, macro3);
  assert.equal(r.ok, true, r.error);
  const sig = (await storage(b, "mb_reports"))["e2e-sig.md"].text;
  console.log(sig);
  assert.equal(sig, "letter=a n=1\nletter=c n=2\nlegacy=else итого=2\n");

  // ---------- 4. break вне цикла и ошибка без onRowError ----------
  console.log("== 4. loopBreak вне цикла = понятная ошибка; ошибка строки без continue останавливает макрос");
  r = await runMacro(b, { id: "m_x", name: "x", updatedAt: 0, openInNewTab: true, inputs: [], triggers: [], steps: [st("loopBreak")] });
  assert.equal(r.ok, false);
  assert.match(r.error, /вне цикла/);
  const stopping = checkerMacro("stopping", { onRowError: "stop" });
  r = await runMacro(b, stopping);
  assert.equal(r.ok, false, "ошибка на 4-й строке остановила макрос");
  assert.match(r.error, /#holder/);

  console.log("\nстраничные ошибки:", errors.length ? errors : "нет");
  console.log("BACKEND E2E OK");
} catch (e) {
  failed = true;
  console.log("BACKEND E2E FAILED:", e.stack || e.message);
} finally {
  await ctx.close();
  server.close();
  process.exitCode = failed ? 1 : 0;
}
