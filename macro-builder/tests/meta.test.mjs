// Запуск: node --test macro-builder/tests/meta.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { defaultStep, defaultTest } from "../common.js";
import {
  describeStep, validateStep, validateMacro, collectVars, formatDuration, truncate, pluralRu, STEP_META, PALETTE, stepTitle,
} from "../ui/meta.js";
import { STEP_LABELS } from "../common.js";

const st = (type, over = {}) => ({ ...defaultStep(type), ...over });

test("палитра: каждый шаг описан, есть в палитре ровно один раз, у всех есть название", () => {
  const inPalette = PALETTE.flatMap((g) => g.types);
  assert.equal(new Set(inPalette).size, inPalette.length, "без повторов");
  for (const type of Object.keys(STEP_LABELS)) {
    assert.ok(STEP_META[type], "нет меты для " + type);
    assert.ok(inPalette.includes(type), "нет в палитре: " + type);
    assert.ok(stepTitle(type).length > 2);
  }
  assert.deepEqual([...inPalette].sort(), Object.keys(STEP_META).sort());
});

test("formatDuration / truncate / pluralRu", () => {
  assert.equal(formatDuration(500), "500 мс");
  assert.equal(formatDuration(2000), "2 с");
  assert.equal(formatDuration(1500), "1,5 с");
  assert.equal(truncate("  a   b  ", 10), "a b");
  assert.equal(truncate("x".repeat(100), 10).length, 10);
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25].map((n) => pluralRu(n, "строка", "строки", "строк")), ["строка", "строки", "строк", "строк", "строка", "строки", "строк"]);
});

test("describeStep: основные шаги читаются как короткая фраза", () => {
  assert.equal(describeStep(st("navigate", { url: "https://example.com/search" })), "https://example.com/search");
  assert.equal(describeStep(st("wait", { ms: 2000 })), "2 с");
  assert.equal(describeStep(st("click", { selector: ".dots", scopeSelector: "tr", scopeText: "${fio}" })), ".dots · в строке «${fio}»");
  assert.equal(describeStep(st("type", { selector: "#q", value: "${fio}", pressEnter: true })), "#q ← ${fio} ⏎");
  assert.equal(describeStep(st("clearField", { selector: "#q", scopeSelector: "tr", scopeText: "${fio}" })), "#q · в строке «${fio}»");
  assert.equal(describeStep(st("extract", { selector: ".holder", varName: "holder", multiple: true })), ".holder → holder (список)");
  assert.equal(describeStep(st("setVar", { varName: "n", mode: "increment", value: "" })), "n += 1");
  assert.equal(describeStep(st("setVar", { varName: "status", value: "OK" })), "status = OK");
  assert.equal(describeStep(st("appendReport", { filename: "r.md" })), "→ r.md");
  assert.equal(describeStep(st("switchTab", { source: "popup" })), "открытую страницей");
  assert.equal(describeStep(st("customJs", { code: "// комментарий\nreturn 1;" })), "return 1;");
});

test("describeStep: данные Excel и цикл", () => {
  assert.equal(describeStep(st("loadExcel")), "файл не выбран");
  assert.equal(describeStep(st("loadExcel", { mode: "rows", rows: [{}, {}], columns: [{ varName: "fio" }, { varName: "polis" }], skipped: 2 })), "2 строки · fio, polis · пропущено 2");
  assert.equal(describeStep(st("loadExcel", { values: ["a"], colLabel: "Полис" })), "1 значение · Полис");
  assert.equal(describeStep(st("loadExcel", { skipped: 3 })), "всё отсеяно правилами пропуска");
  assert.equal(describeStep(st("loopList", { sourceKey: "rows", limit: 5, onRowError: "continue", resume: true })), "по rows · не больше 5 · ошибки не останавливают · с продолжением");
});

test("describeStep: условие читается как предложение, И/ИЛИ, НЕ", () => {
  const cond = st("condition", {
    logic: "any",
    tests: [
      { ...defaultTest("elementText"), selector: ".res .fio", op: "containsWords", value: "${fio}" },
      { ...defaultTest("element"), selector: ".ok", negate: true },
      { ...defaultTest("var"), left: "${a}", op: "lenGt", right: "10" },
    ],
  });
  assert.equal(describeStep(cond), "текст .res .fio содержит слова ${fio} ИЛИ .ok нет на странице ИЛИ ${a} длина > 10");
  // старое условие тоже описывается
  assert.equal(describeStep({ type: "condition", selector: "#q", mode: "notExists" }), "#q нет на странице");
});

test("validateStep: пустые шаги дают понятные замечания, заполненные - нет", () => {
  assert.deepEqual(validateStep(st("click")), ["Укажите элемент на странице"]);
  assert.deepEqual(validateStep(st("clearField")), ["Укажите элемент на странице"]);
  assert.deepEqual(validateStep(st("clearField", { selector: "#q" })), []);
  assert.deepEqual(validateStep(st("click", { selector: ".x" })), []);
  assert.deepEqual(validateStep(st("navigate")), ["Укажите адрес страницы"]);
  assert.deepEqual(validateStep(st("navigate", { url: "https://a.ru" })), []);
  assert.deepEqual(validateStep(st("appendReport")), ["Введите, что записывать в отчёт"]);
  assert.deepEqual(validateStep(st("loadExcel")), ["Выберите файл Excel или CSV"]);
  assert.deepEqual(validateStep(st("loadExcel", { mode: "rows", rows: [{}] })), ["Отметьте хотя бы один столбец"]);
  assert.match(validateStep(st("loadExcel", { mode: "rows", rows: [{}], columns: [{ varName: "1bad" }] }))[0], /латиница/);
  assert.match(validateStep(st("loadExcel", { mode: "rows", rows: [{}], columns: [{ varName: "a" }, { varName: "a" }] }))[0], /без повторов/);
  assert.deepEqual(validateStep(st("loadExcel", { mode: "rows", rows: [{ a: 1 }], columns: [{ varName: "a" }] })), []);
  assert.deepEqual(validateStep(st("loadExcel", { skipped: 4 })), ["Все записи отсеяны правилами пропуска"]);
  assert.deepEqual(validateStep(st("loopList")), ["Выберите, по чему повторять", "Добавьте шаги внутрь цикла"]);
  assert.deepEqual(validateStep(st("switchTab")), []);
  assert.deepEqual(validateStep(st("switchTab", { source: "href" })), ["Укажите элемент со ссылкой"]);
  assert.deepEqual(validateStep(st("customJs")), ["Введите код"]);
  assert.deepEqual(validateStep(st("wait")), []);
  assert.deepEqual(validateStep(st("closeTab")), []);
});

test("validateStep: условие - селектор и значение для каждой проверки", () => {
  const cond = st("condition", {
    tests: [
      { ...defaultTest("elementText"), selector: "", op: "contains", value: "" },
      { ...defaultTest("elementText"), selector: ".x", op: "notEmpty", value: "" },
      { ...defaultTest("var"), left: "", right: "" },
    ],
  });
  assert.deepEqual(validateStep(cond), [
    "Укажите элемент на странице (проверка 1)",
    "Укажите, с чем сравнивать (проверка 1)",
    "Заполните значения для сравнения (проверка 3)",
  ]);
  assert.deepEqual(validateStep(st("condition", { tests: [] })), ["Добавьте хотя бы одну проверку"]);
});

test("validateMacro: обходит вложенные шаги и указывает путь", () => {
  const macro = {
    inputs: [{ key: "rows", multiline: true }],
    steps: [
      st("navigate", { url: "https://a.ru" }),
      st("loopList", {
        sourceKey: "rows",
        steps: [st("click", { selector: ".ok" }), st("condition", { then: [st("click")], else: [], tests: [{ ...defaultTest("element"), selector: ".x" }] })],
      }),
    ],
  };
  const issues = validateMacro(macro);
  // цикл (2) -> условие (2.2) -> первый шаг ветки «то» (2.2.1) без селектора
  assert.deepEqual(issues.map((i) => [i.path, i.message]), [["2.2.1", "Укажите элемент на странице"]]);
});

test("collectVars: все переменные и отдельно списки для цикла", () => {
  const macro = {
    inputs: [{ key: "phones", multiline: true }, { key: "name", multiline: false }],
    steps: [
      st("loadExcel", { mode: "rows", varName: "rows", columns: [{ varName: "fio" }, { varName: "polis" }] }),
      st("loopList", { sourceKey: "rows", itemVar: "item", steps: [
        st("extract", { varName: "holder" }),
        st("extract", { varName: "all_names", multiple: true }),
        st("setVar", { varName: "verdict" }),
        st("customJs", { saveTo: "digits" }),
      ] }),
    ],
  };
  const v = collectVars(macro);
  for (const n of ["fio", "polis", "rows", "item", "holder", "verdict", "digits", "phones", "name", "_row", "_error", "all_names"]) assert.ok(v.all.includes(n), n);
  assert.deepEqual([...v.lists].sort(), ["all_names", "phones", "rows"]);
});

import { collectValueSources, scopeIssues, buildSampleVars, describeSampleVars } from "../ui/meta.js";

test("collectValueSources: столбцы таблицы с заголовками идут первыми, дальше цикл, переменные, служебные", () => {
  const macro = {
    inputs: [{ key: "phones", multiline: true }],
    steps: [
      st("loadExcel", { mode: "rows", varName: "rows", columns: [{ varName: "fio", header: "ФИО" }, { varName: "polis", header: "Номер полиса" }] }),
      st("loopList", { sourceKey: "rows", itemVar: "item", steps: [st("extract", { varName: "holder" }), st("setVar", { varName: "verdict" })] }),
    ],
  };
  const groups = collectValueSources(macro);
  // цикл по строкам таблицы: «текущая запись» - целая строка, в списке значений её нет, есть только столбцы
  assert.deepEqual(groups.map((g) => g.label), ["Столбцы таблицы", "Другие переменные", "Служебные"]);
  assert.deepEqual(groups[0].items, [
    { value: "${fio}", label: "ФИО  (fio)" },
    { value: "${polis}", label: "Номер полиса  (polis)" },
  ]);
  assert.deepEqual(groups[1].items.map((i) => i.value), ["${phones}", "${holder}", "${verdict}"]);
  assert.ok(groups[2].items.some((i) => i.value === "${_row}"));
  // повторов нет, у каждого значения формат ${имя}
  const all = groups.flatMap((g) => g.items.map((i) => i.value));
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.every((v) => /^\$\{[A-Za-z_]\w*\}$/.test(v)));
});

test("collectValueSources: без таблицы нет группы «Столбцы таблицы»; столбцы без заголовка подписаны именем переменной", () => {
  assert.deepEqual(collectValueSources({ steps: [] }).map((g) => g.label), ["Служебные"]);
  const g = collectValueSources({ steps: [st("loadExcel", { mode: "rows", columns: [{ varName: "col1", header: "" }] })] });
  assert.equal(g[0].items[0].label, "col1");
  // режим «один столбец» столбцов-переменных не даёт
  assert.equal(collectValueSources({ steps: [st("loadExcel", { mode: "column" })] })[0].label, "Служебные");
});

test("collectValueSources: у цикла по одному столбцу есть «Текущая запись цикла»", () => {
  const macro = {
    steps: [
      st("loadExcel", { mode: "column", varName: "list", values: ["a"] }),
      st("loopList", { sourceKey: "list", itemVar: "item", steps: [] }),
    ],
  };
  const groups = collectValueSources(macro);
  assert.deepEqual(groups.map((g) => g.label), ["Цикл", "Служебные"]);
  assert.deepEqual(groups[0].items.map((i) => i.value), ["${item}"]);
});

// ---------------- где доступны переменные ----------------

const tableStep = () =>
  st("loadExcel", { mode: "rows", varName: "rows", columns: [{ varName: "fio" }, { varName: "polis" }], rows: [{ fio: "Иванов И. И.", polis: "111", _row: 2 }, { fio: "Петров", polis: "222", _row: 3 }] });
const typeFio = () => st("type", { selector: "#q", value: "${fio}" });

test("scopeIssues: столбец таблицы вне цикла - предупреждение, внутри цикла - нет", () => {
  const outside = { steps: [tableStep(), typeFio(), st("loopList", { sourceKey: "rows", steps: [typeFio()] })] };
  const issues = scopeIssues(outside);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, "2");
  assert.match(issues[0].message, /\$\{fio\}.*только внутри шага «Для каждой записи»/);
  // validateMacro включает эти предупреждения
  assert.ok(validateMacro(outside).some((i) => i.path === "2" && /fio/.test(i.message)));
});

test("scopeIssues: цикл по списку, которого нет выше, и незаданная переменная", () => {
  const macro = { steps: [st("loopList", { sourceKey: "rows", steps: [st("click", { selector: ".x" })] }), tableStep()] };
  const issues = scopeIssues(macro);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Список «rows» не найден до этого шага/);
  const unset = scopeIssues({ steps: [st("type", { selector: "#q", value: "${nothing}" })] });
  assert.match(unset[0].message, /\$\{nothing\} здесь ещё не задана/);
});

test("scopeIssues: не ругается на допустимое (параметры, встроенные, setVar/extract выше, поля записи, ветки условий, catchSteps)", () => {
  const macro = {
    inputs: [{ key: "phones", multiline: true }, { key: "who" }],
    steps: [
      tableStep(),
      st("setVar", { varName: "n", value: "1" }),
      st("type", { selector: "#q", value: "${who} ${n} ${_date}" }),
      st("loopList", {
        sourceKey: "rows",
        catchSteps: [st("appendReport", { template: "ошибка ${_error} ${fio}" })],
        steps: [
          st("extract", { selector: ".r", varName: "holder" }),
          st("condition", { tests: [{ ...defaultTest("var"), left: "${holder}", right: "${fio}" }], then: [st("type", { selector: "#q", value: "${polis} ${_row} ${_index}" })], else: [] }),
        ],
      }),
      st("loopList", { sourceKey: "phones", steps: [st("type", { selector: "#q", value: "${anything_from_list}" })] }),
    ],
  };
  assert.deepEqual(scopeIssues(macro), []);
});

test("buildSampleVars: первая запись таблицы, значение столбца и параметры по умолчанию", () => {
  const macro = {
    inputs: [{ key: "who", default: "я" }],
    steps: [
      tableStep(),
      st("loadExcel", { mode: "column", varName: "phones", values: ["79054194015", "79181658846"] }),
      st("loopList", { sourceKey: "phones", itemVar: "phone", steps: [] }),
    ],
  };
  const v = buildSampleVars(macro);
  assert.equal(v.fio, "Иванов И. И.");
  assert.equal(v.polis, "111");
  assert.equal(v._row, 2);
  assert.equal(v.phone, "79054194015");
  assert.equal(v.who, "я");
  assert.equal(v._index, 1);
  assert.deepEqual(buildSampleVars({ steps: [] }), {});
  // без цикла значение одного столбца доступно как item
  assert.equal(buildSampleVars({ steps: [st("loadExcel", { mode: "column", varName: "l", values: ["x"] })] }).item, "x");
  assert.match(describeSampleVars(macro), /fio = «Иванов И\. И\.»; polis = «111»; phones \(первое значение\) = «79054194015»/);
  assert.equal(describeSampleVars({ steps: [] }), "");
});
