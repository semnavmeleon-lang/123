// Запуск: node --test macro-builder/tests/logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText,
  parseNumber,
  compareText,
  migrateCondition,
  evaluateCondition,
  defaultTest,
  listSignature,
  suggestVarName,
} from "../logic.js";
import { substitute } from "../common.js";

test("normalizeText: регистр, пробелы, ё=е", () => {
  assert.equal(normalizeText("  ЁЛКИНА   Ёлка "), "елкина елка");
  assert.equal(normalizeText("Иванов-Петров, И.", { stripPunct: true }), "иванов петров и");
  assert.equal(normalizeText("AbC", { ignoreCase: false }), "AbC");
});

test("parseNumber: русские форматы", () => {
  assert.equal(parseNumber("1 234,50 ₽"), 1234.5);
  assert.equal(parseNumber("16 639,00"), 16639);
  assert.equal(parseNumber("-7"), -7);
  assert.ok(Number.isNaN(parseNumber("нет данных")));
});

test("compareText: equals/contains/startsWith с нормализацией", () => {
  assert.equal(compareText("equals", "Тишин  Юрий", "тишин юрий"), true);
  assert.equal(compareText("contains", "Клиент: ТИШИН Юрий Романович (ФЛ)", "тишин юрий"), true);
  assert.equal(compareText("startsWith", "Тишин Юрий", "тишин"), true);
  assert.equal(compareText("contains", "Ёлкина", "елкина"), true);
});

test("compareText: пустое ожидаемое НЕ совпадает с contains/startsWith/containsWords", () => {
  assert.equal(compareText("contains", "что угодно", ""), false);
  assert.equal(compareText("startsWith", "что угодно", "  "), false);
  assert.equal(compareText("containsWords", "что угодно", ""), false);
  assert.equal(compareText("equals", "", ""), true);
});

test("compareText: containsWords - порядок слов и инициалы", () => {
  assert.equal(compareText("containsWords", "Юрий Тишин Романович", "Тишин Юрий Романович"), true);
  assert.equal(compareText("containsWords", "Тишин Ю.Р.", "Тишин Юрий Романович"), true);
  assert.equal(compareText("containsWords", "Тишин Юрий Романович", "Тишин Ю.Р."), true);
  assert.equal(compareText("containsWords", "Тишина Юрий", "Тишин Юрий"), false, "Тишина != Тишин");
  assert.equal(compareText("containsWords", "Шапарь Елена", "Тишин Юрий"), false);
});

test("compareText: regex, числа, empty", () => {
  assert.equal(compareText("regex", "Полис 25470CFI4440002174 активен", "\\d{5}CFI\\d+"), true);
  assert.throws(() => compareText("regex", "x", "("), /регулярное/);
  assert.equal(compareText("gt", "16 639,00", "10000"), true);
  assert.equal(compareText("lte", "5", "5"), true);
  assert.equal(compareText("gt", "нет данных", "1"), false);
  assert.equal(compareText("empty", "  ", ""), true);
  assert.equal(compareText("notEmpty", "x", ""), true);
  assert.throws(() => compareText("wat", "a", "b"), /Неизвестная/);
});

test("substitute: встроенные переменные", () => {
  assert.match(substitute("${_date}", {}), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(substitute("${_now}", {}), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(substitute("${_date}", { _date: "x" }), "x", "переменная макроса важнее встроенной");
  assert.equal(substitute("a${nope}b", {}), "ab");
});

test("migrateCondition: старая проверка «элемент найден / не найден»", () => {
  const legacyNot = migrateCondition({ selectorType: "css", selector: ".x", frameUrlIncludes: "f", mode: "notExists", then: [], else: [] });
  assert.equal(legacyNot.tests.length, 1);
  assert.equal(legacyNot.tests[0].kind, "element");
  assert.equal(legacyNot.tests[0].negate, true);
  assert.equal(legacyNot.tests[0].frameUrlIncludes, "f");
  const legacy = migrateCondition({ selector: ".y", mode: "exists" });
  assert.equal(legacy.tests[0].negate, false);
  assert.equal(legacy.logic, "all");
  // повторный вызов ничего не портит
  const again = migrateCondition(legacy);
  assert.equal(again.tests.length, 1);
});

// Фейковая «страница»: probe возвращает заданные тексты по селектору.
function deps(pageBySelector, extra = {}) {
  let clock = 0;
  return {
    probe: async (t, wantTexts) => {
      const texts = pageBySelector[t.selector] || [];
      return { count: texts.length, texts: wantTexts ? texts : undefined };
    },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    cancelled: () => false,
    ...extra,
  };
}

test("evaluateCondition: текст результата поиска содержит ФИО из таблицы (переменная)", async () => {
  const step = {
    logic: "all",
    tests: [{ ...defaultTest("elementText"), selector: ".result", op: "containsWords", value: "${fio}" }],
  };
  const page = { ".result": ["Тишин Юрий Романович", "Другой Человек"] };
  const ok = await evaluateCondition(step, { fio: "Тишин Ю. Р." }, deps(page));
  assert.equal(ok.result, true);
  const bad = await evaluateCondition(step, { fio: "Шапарь Елена Ивановна" }, deps(page));
  assert.equal(bad.result, false);
  assert.match(bad.log[0], /✘/);
  assert.match(bad.log[0], /Тишин Юрий Романович/, "в журнале видно, что реально нашли на странице");
});

test("evaluateCondition: which=first / all", async () => {
  const mk = (which) => ({ logic: "all", tests: [{ ...defaultTest("elementText"), selector: ".r", op: "contains", value: "тишин", which }] });
  const page = { ".r": ["Тишин А", "Иванов"] };
  assert.equal((await evaluateCondition(mk("any"), {}, deps(page))).result, true);
  assert.equal((await evaluateCondition(mk("first"), {}, deps(page))).result, true);
  assert.equal((await evaluateCondition(mk("all"), {}, deps(page))).result, false);
  assert.equal((await evaluateCondition(mk("all"), {}, deps({ ".r": [] }))).result, false, "нет элементов - not all");
});

test("evaluateCondition: И/ИЛИ и НЕ", async () => {
  const el = (selector, negate = false) => ({ ...defaultTest("element"), selector, negate });
  const page = { ".a": ["x"] };
  assert.equal((await evaluateCondition({ logic: "all", tests: [el(".a"), el(".b")] }, {}, deps(page))).result, false);
  assert.equal((await evaluateCondition({ logic: "any", tests: [el(".a"), el(".b")] }, {}, deps(page))).result, true);
  assert.equal((await evaluateCondition({ logic: "all", tests: [el(".a"), el(".b", true)] }, {}, deps(page))).result, true);
  assert.equal((await evaluateCondition({ logic: "any", tests: [el(".b"), el(".c")] }, {}, deps(page))).result, false);
});

test("evaluateCondition: короткое замыкание - вторая проверка не вызывается", async () => {
  const seen = [];
  const d = deps({ ".a": ["x"] }, { probe: async (t) => { seen.push(t.selector); return { count: 0 }; } });
  const el = (selector) => ({ ...defaultTest("element"), selector });
  await evaluateCondition({ logic: "all", tests: [el(".a"), el(".b")] }, {}, d);
  assert.deepEqual(seen, [".a"]);
});

test("evaluateCondition: сравнение двух переменных", async () => {
  const step = { logic: "all", tests: [{ ...defaultTest("var"), left: "${found}", op: "equals", right: "${fio}" }] };
  assert.equal((await evaluateCondition(step, { found: "Ёлкин  А", fio: "елкин а" }, deps({}))).result, true);
  assert.equal((await evaluateCondition(step, { found: "Иванов", fio: "елкин а" }, deps({}))).result, false);
});

test("evaluateCondition: waitMs опрашивает, пока проверка не станет истинной", async () => {
  let calls = 0;
  const d = deps({}, { probe: async () => ({ count: ++calls >= 3 ? 1 : 0 }) });
  const step = { logic: "all", tests: [{ ...defaultTest("element"), selector: ".late", waitMs: 5000 }] };
  const r = await evaluateCondition(step, {}, d);
  assert.equal(r.result, true);
  assert.equal(calls, 3);
});

test("evaluateCondition: waitMs исчерпан - ложь; без waitMs - один опрос", async () => {
  let calls = 0;
  const d = deps({}, { probe: async () => ({ count: (calls++, 0) }) });
  const waiting = { logic: "all", tests: [{ ...defaultTest("element"), selector: ".never", waitMs: 1000 }] };
  assert.equal((await evaluateCondition(waiting, {}, d)).result, false);
  assert.ok(calls >= 2 && calls <= 6, "несколько опросов в пределах таймаута, было " + calls);
  calls = 0;
  const once = { logic: "all", tests: [{ ...defaultTest("element"), selector: ".never" }] };
  await evaluateCondition(once, {}, d);
  assert.equal(calls, 1);
});

test("evaluateCondition: ошибки конфигурации", async () => {
  await assert.rejects(() => evaluateCondition({ logic: "all", tests: [] }, {}, deps({})), /нет ни одной проверки/);
  await assert.rejects(
    () => evaluateCondition({ logic: "all", tests: [{ ...defaultTest("element"), selector: "" }] }, {}, deps({})),
    /не указан селектор/
  );
});

test("listSignature: меняется при изменении данных и порядка", () => {
  const a = listSignature([{ fio: "A" }, { fio: "B" }]);
  assert.equal(a, listSignature([{ fio: "A" }, { fio: "B" }]));
  assert.notEqual(a, listSignature([{ fio: "B" }, { fio: "A" }]));
  assert.notEqual(a, listSignature([{ fio: "A" }]));
  assert.match(a, /^2:[0-9a-f]+$/);
});

test("suggestVarName: транслит, уникальность, запасной вариант", () => {
  assert.equal(suggestVarName("ФИО", 0), "fio");
  assert.equal(suggestVarName("Номер полиса", 1), "nomer_polisa");
  assert.equal(suggestVarName("Щёлково", 2), "schelkovo");
  assert.equal(suggestVarName("ФИО", 3, ["fio"]), "fio_2");
  assert.equal(suggestVarName("", 4), "col5");
  assert.equal(suggestVarName("№", 5), "col6");
  assert.equal(suggestVarName("2024 год", 6), "col7_2024_god");
});

// ---------- MD-отчёт ----------
import { sanitizeReportName, appendBlock, toBase64Utf8, splitReport, partFileName } from "../logic.js";

test("sanitizeReportName: безопасное имя внутри Загрузок", () => {
  assert.equal(sanitizeReportName("report.md"), "report.md");
  assert.equal(sanitizeReportName("../../etc/passwd"), "etc/passwd.md");
  assert.equal(sanitizeReportName("C:\\Users\\x\\отчёт"), "C_/Users/x/отчёт.md");
  assert.equal(sanitizeReportName("  "), "report.md");
  assert.equal(sanitizeReportName("Проверка/2026-09-30 итог.md"), "Проверка/2026-09-30 итог.md");
  assert.equal(sanitizeReportName('a<b>:c?.md'), "a_b__c_.md");
});

test("appendBlock: блоки всегда с переводом строки", () => {
  assert.equal(appendBlock("", "a"), "a\n");
  assert.equal(appendBlock("a\n", "b"), "a\nb\n");
  assert.equal(appendBlock("a", "b\n"), "a\nb\n");
  assert.equal(appendBlock("x\n", undefined), "x\n\n");
});

test("toBase64Utf8: кириллица и большой текст", () => {
  assert.equal(Buffer.from(toBase64Utf8("Привет, ёж"), "base64").toString("utf8"), "Привет, ёж");
  const big = "я".repeat(300000);
  assert.equal(Buffer.from(toBase64Utf8(big), "base64").toString("utf8").length, 300000);
});

test("splitReport: режет по строкам, ничего не теряет, не превышает лимит", () => {
  const text = Array.from({ length: 50 }, (_, i) => `строка ${i} ${"я".repeat(20)}`).join("\n") + "\n";
  assert.deepEqual(splitReport(text, 1e9), [text]);
  const parts = splitReport(text, 300);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(""), text);
  for (const p of parts) assert.ok(new TextEncoder().encode(p).length <= 300);
});

test("partFileName", () => {
  assert.equal(partFileName("report.md", 0, 1), "report.md");
  assert.equal(partFileName("dir/report.md", 1, 3), "dir/report-2.md");
  assert.equal(partFileName("noext", 0, 2), "noext-1");
});


// ---------- конфиг ----------
import { buildConfig, stripTableData, parseImport, mergeConfig, importAsCopies, CONFIG_FORMAT } from "../logic.js";

const macroWithData = () => ({
  id: "m1", name: "Проверка", inputs: [], triggers: [],
  steps: [
    { id: "s1", type: "loadExcel", mode: "rows", fileName: "клиенты.xlsx", sheet: "Лист1", columns: [{ index: 0, header: "ФИО", varName: "fio" }],
      values: [], rows: [{ fio: "Тишин", _row: 2 }], truncated: false },
    { id: "s2", type: "loopList", steps: [
      { id: "s3", type: "condition", then: [{ id: "s4", type: "loadExcel", values: ["a", "b"], rows: [] }], else: [] },
    ] },
  ],
});

test("buildConfig: по умолчанию без данных таблицы (в т.ч. во вложенных шагах), исходник не меняется", () => {
  const src = macroWithData();
  const cfg = buildConfig([src]);
  assert.equal(cfg.format, CONFIG_FORMAT);
  assert.equal(cfg.includesTableData, false);
  assert.deepEqual(cfg.macros[0].steps[0].rows, []);
  assert.deepEqual(cfg.macros[0].steps[1].steps[0].then[0].values, []);
  assert.equal(cfg.macros[0].steps[0].columns[0].varName, "fio", "настройки остаются");
  assert.equal(cfg.macros[0].steps[0].fileName, "клиенты.xlsx");
  assert.equal(src.steps[0].rows.length, 1, "исходный макрос не тронут");
  const withData = buildConfig([src], { includeData: true });
  assert.equal(withData.macros[0].steps[0].rows.length, 1);
  assert.equal(withData.includesTableData, true);
});

test("parseImport: конфиг, старый экспорт (массив и одиночный), мусор", () => {
  assert.equal(parseImport(buildConfig([macroWithData()])).kind, "config");
  assert.equal(parseImport([macroWithData()]).kind, "macros");
  assert.equal(parseImport(macroWithData()).macros.length, 1);
  assert.equal(parseImport({ id: "x", steps: [] }).macros[0].name, "Без имени");
  assert.throws(() => parseImport({ format: CONFIG_FORMAT }), /нет списка/);
  assert.throws(() => parseImport([]), /нет макросов/);
  assert.throws(() => parseImport({ id: "x", steps: "oops" }), /не макрос/);
});

test("mergeConfig: замена по id, добавление новых, данные таблицы не теряются", () => {
  const existing = [macroWithData(), { id: "m2", name: "Другой", inputs: [], triggers: [], steps: [] }];
  const imported = parseImport(buildConfig([{ ...macroWithData(), name: "Проверка v2" }, { id: "m3", name: "Новый", steps: [] }])).macros;
  const { macros, added, replaced } = mergeConfig(existing, imported);
  assert.equal(added, 1);
  assert.equal(replaced, 1);
  assert.deepEqual(macros.map((m) => m.id), ["m1", "m2", "m3"]);
  assert.equal(macros[0].name, "Проверка v2");
  assert.deepEqual(macros[0].steps[0].rows, [{ fio: "Тишин", _row: 2 }], "данные восстановлены из текущего макроса");
  assert.deepEqual(macros[0].steps[1].steps[0].then[0].values, ["a", "b"]);
  // если в файле данные есть - берутся они
  const fresh = buildConfig([{ ...macroWithData(), steps: [{ ...macroWithData().steps[0], rows: [{ fio: "Новый", _row: 9 }] }] }], { includeData: true }).macros;
  assert.deepEqual(mergeConfig(existing, fresh).macros[0].steps[0].rows, [{ fio: "Новый", _row: 9 }]);
});

test("importAsCopies: новые id, старые не затираются", () => {
  const copies = importAsCopies([macroWithData()]);
  assert.notEqual(copies[0].id, "m1");
  assert.equal(copies[0].name, "Проверка");
});

test("compareText: операции над длиной (для условий внутри цикла)", () => {
  assert.equal(compareText("lenEq", " 25470CFI4440002174 ", "18"), true);
  assert.equal(compareText("lenNeq", "123", "18"), true);
  assert.equal(compareText("lenGt", "12345", "4"), true);
  assert.equal(compareText("lenLt", "123", "4"), true);
  assert.equal(compareText("lenGte", "1234", "4"), true);
  assert.equal(compareText("lenLte", "12345", "4"), false);
  assert.equal(compareText("lenEq", "abc", ""), false, "пустое число - не срабатывает");
  assert.equal(compareText("lenEq", "abc", "три"), false);
});
