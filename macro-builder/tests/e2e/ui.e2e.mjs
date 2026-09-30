// Сквозной тест интерфейса конструктора: макрос собирается кликами (таблица, правила длины, цикл, отчёт,
// условия, новые шаги, конфиг). Запуск: NODE_PATH=$(npm root -g) node macro-builder/tests/e2e/ui.e2e.mjs
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

import os from "node:os";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mb-e2e-ui-"));
const XLSX = require(path.join(EXT, "vendor/xlsx.full.min.js"));
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Полис", "ФИО", "Телефон"],
    ["25470CFI4440002174", "Тишин Юрий Романович", "+7 (905) 419-40-15"],
    ["123", "Короткий Полис", "8 918 165 88 46"],
    ["25470CFI4440002995", "Шапарь Елена Ивановна", "12345"],
    ["25470CFI4440007777", "Пятый Пётр", "89181234567"],
  ]), "Выгрузка");
  fs.writeFileSync(path.join(TMP, "rows.xlsx"), Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" })));
}
const ctx = await chromium.launchPersistentContext(path.join(TMP, "profile"), {
  channel: "chromium", headless: true, acceptDownloads: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const errors = [];
let failed = false;
const storage = (b, key) => b.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
const macros = async (b) => (await storage(b, "mb_macros")) || [];

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const b = await ctx.newPage();
  b.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  b.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  b.on("dialog", (d) => d.accept());
  await b.goto(`chrome-extension://${extId}/builder.html`);
  await b.waitForSelector("#builderCard", { state: "visible" });
  const steps = () => b.locator("#stepsRoot > .step-card");
  const add = async (type) => { await b.selectOption("#addStepSelect", type); await b.click("#addStepBtn"); };

  // ---------- 1. таблица построчно + правила длины ----------
  console.log("== 1. loadExcel: режим строк, столбцы, правила пропуска по длине");
  await add("loadExcel");
  let card = steps().first();
  await card.locator("select").first().selectOption("rows");
  await card.locator('input[type=file]').setInputFiles(path.join(TMP, "rows.xlsx"));
  await b.waitForFunction(() => /Сохранено строк/.test(document.querySelector("#stepsRoot .field-note")?.textContent || ""));
  card = steps().first();
  // отмечаем ФИО и Телефон (Полис выбран по умолчанию)
  await card.locator(".col-pick", { hasText: "ФИО" }).locator("input[type=checkbox]").check();
  await card.locator(".col-pick", { hasText: "Телефон" }).locator("input[type=checkbox]").check();
  const names = await card.locator(".col-pick input[type=text]").evaluateAll((els) => els.map((e) => e.value));
  console.log("имена переменных:", names);
  assert.deepEqual(names, ["polis", "fio", "telefon"]);
  // два правила пропуска
  await card.getByRole("button", { name: "+ Правило пропуска" }).click();
  await steps().first().getByRole("button", { name: "+ Правило пропуска" }).click();
  card = steps().first();
  const rules = card.locator("div[style*='flex-wrap']");
  assert.equal(await rules.count(), 2);
  // правило 1: polis != 18 символов; правило 2: telefon != 11 цифр
  await rules.nth(0).locator("input[type=number]").fill("18");
  await rules.nth(1).locator("select").nth(0).selectOption("telefon");
  await rules.nth(1).locator("input[type=number]").fill("11");
  await rules.nth(1).locator("select").nth(2).selectOption("digits");
  const note = await card.locator(".field-note").first().innerText();
  console.log("NOTE:", note);
  assert.match(note, /Сохранено строк: 2 /);
  assert.match(note, /Пропущено по длине значения: 2/);
  await b.waitForTimeout(700);
  const saved = (await macros(b))[0].steps[0];
  assert.deepEqual(saved.rows.map((r) => r._row), [2, 5]);
  assert.equal(saved.rows[0].fio, "Тишин Юрий Романович");
  assert.deepEqual(saved.lengthRules.map((r) => [r.col, r.op, String(r.n), r.count]), [["polis", "neq", "18", "chars"], ["telefon", "neq", "11", "digits"]]);

  // ---------- 2. цикл + отчёт, запуск из интерфейса ----------
  console.log("== 2. цикл по строкам + «Дописать в MD-отчёт», запуск кнопкой");
  await add("loopList");
  const loop = steps().nth(1);
  const loopFields = loop.locator("> .step-fields");
  await loopFields.locator("input[type=text]").nth(0).fill("rows");
  await loop.locator("select").filter({ has: b.locator("option[value=continue]") }).selectOption("continue");
  assert.equal(await steps().nth(1).locator(".catch-branch").count(), 1, "появилась ветка «При ошибке»");
  const body = steps().nth(1).locator(".branch").first();
  await body.locator("select").selectOption("appendReport");
  await body.locator(".add-step-row button").click();
  const tpl = steps().nth(1).locator(".branch").first().locator("textarea").nth(1);
  await tpl.fill("row ${_row}: ");
  // панель переменных: клик по чипу вставляет ${fio} в последнее выбранное поле
  const chips = await b.locator("#varsBar .var-chip").allInnerTexts();
  console.log("переменные:", chips.join(" "));
  for (const v of ["${fio}", "${polis}", "${telefon}", "${_row}", "${_error}"]) assert.ok(chips.includes(v), "чип " + v);
  await tpl.focus();
  await b.locator("#varsBar .var-chip", { hasText: "${fio}" }).click();
  assert.equal(await tpl.inputValue(), "row ${_row}: ${fio}");
  await tpl.evaluate((el) => { el.value += " / ${polis} / ${telefon}"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await b.fill("#macroName", "Проверка строк");
  await b.check("#openInNewTab");
  await b.waitForTimeout(700);
  await b.evaluate(() => chrome.storage.local.remove("mb_reports"));
  await b.click("#runBtn");
  await b.waitForFunction(() => /Готово|Ошибка/.test(document.querySelector("#logPanel")?.textContent || ""), null, { timeout: 20000 });
  const log = await b.locator("#logPanel").innerText();
  console.log(log.split("\n").filter((l) => /запись|Ошибка|Готово|отчёт/.test(l)).join("\n"));
  assert.match(log, /Готово/);
  const rep = (await storage(b, "mb_reports"))["report.md"].text;
  console.log("--- report.md ---\n" + rep + "-----------------");
  // заголовок с датой + ровно две записи: строки 2 и 5 (строки 3 и 4 отсеяны правилами длины)
  const [reportHeader, ...reportLines] = rep.split("\n");
  assert.match(reportHeader, /^# Отчёт — \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(reportLines, [
    "row 2: Тишин Юрий Романович / 25470CFI4440002174 / +7 (905) 419-40-15",
    "row 5: Пятый Пётр / 25470CFI4440007777 / 89181234567",
    "",
  ]);

  // панель отчётов: строка, скачивание
  await b.waitForSelector("#reportsList .pool-row");
  assert.match(await b.locator("#reportsList").innerText(), /report\.md/);
  const [dl] = await Promise.all([b.waitForEvent("download"), b.locator("#reportsList button[title='Скачать .md']").click()]);
  const dlPath = path.join(TMP, "dl-report.md");
  await dl.saveAs(dlPath);
  assert.equal(fs.readFileSync(dlPath, "utf8"), rep, "скачанный из панели файл совпадает с накопленным");

  // ---------- 3. редактор условий ----------
  console.log("== 3. редактор условий: несколько проверок, И/ИЛИ, НЕ, операции, скрытие значения");
  await add("condition");
  const cond = steps().nth(2);
  assert.equal(await cond.locator(".test-card").count(), 1, "по умолчанию одна проверка «элемент есть»");
  await cond.locator(".add-step-row select").first().selectOption("elementText");
  await cond.locator(".add-step-row button", { hasText: "+ Проверка" }).click();
  await steps().nth(2).locator(".add-step-row select").first().selectOption("var");
  await steps().nth(2).locator(".add-step-row button", { hasText: "+ Проверка" }).click();
  const c2 = steps().nth(2);
  assert.equal(await c2.locator(".test-card").count(), 3);
  await c2.locator("select").first().selectOption("any"); // ИЛИ
  const varCard = c2.locator(".test-card").nth(2);
  await varCard.locator("input[type=text]").nth(0).fill("${fio}");
  await varCard.locator("select").nth(0).selectOption("lenGt");
  await varCard.locator("input[type=text]").nth(1).fill("10");
  await varCard.locator("input[type=checkbox]").first().check(); // НЕ
  // unary-операция скрывает поле значения
  const textCard = c2.locator(".test-card").nth(1);
  const before = await textCard.locator("input[type=text]").count();
  await textCard.locator("select").filter({ has: b.locator("option[value=notEmpty]") }).selectOption("notEmpty");
  const after = await c2.locator(".test-card").nth(1).locator("input[type=text]").count();
  assert.equal(after, before - 1, "для «не пусто» поле значения скрыто");
  await b.waitForTimeout(700);
  const cs = (await macros(b))[0].steps[2];
  assert.equal(cs.logic, "any");
  assert.deepEqual(cs.tests.map((t) => t.kind), ["element", "elementText", "var"]);
  assert.equal(cs.tests[2].op, "lenGt");
  assert.equal(cs.tests[2].negate, true);
  assert.equal(cs.tests[1].op, "notEmpty");
  // поля области поиска есть у проверки элемента
  assert.ok(await c2.locator(".test-card").nth(0).getByText("Искать внутри контейнера").count() >= 1);

  // ---------- 4. все новые шаги рисуются без ошибок ----------
  console.log("== 4. новые шаги: hover, switchTab(popup/href), closeTab, setVar, continue, break, stop");
  for (const t of ["hover", "switchTab", "closeTab", "setVar", "loopContinue", "loopBreak", "stopMacro"]) await add(t);
  const sw1 = steps().nth(4); // switchTab
  const hasSelectorBefore = await sw1.getByText("Искать внутри контейнера").count();
  await sw1.locator("select").first().selectOption("href");
  assert.ok((await steps().nth(4).getByText("Искать внутри контейнера").count()) > hasSelectorBefore, "для href появились поля селектора");
  await b.waitForTimeout(700);
  const types = (await macros(b))[0].steps.map((s) => s.type);
  assert.deepEqual(types, ["loadExcel", "loopList", "condition", "hover", "switchTab", "closeTab", "setVar", "loopContinue", "loopBreak", "stopMacro"]);

  // ---------- 5. конфиг ----------
  console.log("== 5. сохранить/загрузить конфиг");
  let [d1] = await Promise.all([b.waitForEvent("download"), b.click("#saveConfigBtn")]);
  const p1 = path.join(TMP, "cfg-nodata.json");
  await d1.saveAs(p1);
  const cfg1 = JSON.parse(fs.readFileSync(p1, "utf8"));
  assert.equal(cfg1.format, "macro-builder-config");
  assert.equal(cfg1.includesTableData, false);
  assert.equal(cfg1.macros[0].name, "Проверка строк");
  assert.deepEqual(cfg1.macros[0].steps[0].rows, [], "данные таблицы (ПДн) в конфиг не попали");
  assert.equal(cfg1.macros[0].steps[0].columns.length, 3, "настройки столбцов сохранены");
  assert.match(await b.locator("#configHint").innerText(), /не попали/);
  await b.check("#cfgIncludeData");
  [d1] = await Promise.all([b.waitForEvent("download"), b.click("#saveConfigBtn")]);
  const p2 = path.join(TMP, "cfg-data.json");
  await d1.saveAs(p2);
  assert.equal(JSON.parse(fs.readFileSync(p2, "utf8")).macros[0].steps[0].rows.length, 2);
  assert.match(await b.locator("#configHint").innerText(), /персональные данные/);

  // загрузка конфига без данных ПОВЕРХ существующего макроса: данные не теряются
  await b.locator("#loadConfigInput").setInputFiles(p1);
  await b.waitForFunction(() => /заменено 1/.test(document.querySelector("#configHint").textContent));
  assert.equal((await macros(b))[0].steps[0].rows.length, 2, "данные таблицы сохранены при загрузке конфига без данных");
  // чистая установка: макросов нет -> загрузка конфига восстанавливает всё
  await b.evaluate(() => chrome.storage.local.set({ mb_macros: [] }));
  await b.goto(`chrome-extension://${extId}/builder.html`);
  await b.waitForSelector("#builderCard", { state: "visible" });
  await b.locator("#loadConfigInput").setInputFiles(p2);
  await b.waitForFunction(() => /добавлено макросов 1/.test(document.querySelector("#configHint").textContent));
  const restored = (await macros(b)).find((m) => m.name === "Проверка строк");
  assert.ok(restored, "макрос восстановлен из конфига");
  assert.equal(restored.steps.length, 10);
  assert.equal(restored.steps[0].rows.length, 2);
  assert.match(await b.locator("#sidebarList").innerText(), /Проверка строк/);
  // старый «Импорт JSON» одного макроса: копия с новым id
  const oneMacro = path.join(TMP, "one.json");
  fs.writeFileSync(oneMacro, JSON.stringify([restored]));
  await b.locator("#importInput").setInputFiles(oneMacro);
  await b.waitForFunction(() => /Импортировано макросов: 1/.test(document.querySelector("#configHint").textContent));
  const ids = (await macros(b)).filter((m) => m.name === "Проверка строк").map((m) => m.id);
  assert.equal(new Set(ids).size, 2, "импорт одного макроса создал копию с новым id");

  console.log("\nошибки страницы:", errors.length ? errors : "нет");
  assert.equal(errors.length, 0);
  console.log("UI E2E OK");
} catch (e) {
  failed = true;
  console.log("UI E2E FAILED:", e.stack || e.message);
  console.log("ошибки страницы:", errors);
} finally {
  await ctx.close();
  process.exitCode = failed ? 1 : 0;
}
