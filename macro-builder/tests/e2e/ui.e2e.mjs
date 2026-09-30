// Сквозной тест интерфейса конструктора и popup в настоящем Chromium с загруженным расширением:
// макрос собирается кликами (шаблон, палитра, таблица, правила длины, цикл, отчёт, условия),
// запускается (пробный и полный прогон), проверяются отчёты, конфиг и popup.
// Запуск: NODE_PATH=$(npm root -g) node macro-builder/tests/e2e/ui.e2e.mjs
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

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
const seg = (scope, text) => scope.locator("button.seg", { hasText: text });

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const b = await ctx.newPage();
  b.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  b.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await b.goto(`chrome-extension://${extId}/builder.html`);
  await b.evaluate(() => chrome.storage.local.set({ mb_macros: [] }));
  await b.reload();

  // ---------- 1. пустое состояние и шаблоны ----------
  console.log("== 1. пустое состояние → шаблон «Пустой макрос»");
  await b.waitForSelector('[data-role="templates"]');
  assert.equal(await b.locator('[data-template]').count(), 3, "три шаблона + импорт");
  await b.locator('[data-template="blank"]').click();
  await b.waitForSelector('[data-role="macro-title"]');
  assert.match(await b.locator('[data-role="status"]').innerText(), /Нет шагов/);
  await b.fill('[data-role="macro-title"]', "Проверка строк");

  // ---------- 2. палитра: таблица построчно + правила длины ----------
  console.log("== 2. палитра → «Данные из Excel/CSV»: таблица, столбцы кликом, правила пропуска");
  await b.locator('[data-role="add-first"]').click();
  await b.fill('[data-role="palette-search"]', "excel");
  assert.equal(await b.locator("[data-add]").count(), 1, "поиск в палитре фильтрует");
  await b.locator('[data-add="loadExcel"]').click();
  let card = b.locator('[data-step-type="loadExcel"]');
  await card.locator('input[data-role="file"]').setInputFiles(path.join(TMP, "rows.xlsx"));
  await b.waitForSelector('[data-role="preview"]');
  await seg(card, "Таблица").click();
  card = b.locator('[data-step-type="loadExcel"]');
  await card.locator("th.pickable", { hasText: "ФИО" }).click();
  await b.locator('[data-step-type="loadExcel"] th.pickable', { hasText: "Телефон" }).click();
  const names = await b.locator('[data-step-type="loadExcel"] th input[type=text]').evaluateAll((els) => els.map((e) => e.value));
  console.log("имена переменных:", names);
  assert.deepEqual(names, ["polis", "fio", "telefon"]);
  // правила: polis != 18 символов, telefon != 11 цифр
  await b.locator('[data-step-type="loadExcel"] summary', { hasText: "Пропускать записи по длине" }).click();
  await b.getByRole("button", { name: "Добавить правило" }).click();
  await b.getByRole("button", { name: "Добавить правило" }).click();
  let rules = b.locator('[data-role="rules"] .rule');
  assert.equal(await rules.count(), 2);
  await rules.nth(0).locator("input[type=number]").fill("18");
  await rules.nth(1).locator("select").nth(0).selectOption("telefon");
  await b.locator('[data-role="rules"] .rule').nth(1).locator("input[type=number]").fill("11");
  await b.locator('[data-role="rules"] .rule').nth(1).locator("select").nth(2).selectOption("digits");
  const result = await b.locator('[data-role="result"]').innerText();
  console.log("результат:", result);
  assert.match(result, /2 строки готово · пропущено 2/);
  assert.match(await b.locator('[data-step-type="loadExcel"] .step-detail').first().innerText(), /2 строки · polis, fio, telefon · пропущено 2/, "свёрнутая карточка описывает шаг");
  // предпросмотр показывает, какие строки будут пропущены
  assert.equal(await b.locator('[data-role="preview"] tr.skipped').count(), 2);

  // ---------- 3. цикл: источник подставляется сам ----------
  console.log("== 3. «Для каждой записи»: источник выбран автоматически, ошибки не останавливают");
  await b.locator('[data-role="add-step"]').last().click();
  await b.locator('[data-add="loopList"]').click();
  const loopCard = b.locator('[data-step-type="loopList"]').first();
  assert.equal(await loopCard.locator('input[list="dl-lists"]').first().inputValue(), "rows");
  await seg(loopCard, "Пропустить запись").click();
  assert.equal(await b.locator('.branch[data-kind="catch"]').count(), 1, "появился блок «При ошибке»");
  await b.waitForTimeout(500);

  // ---------- 4. отчёт внутри цикла ----------
  console.log("== 4. «Записать в MD-отчёт» внутри цикла + вставка переменной");
  await b.locator('.branch[data-kind="each"] [data-role="add-step"]').click();
  await b.locator('[data-add="appendReport"]').click();
  const tpl = b.locator('[data-step-type="appendReport"] textarea').first();
  await tpl.fill("row ${_row}: ");
  await tpl.focus();
  await b.locator('[data-role="chips"] .chip', { hasText: "${fio}" }).click();
  assert.equal(await tpl.inputValue(), "row ${_row}: ${fio}");
  await tpl.evaluate((el) => { el.value += " / ${polis} / ${telefon}"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.match(await b.locator('[data-role="status"]').innerText(), /Готов к запуску/);

  // ---------- 5. запуск: пробный и полный ----------
  console.log("== 5. запуск: пробный прогон (1 запись), затем полный");
  await b.evaluate(() => chrome.storage.local.remove("mb_reports"));
  await b.locator('[data-role="run"]').click();
  await seg(b.locator(".modal"), "В новой вкладке").click();
  await b.locator(".modal .check input[type=checkbox]").check();
  await b.locator('.modal input[type=number]').fill("1");
  await b.locator('[data-role="run-confirm"]').click();
  await b.waitForFunction(() => /Готово|Ошибка/.test(document.querySelector('[data-role="drawer"] .drawer-title')?.textContent || ""), null, { timeout: 20000 });
  assert.match(await b.locator('[data-role="drawer"] .drawer-title').innerText(), /Готово/);
  let rep = (await storage(b, "mb_reports"))["report.md"].text;
  assert.deepEqual(rep.split("\n").filter((l) => l.startsWith("row")), ["row 2: Тишин Юрий Романович / 25470CFI4440002174 / +7 (905) 419-40-15"], "пробный прогон обработал одну запись");
  assert.match(await b.locator('[data-role="drawer"] .progress-label').innerText(), /Запись 1 из 2/);

  await b.locator('[data-role="run"]').click();
  await seg(b.locator(".modal"), "В новой вкладке").click();
  await b.locator('[data-role="run-confirm"]').click();
  await b.waitForFunction(() => /Готово|Ошибка/.test(document.querySelector('[data-role="drawer"] .drawer-title')?.textContent || ""), null, { timeout: 20000 });
  rep = (await storage(b, "mb_reports"))["report.md"].text;
  console.log("--- report.md ---\n" + rep + "-----------------");
  assert.deepEqual(rep.split("\n").filter((l) => l.startsWith("row")), [
    "row 2: Тишин Юрий Романович / 25470CFI4440002174 / +7 (905) 419-40-15",
    "row 5: Пятый Пётр / 25470CFI4440007777 / 89181234567",
  ]);
  // журнал: без «Подробно» видны записи цикла, а с ним - и обычные шаги
  const briefLines = await b.locator('[data-role="log"] .log-line').count();
  await b.locator('[data-role="drawer"] .check input').check();
  assert.ok((await b.locator('[data-role="log"] .log-line').count()) > briefLines, "«Подробно» показывает больше");

  // ---------- 6. отчёты ----------
  console.log("== 6. окно «Отчёты»");
  await b.waitForSelector('.side-link .badge');
  await b.locator(".side-link", { hasText: "Отчёты" }).click();
  await b.waitForSelector('[data-report="report.md"]');
  const [dl] = await Promise.all([b.waitForEvent("download"), b.locator('[data-report="report.md"] button', { hasText: "Скачать" }).click()]);
  await dl.saveAs(path.join(TMP, "dl.md"));
  assert.equal(fs.readFileSync(path.join(TMP, "dl.md"), "utf8"), rep);
  await b.keyboard.press("Escape");

  // ---------- 7. условия ----------
  console.log("== 7. условие: проверки, предупреждения, переход к проблемному шагу");
  await b.locator('[data-role="steps"] > [data-role="add-step"]').click();
  await b.locator('[data-add="condition"]').click();
  let cond = b.locator('[data-step-type="condition"]').first();
  assert.match(await b.locator('[data-role="status"]').innerText(), /1 замечани/, "пустая проверка помечена");
  assert.match(await cond.locator(".step-warn").first().innerText(), /Укажите элемент/);
  await cond.getByRole("button", { name: "Добавить условие" }).click();
  await b.locator(".popover .menu-item", { hasText: "Два значения" }).click();
  cond = b.locator('[data-step-type="condition"]').first();
  await cond.locator("select").first().selectOption("any"); // верно хотя бы одно
  const tests = b.locator('[data-step-type="condition"] [data-role="test"]');
  assert.equal(await tests.count(), 2);
  await tests.nth(0).locator('input[placeholder^="например"]').fill(".result");
  await tests.nth(1).locator("input[type=text]").nth(0).fill("${fio}");
  await tests.nth(1).locator("select").nth(1).selectOption("lenGt"); // первый select - вид проверки, второй - операция
  await tests.nth(1).locator("input[type=text]").nth(1).fill("10");
  const detail = await b.locator('[data-step-type="condition"] .step-detail').first().innerText();
  console.log("описание:", detail);
  assert.match(detail, /\.result есть на странице ИЛИ \$\{fio\} длина > 10/);
  assert.match(await b.locator('[data-role="status"]').innerText(), /Готов к запуску/);
  // «НЕ» переворачивает проверку в описании
  await tests.nth(0).locator("select").last().selectOption("yes");
  assert.match(await b.locator('[data-step-type="condition"] .step-detail').first().innerText(), /\.result нет на странице/);

  // предупреждение → клик по статусу раскрывает нужный шаг
  await b.locator('[data-step-type="condition"] [data-role="step-head"]').first().click(); // свернуть
  await b.locator('[data-role="steps"] > [data-role="add-step"]').click();
  await b.locator('[data-add="click"]').click();
  await b.locator('[data-step-type="click"]').last().locator('[data-role="step-head"]').click(); // свернуть
  await b.locator('[data-role="status"]').click();
  await b.waitForSelector('[data-step-type="click"].open');
  assert.equal(await b.locator('.step.open').count(), 1, "раскрыт ровно один шаг");

  // ---------- 8. настройки ----------
  console.log("== 8. настройки: параметр запуска и автозапуск");
  await b.locator("summary", { hasText: "Параметры запуска" }).click();
  await b.getByRole("button", { name: "Добавить параметр" }).click();
  await b.locator("summary", { hasText: "Автозапуск" }).click();
  await b.getByRole("button", { name: "Добавить автозапуск" }).click();
  await b.locator(".popover .menu-item", { hasText: "Каждый день" }).click();
  await b.waitForTimeout(700);
  const cur = (await macros(b))[0];
  assert.equal(cur.inputs.length, 1);
  assert.equal(cur.triggers.length, 1);
  assert.equal(cur.triggers[0].type, "daily");

  // ---------- 9. конфиг ----------
  console.log("== 9. конфиг: сохранить без данных / с данными, загрузить поверх и на чистую установку");
  await b.locator(".side-link", { hasText: "Конфиг" }).click();
  let [d1] = await Promise.all([b.waitForEvent("download"), b.locator('[data-role="config-save"]').click()]);
  const p1 = path.join(TMP, "cfg-nodata.json");
  await d1.saveAs(p1);
  const cfg1 = JSON.parse(fs.readFileSync(p1, "utf8"));
  assert.equal(cfg1.format, "macro-builder-config");
  assert.equal(cfg1.macros[0].name, "Проверка строк");
  assert.deepEqual(cfg1.macros[0].steps[0].rows, [], "данные таблицы (ПДн) в конфиг не попали");
  assert.equal(cfg1.macros[0].steps[0].columns.length, 3, "настройки столбцов сохранены");
  assert.match(await b.locator('[data-role="config-status"]').innerText(), /не попали/);
  await b.locator(".modal .check input").check();
  [d1] = await Promise.all([b.waitForEvent("download"), b.locator('[data-role="config-save"]').click()]);
  const p2 = path.join(TMP, "cfg-data.json");
  await d1.saveAs(p2);
  assert.equal(JSON.parse(fs.readFileSync(p2, "utf8")).macros[0].steps[0].rows.length, 2);
  assert.match(await b.locator('[data-role="config-status"]').innerText(), /персональные данные/);
  // загрузка без данных ПОВЕРХ существующего: данные сохраняются
  await b.locator('[data-role="config-file"]').setInputFiles(p1);
  await b.waitForFunction(() => /заменено 1/.test(document.querySelector('[data-role="config-status"]')?.textContent || ""));
  assert.equal((await macros(b))[0].steps[0].rows.length, 2, "данные таблицы не потерялись");
  await b.keyboard.press("Escape");
  // чистая установка
  await b.evaluate(() => chrome.storage.local.set({ mb_macros: [] }));
  await b.reload();
  await b.waitForSelector('[data-role="templates"]');
  await b.locator(".side-link", { hasText: "Конфиг" }).click();
  await b.locator('[data-role="config-file"]').setInputFiles(p2);
  await b.waitForFunction(() => /добавлено макросов 1/.test(document.querySelector('[data-role="config-status"]')?.textContent || ""));
  const restored = (await macros(b)).find((m) => m.name === "Проверка строк");
  assert.ok(restored, "макрос восстановлен");
  assert.equal(restored.steps[0].rows.length, 2);
  assert.match(await b.locator('[data-role="macro-list"]').innerText(), /Проверка строк/);
  await b.keyboard.press("Escape");

  // ---------- 10. шаблон из примера и импорт одного макроса ----------
  console.log("== 10. шаблон «Проверка строк таблицы на сайте» + импорт JSON создаёт копию");
  await b.getByRole("button", { name: "Новый макрос" }).click();
  await b.locator('.modal [data-template="proverka-strok.json"]').click();
  await b.waitForFunction(() => /Проверка строк таблицы на сайте/.test(document.querySelector('[data-role="macro-title"]')?.value || ""));
  assert.equal(await b.locator('[data-step-type="condition"]').count(), 2, "вложенные условия шаблона отрисованы");
  const one = path.join(TMP, "one.json");
  fs.writeFileSync(one, JSON.stringify([restored]));
  await b.locator('[data-role="import-file"]').setInputFiles(one);
  await b.waitForFunction(async () => ((await chrome.storage.local.get("mb_macros")).mb_macros || []).filter((m) => m.name === "Проверка строк").length === 2);

  // ---------- 11. popup ----------
  console.log("== 11. popup: список макросов и кнопки запуска");
  const pop = await ctx.newPage();
  pop.on("pageerror", (e) => errors.push("popup pageerror: " + e.message));
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForSelector('[data-role="pop-list"]');
  assert.ok((await pop.locator("[data-run]").count()) >= 3);
  assert.match(await pop.locator('[data-role="pop-list"]').innerText(), /Проверка строк таблицы на сайте/);

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
