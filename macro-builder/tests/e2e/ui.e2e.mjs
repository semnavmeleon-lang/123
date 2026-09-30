// Сквозной тест интерфейса конструктора и popup в настоящем Chromium с загруженным расширением:
// макрос собирается кликами (шаблон, палитра, таблица, правила длины, цикл, отчёт, условия),
// запускается (пробный и полный прогон), проверяются выбор значения из таблицы, красная подсветка
// элементов на странице, отчёты, конфиг, popup, а также отсутствие эмодзи и светлая тема.
// Запуск: NODE_PATH=$(npm root -g) node macro-builder/tests/e2e/ui.e2e.mjs
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
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

// Страница, на которой проверяются выбор и подсветка элементов
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>Тест-страница</title>
    <input id="q" placeholder="ФИО">
    <table><tr class="row"><td>Тишин</td><td><button class="dots">Действия</button></td></tr>
    <tr class="row"><td>Шапарь</td><td><button class="dots">Действия</button></td></tr></table>`);
}).listen(0);
const PORT = server.address().port;

const ctx = await chromium.launchPersistentContext(path.join(TMP, "profile"), {
  channel: "chromium", headless: true, acceptDownloads: true,
  colorScheme: "dark", // системная тёмная тема не должна менять внешний вид: интерфейс только светлый
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const errors = [];
let failed = false;
const storage = (b, key) => b.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
const macros = async (b) => (await storage(b, "mb_macros")) || [];
const seg = (scope, text) => scope.locator("button.seg", { hasText: text });
const PICTO = /[\p{Extended_Pictographic}\u{FE0F}]/u;

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
  const insp = b.locator('[data-role="inspector"]');
  const row = (type) => b.locator(`[data-role="step-row"][data-step-type="${type}"]`);
  const addTop = () => b.locator('[data-role="steps"] > [data-role="add-step"]').click();

  // ---------- 1. пустое состояние, светлая тема, отсутствие эмодзи ----------
  console.log("== 1. пустое состояние: шаблоны, светлая тема при тёмной системной, без эмодзи");
  await b.waitForSelector('[data-role="templates"]');
  assert.equal(await b.locator("[data-template]").count(), 3);
  const bg = await b.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, bl] = bg.match(/\d+/g).map(Number);
  assert.ok(r > 220 && g > 220 && bl > 220, "фон светлый даже при тёмной системной теме: " + bg);
  assert.equal(PICTO.test(await b.locator("body").innerText()), false, "в интерфейсе нет эмодзи");
  await b.locator('[data-template="blank"]').click();
  await b.waitForSelector('[data-role="macro-title"]');
  assert.match(await b.locator('[data-role="status"]').innerText(), /Нет шагов/);
  await b.fill('[data-role="macro-title"]', "Проверка строк");

  // ---------- 2. палитра: таблица, столбцы, правила ----------
  console.log("== 2. палитра: Данные из Excel/CSV, столбцы кликом, правила пропуска");
  await b.locator('[data-role="add-first"]').click();
  await b.fill('[data-role="palette-search"]', "excel");
  assert.equal(await b.locator("[data-add]").count(), 1, "поиск в палитре фильтрует");
  await b.locator('[data-add="loadExcel"]').click();
  await insp.locator('input[data-role="file"]').setInputFiles(path.join(TMP, "rows.xlsx"));
  await b.waitForSelector('[data-role="preview"]');
  await seg(insp, "Таблица").click();
  await insp.locator("th.pickable", { hasText: "ФИО" }).click();
  await insp.locator("th.pickable", { hasText: "Телефон" }).click();
  const names = await insp.locator("th input[type=text]").evaluateAll((els) => els.map((e) => e.value));
  console.log("имена переменных:", names);
  assert.deepEqual(names, ["polis", "fio", "telefon"]);
  await insp.locator("summary", { hasText: "Пропускать записи по длине" }).click();
  await insp.getByRole("button", { name: "Добавить правило" }).click();
  await insp.getByRole("button", { name: "Добавить правило" }).click();
  assert.equal(await insp.locator('[data-role="rules"] .rule').count(), 2);
  await insp.locator('[data-role="rules"] .rule').nth(0).locator("input[type=number]").fill("18");
  await insp.locator('[data-role="rules"] .rule').nth(1).locator("select").nth(0).selectOption("telefon");
  await insp.locator('[data-role="rules"] .rule').nth(1).locator("input[type=number]").fill("11");
  await insp.locator('[data-role="rules"] .rule').nth(1).locator("select").nth(2).selectOption("digits");
  const result = await insp.locator('[data-role="result"]').innerText();
  console.log("результат:", result);
  assert.match(result, /Готово: 2 строки · пропущено 2/);
  assert.match(await row("loadExcel").locator(".tr-detail").innerText(), /2 строки · polis, fio, telefon · пропущено 2/, "строка структуры описывает шаг");
  assert.equal(await insp.locator('[data-role="preview"] tr.skipped').count(), 2);

  // ---------- 3. цикл ----------
  console.log("== 3. Для каждой записи: источник выбран автоматически, блок «При ошибке»");
  await addTop();
  await b.locator('[data-add="loopList"]').click();
  assert.equal(await insp.locator('input[list="dl-lists"]').first().inputValue(), "rows");
  await seg(insp, "Пропустить запись").click();
  assert.equal(await b.locator('.tree-branch-label[data-kind="catch"]').count(), 1);
  await b.waitForTimeout(500);

  // ---------- 4. отчёт внутри цикла, вставка значения ----------
  console.log("== 4. Записать в MD-отчёт внутри цикла + список «Вставить значение»");
  await b.locator('[data-branch="each"] > [data-role="add-step"]').click();
  await b.locator('[data-add="appendReport"]').click();
  const tpl = insp.locator("textarea").first();
  await tpl.fill("row ${_row}: ");
  await tpl.focus();
  await insp.locator('[data-role="insert-value"]').selectOption("${fio}");
  assert.equal(await tpl.inputValue(), "row ${_row}: ${fio}");
  await tpl.evaluate((el) => { el.value += " / ${polis} / ${telefon}"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.match(await b.locator('[data-role="status"]').innerText(), /Готов к запуску/);

  // ---------- 5. запуск ----------
  console.log("== 5. запуск: пробный прогон (1 запись), затем полный");
  await b.evaluate(() => chrome.storage.local.remove("mb_reports"));
  await b.locator('[data-role="run"]').click();
  await seg(b.locator(".modal"), "В новой вкладке").click();
  await b.locator(".modal .check input[type=checkbox]").check();
  await b.locator(".modal input[type=number]").fill("1");
  await b.locator('[data-role="run-confirm"]').click();
  await b.waitForFunction(() => /Готово|Ошибка/.test(document.querySelector('[data-role="drawer"] .drawer-title')?.textContent || ""), null, { timeout: 20000 });
  assert.match(await b.locator('[data-role="drawer"] .drawer-title').innerText(), /Готово/);
  let rep = (await storage(b, "mb_reports"))["report.md"].text;
  assert.deepEqual(rep.split("\n").filter((l) => l.startsWith("row")), ["row 2: Тишин Юрий Романович / 25470CFI4440002174 / +7 (905) 419-40-15"]);
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
  const briefLines = await b.locator('[data-role="log"] .log-line').count();
  await b.locator('[data-role="drawer"] .check input').check();
  assert.ok((await b.locator('[data-role="log"] .log-line').count()) > briefLines, "«Подробно» показывает больше");
  assert.equal(PICTO.test(await b.locator('[data-role="drawer"]').innerText()), false, "в журнале нет эмодзи");

  // ---------- 6. отчёты ----------
  console.log("== 6. окно «Отчёты»");
  await b.locator('[data-role="reports-link"]').click();
  await b.waitForSelector('[data-report="report.md"]');
  const [dl] = await Promise.all([b.waitForEvent("download"), b.locator('[data-report="report.md"] button', { hasText: "Скачать" }).click()]);
  await dl.saveAs(path.join(TMP, "dl.md"));
  assert.equal(fs.readFileSync(path.join(TMP, "dl.md"), "utf8"), rep);
  await b.keyboard.press("Escape");

  // ---------- 7. значение из таблицы в шаге «Ввести текст» ----------
  console.log("== 7. «Ввести текст»: значение выбирается из списка столбцов таблицы");
  await b.locator('[data-branch="each"] > [data-role="add-step"]').click();
  await b.locator('[data-add="type"]').click();
  const src = insp.locator('[data-role="value-source"]').first();
  const options = await src.locator("option").allInnerTexts();
  console.log("варианты значения:", options.slice(0, 6).join(" | "));
  assert.ok(options.includes("Свой текст"));
  assert.ok(options.includes("ФИО  (fio)") || options.some((o) => /ФИО.*\(fio\)/.test(o)), "столбец «ФИО» из таблицы есть в списке");
  assert.ok(options.some((o) => /Телефон.*\(telefon\)/.test(o)));
  assert.equal(await insp.locator('[data-role="value-field"] input[type=text]').count(), 1, "пока выбран «Свой текст», виден ввод текста");
  await src.selectOption("${fio}");
  assert.equal(await insp.locator('[data-role="value-field"] input[type=text]').count(), 0, "выбран столбец - ввод текста скрыт");
  await insp.locator('[data-role="pick"] input').fill("#q");
  await b.waitForTimeout(700);
  const typeStep = (await macros(b))[0].steps[1].steps.find((s) => s.type === "type");
  assert.equal(typeStep.value, "${fio}", "в шаг записано значение столбца");
  assert.match(await row("type").locator(".tr-detail").innerText(), /#q ← \$\{fio\}/);
  // обратно на свой текст
  await insp.locator('[data-role="value-source"]').first().selectOption("");
  await insp.locator('[data-role="value-field"] input[type=text]').fill("Иванов ${polis}");
  assert.equal(await insp.locator('[data-role="insert-value"]').count(), 0, "рядом с полем ввода нет лишнего списка «Вставить значение»");
  await b.waitForTimeout(500);

  // ---------- 8. красная подсветка элементов на странице ----------
  console.log("== 8. «Показать» и «Указать на странице»: красная подсветка с названием элемента");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("target pageerror: " + e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await b.bringToFront();
  await b.locator('.tabbar button', { hasText: "Обновить" }).click();
  await b.waitForFunction(() => Array.from(document.querySelectorAll('[data-role="tab-select"] option')).some((o) => /Тест-страница/.test(o.textContent)));
  await b.selectOption('[data-role="tab-select"]', { label: "Тест-страница" });
  await insp.locator('[data-role="pick"] input').fill("button.dots");
  await insp.locator(".pick-buttons button", { hasText: "Показать" }).click();
  await page.waitForSelector(".__mb-hl");
  const boxes = await page.locator(".__mb-hl").count();
  assert.equal(boxes, 2, "подсвечены оба найденных элемента");
  const style = await page.locator(".__mb-hl").first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { border: cs.borderTopColor, width: cs.borderTopWidth, shadow: cs.boxShadow };
  });
  console.log("стиль подсветки:", JSON.stringify(style));
  assert.equal(style.border, "rgb(255, 26, 26)", "рамка красная");
  assert.ok(parseFloat(style.width) >= 3, "рамка толстая");
  assert.match(style.shadow, /rgba?\(255, 26, 26/, "красное свечение");
  const labels = await page.locator(".__mb-hl-label").allInnerTexts();
  console.log("подписи:", labels.join(" | "));
  assert.match(labels[0], /^1\. button\.dots "Действия"/);
  assert.match(labels[1], /^2\. button\.dots/);
  const labelBg = await page.locator(".__mb-hl-label").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(labelBg, "rgb(255, 26, 26)", "подпись на красном фоне");
  assert.match(await page.locator(".__mb-hl-banner").innerText(), /Найдено элементов: 2/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".__mb-hl").count(), 0, "Esc убирает подсветку");
  // несуществующий элемент
  await b.bringToFront();
  await insp.locator('[data-role="pick"] input').fill(".нет-такого");
  await insp.locator(".pick-buttons button", { hasText: "Показать" }).click();
  await page.waitForSelector(".__mb-hl-banner");
  assert.match(await page.locator(".__mb-hl-banner").innerText(), /Элемент не найден/);
  // режим выбора мышью: подсветка следует за курсором и подписана
  await b.bringToFront();
  await insp.locator(".pick-buttons button", { hasText: "Указать на странице" }).click();
  await page.bringToFront();
  await page.hover("#q");
  await page.waitForSelector(".__mb-hl-label");
  const hoverLabel = await page.locator(".__mb-hl-label").first().innerText();
  console.log("подпись при наведении:", hoverLabel);
  assert.match(hoverLabel, /^input#q/);
  assert.equal(await page.locator(".__mb-hl").first().evaluate((el) => getComputedStyle(el).borderTopColor), "rgb(255, 26, 26)");
  await page.click("#q");
  await b.waitForFunction(() => document.querySelector('[data-role="inspector"] [data-role="pick"] input')?.value === "#q");

  // ---------- 9. условия ----------
  console.log("== 9. условие: проверки, предупреждения, переход к проблемному шагу");
  await b.bringToFront();
  await addTop();
  await b.locator('[data-add="condition"]').click();
  assert.match(await b.locator('[data-role="status"]').innerText(), /Замечаний: 1/);
  assert.match(await row("condition").locator(".tr-warn").first().innerText(), /Не заполнено/);
  await insp.getByRole("button", { name: "Добавить условие" }).click();
  await b.locator(".popover .menu-item", { hasText: "Два значения" }).click();
  await insp.locator("select").first().selectOption("any");
  const tests = insp.locator('[data-role="test"]');
  assert.equal(await tests.count(), 2);
  await tests.nth(0).locator('input[placeholder^="например"]').fill(".result");
  // значение слева - столбец таблицы из списка
  await tests.nth(1).locator('[data-role="value-source"]').first().selectOption("${fio}");
  await tests.nth(1).locator("select").nth(2).selectOption("lenGt"); // kind, левое значение, операция
  await tests.nth(1).locator('[data-role="value-field"] input[type=text]').last().fill("10");
  const detail = await row("condition").locator(".tr-detail").first().innerText();
  console.log("описание:", detail);
  assert.match(detail, /\.result есть на странице ИЛИ \$\{fio\} длина > 10/);
  assert.match(await b.locator('[data-role="status"]').innerText(), /Готов к запуску/);
  await tests.nth(0).locator("select").nth(1).selectOption("yes"); // kind, «есть/нет», тип селектора
  assert.match(await row("condition").locator(".tr-detail").first().innerText(), /\.result нет на странице/);
  // предупреждение: шаг без селектора, клик по статусу выбирает его
  await addTop();
  await b.locator('[data-add="click"]').click();
  await row("condition").first().click();
  await b.locator('[data-role="status"]').click();
  await b.waitForSelector('[data-step-type="click"].selected');
  assert.match(await insp.locator(".insp-title").innerText(), /Клик/);

  // ---------- 10. настройки ----------
  console.log("== 10. настройки макроса: параметр и автозапуск");
  await b.locator('[data-role="settings-row"]').click();
  await insp.getByRole("button", { name: "Добавить параметр" }).click();
  await insp.getByRole("button", { name: "Добавить автозапуск" }).click();
  await b.locator(".popover .menu-item", { hasText: "Каждый день" }).click();
  await b.waitForTimeout(700);
  const cur = (await macros(b))[0];
  assert.equal(cur.inputs.length, 1);
  assert.equal(cur.triggers.length, 1);
  assert.equal(cur.triggers[0].type, "daily");
  assert.match(await b.locator('[data-role="settings-row"] .tr-detail').innerText(), /параметров: 1 · автозапуск: 1/);

  // ---------- 11. конфиг ----------
  console.log("== 11. конфиг: без данных / с данными, загрузка поверх и на чистую установку");
  await b.locator(".side-links button", { hasText: "Конфиг" }).click();
  let [d1] = await Promise.all([b.waitForEvent("download"), b.locator('[data-role="config-save"]').click()]);
  const p1 = path.join(TMP, "cfg-nodata.json");
  await d1.saveAs(p1);
  const cfg1 = JSON.parse(fs.readFileSync(p1, "utf8"));
  assert.equal(cfg1.format, "macro-builder-config");
  assert.deepEqual(cfg1.macros[0].steps[0].rows, [], "данные таблицы в конфиг не попали");
  assert.equal(cfg1.macros[0].steps[0].columns.length, 3);
  assert.match(await b.locator('[data-role="config-status"]').innerText(), /не попали/);
  await b.locator(".modal .check input").check();
  [d1] = await Promise.all([b.waitForEvent("download"), b.locator('[data-role="config-save"]').click()]);
  const p2 = path.join(TMP, "cfg-data.json");
  await d1.saveAs(p2);
  assert.equal(JSON.parse(fs.readFileSync(p2, "utf8")).macros[0].steps[0].rows.length, 2);
  await b.locator('[data-role="config-file"]').setInputFiles(p1);
  await b.waitForFunction(() => /заменено 1/.test(document.querySelector('[data-role="config-status"]')?.textContent || ""));
  assert.equal((await macros(b))[0].steps[0].rows.length, 2, "данные таблицы не потерялись");
  await b.keyboard.press("Escape");
  await b.evaluate(() => chrome.storage.local.set({ mb_macros: [] }));
  await b.reload();
  await b.waitForSelector('[data-role="templates"]');
  await b.locator(".side-links button", { hasText: "Конфиг" }).click();
  await b.locator('[data-role="config-file"]').setInputFiles(p2);
  await b.waitForFunction(() => /добавлено макросов 1/.test(document.querySelector('[data-role="config-status"]')?.textContent || ""));
  const restored = (await macros(b)).find((m) => m.name === "Проверка строк");
  assert.ok(restored);
  assert.equal(restored.steps[0].rows.length, 2);
  await b.keyboard.press("Escape");

  // ---------- 12. шаблон и импорт ----------
  console.log("== 12. шаблон «Проверка строк таблицы на сайте» + импорт JSON создаёт копию");
  await b.getByRole("button", { name: "Новый макрос" }).click();
  await b.locator('.modal [data-template="proverka-strok.json"]').click();
  await b.waitForFunction(() => /Проверка строк таблицы на сайте/.test(document.querySelector('[data-role="macro-title"]')?.value || ""));
  assert.equal(await b.locator('[data-role="step-row"][data-step-type="condition"]').count(), 2);
  const one = path.join(TMP, "one.json");
  fs.writeFileSync(one, JSON.stringify([restored]));
  await b.locator('[data-role="import-file"]').setInputFiles(one);
  await b.waitForFunction(async () => ((await chrome.storage.local.get("mb_macros")).mb_macros || []).filter((m) => m.name === "Проверка строк").length === 2);

  // ---------- 12b. раскладка: поля не сжимаются, лишних списков нет ----------
  console.log("== 12b. раскладка всех шагов при таблице в макросе (две ширины окна)");
  await b.locator('[data-role="macro-list"] .macro-item', { hasText: "Проверка строк" }).first().click();
  await b.waitForSelector('[data-role="step-row"][data-step-type="loadExcel"]');
  const ALL = ["navigate", "wait", "waitFor", "switchTab", "closeTab", "scroll", "click", "type", "clearField", "hover", "keypress", "loadExcel",
    "extract", "extractTable", "setVar", "appendReport", "exportCsv", "condition", "loopList", "loopCount", "loopContinue", "loopBreak", "stopMacro", "customJs"];
  const measure = () => b.evaluate(() => {
    const box = document.querySelector('[data-role="inspector"]');
    const bad = [];
    for (const el of box.querySelectorAll("input[type=text], input:not([type]), textarea")) {
      if (el.closest("th") || el.closest(".rule") || el.closest(".tree") || el.offsetParent === null) continue;
      if (el.getBoundingClientRect().width < 150) bad.push((el.placeholder || el.className || el.tagName) + ": " + Math.round(el.getBoundingClientRect().width));
    }
    for (const sel of box.querySelectorAll("select")) {
      if (sel.offsetParent !== null && sel.getBoundingClientRect().right > box.getBoundingClientRect().right + 1) bad.push("select вылез: " + sel.title);
    }
    return { bad, overflow: box.scrollWidth - box.clientWidth, inserts: box.querySelectorAll('[data-role="insert-value"]').length, selects: box.querySelectorAll("select").length };
  });
  for (const width of [1360, 1100]) {
    await b.setViewportSize({ width, height: 800 });
    for (const t of ALL) {
      await b.locator('[data-role="steps"] > [data-role="add-step"]').click();
      await b.locator(`[data-add="${t}"]`).click();
      const m = await measure();
      assert.deepEqual(m.bad, [], `шаг ${t} при ширине ${width}: сжатые поля ${JSON.stringify(m.bad)}`);
      assert.ok(m.overflow <= 1, `шаг ${t} при ширине ${width}: панель шире окна на ${m.overflow}px`);
      if (t === "navigate") assert.equal(m.selects, 0, "у «Открыть страницу» одно поле, без списков");
      if (t !== "appendReport") assert.equal(m.inserts, 0, `у шага ${t} нет списка «Вставить значение»`);
    }
    // лишние шаги убираем, чтобы следующая ширина начиналась с чистого макроса
    for (let i = 0; i < ALL.length; i++) {
      await b.locator('[data-role="inspector"] .insp-actions button', { hasText: "Удалить" }).click();
    }
  }
  await b.setViewportSize({ width: 1280, height: 720 });

  // ---------- 13. весь интерфейс без эмодзи ----------
  console.log("== 13. полный обход: ни на одном экране нет эмодзи");
  const screens = [];
  screens.push(await b.locator("body").innerText());
  for (const t of ["loadExcel", "loopList", "condition", "click", "appendReport"]) {
    const el = b.locator(`[data-role="step-row"][data-step-type="${t}"]`).first();
    if (await el.count()) { await el.click(); screens.push(await b.locator("body").innerText()); }
  }
  await b.locator('[data-role="steps"] > [data-role="add-step"]').click();
  screens.push(await b.locator(".popover").innerText());
  await b.keyboard.press("Escape");
  await b.locator('[data-role="settings-row"]').click();
  screens.push(await b.locator("body").innerText());
  assert.ok(screens.every((s) => !PICTO.test(s)), "на экранах есть эмодзи");

  // ---------- 14. popup ----------
  console.log("== 14. popup: список макросов и кнопки запуска");
  const pop = await ctx.newPage();
  pop.on("pageerror", (e) => errors.push("popup pageerror: " + e.message));
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForSelector('[data-role="pop-list"]');
  assert.ok((await pop.locator("[data-run]").count()) >= 3);
  assert.match(await pop.locator('[data-role="pop-list"]').innerText(), /Проверка строк таблицы на сайте/);
  assert.equal(PICTO.test(await pop.locator("body").innerText()), false, "в popup нет эмодзи");

  console.log("\nошибки страницы:", errors.length ? errors : "нет");
  assert.equal(errors.length, 0);
  console.log("UI E2E OK");
} catch (e) {
  failed = true;
  console.log("UI E2E FAILED:", e.stack || e.message);
  console.log("ошибки страницы:", errors);
} finally {
  await ctx.close();
  server.close();
  process.exitCode = failed ? 1 : 0;
}
