// Запуск: node --test macro-builder/tests/
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  columnLetter,
  decodeTextBytes,
  readWorkbook,
  sheetToRows,
  listColumns,
  findColumnIndex,
  extractColumn,
  MAX_VALUES,
  MAX_ROWS,
  sheetToGrid,
  gridNonBlankRows,
  extractRows,
} from "../excel-import.js";

const XLSX = createRequire(import.meta.url)("../vendor/xlsx.full.min.js");

const DATA = [
  ["Полис", "ФИО", "Телефон"],
  ["25470CFI4440002174", "Тишин Юрий Романович", "79054194015, 4194015"],
  ["25470CFI4440002995", "Шапарь Елена Ивановна", "79181658846"],
  ["", "", ""],
  ["25470CFI4440002174", "Дубль", " 79054194015 "],
];

function xlsxBuffer(aoa, sheetName = "Данные") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return out instanceof ArrayBuffer ? out : new Uint8Array(out).buffer;
}

// Кодирование в windows-1251 только для нужного здесь диапазона (А-я, Ё, ё и ASCII).
function toCp1251(str) {
  const bytes = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c >= 0x410 && c <= 0x44f) bytes.push(c - 0x410 + 0xc0);
    else if (c === 0x401) bytes.push(0xa8);
    else if (c === 0x451) bytes.push(0xb8);
    else throw new Error("нет в 1251: " + ch);
  }
  return new Uint8Array(bytes).buffer;
}

test("columnLetter", () => {
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
  assert.equal(columnLetter(27), "AB");
  assert.equal(columnLetter(701), "ZZ");
  assert.equal(columnLetter(702), "AAA");
});

test("xlsx: столбец по индексу, пустые ячейки пропускаются, пробелы по краям обрезаются", () => {
  const wb = readWorkbook(XLSX, xlsxBuffer(DATA), "book.xlsx");
  const rows = sheetToRows(XLSX, wb, wb.SheetNames[0]);
  const { values } = extractColumn(rows, { colIndex: 2, hasHeader: true });
  assert.deepEqual(values, ["79054194015, 4194015", "79181658846", "79054194015"]);
});

test("xlsx: unique и отсутствие заголовка", () => {
  const wb = readWorkbook(XLSX, xlsxBuffer(DATA), "book.xlsx");
  const rows = sheetToRows(XLSX, wb, wb.SheetNames[0]);
  const uniq = extractColumn(rows, { colIndex: 0, hasHeader: true, unique: true }).values;
  assert.deepEqual(uniq, ["25470CFI4440002174", "25470CFI4440002995"]);
  const noHeader = extractColumn(rows, { colIndex: 0, hasHeader: false }).values;
  assert.equal(noHeader[0], "Полис");
  assert.equal(noHeader.length, 4);
});

test("xlsx: skipEmpty выключен оставляет пустые ячейки, trim выключен - пробелы", () => {
  const wb = readWorkbook(XLSX, xlsxBuffer(DATA), "book.xlsx");
  const rows = sheetToRows(XLSX, wb, wb.SheetNames[0]);
  const raw = extractColumn(rows, { colIndex: 2, hasHeader: true, skipEmpty: false, trim: false }).values;
  assert.deepEqual(raw, ["79054194015, 4194015", "79181658846", "", " 79054194015 "]);
});

test("xlsx: числа читаются как показано в Excel, длинные номера не переходят в экспоненту", () => {
  const wb = readWorkbook(XLSX, xlsxBuffer([["Тел"], [79054194015], [1.5]]), "n.xlsx");
  const rows = sheetToRows(XLSX, wb, wb.SheetNames[0]);
  assert.deepEqual(extractColumn(rows, { colIndex: 0 }).values, ["79054194015", "1.5"]);
});

test("listColumns: подписи с буквой и заголовком, столбцы без заголовка", () => {
  const cols = listColumns([["Полис", "", "Телефон"], ["1", "2", "3", "4"]], true);
  assert.deepEqual(cols.map((c) => c.label), ["A — Полис", "B (без заголовка)", "C — Телефон", "D (без заголовка)"]);
  assert.equal(listColumns([["x"]], false)[0].label, "A (без заголовка)");
});

test("findColumnIndex: по заголовку при смене порядка, иначе по номеру, иначе 0", () => {
  const rows = [["Телефон", "Полис"], ["1", "2"]];
  assert.equal(findColumnIndex(rows, { hasHeader: true, colLabel: "полис ", colIndex: 0 }), 1);
  assert.equal(findColumnIndex(rows, { hasHeader: true, colLabel: "нет такого", colIndex: 1 }), 1);
  assert.equal(findColumnIndex(rows, { hasHeader: true, colLabel: "", colIndex: 9 }), 0);
  assert.equal(findColumnIndex([], { hasHeader: true, colLabel: "", colIndex: 3 }), 0);
});

test("csv UTF-8 с BOM и разделителем ;", () => {
  const text = "﻿Полис;ФИО\r\n007;Тишин\r\n008;Шапарь\r\n";
  const buf = new TextEncoder().encode(text).buffer;
  const wb = readWorkbook(XLSX, buf, "выгрузка.csv");
  const rows = sheetToRows(XLSX, wb, wb.SheetNames[0]);
  assert.deepEqual(rows[0], ["Полис", "ФИО"]);
  assert.deepEqual(extractColumn(rows, { colIndex: 0 }).values, ["007", "008"]); // ведущие нули сохранены
  assert.deepEqual(extractColumn(rows, { colIndex: 1 }).values, ["Тишин", "Шапарь"]);
});

test("csv windows-1251 (типичная выгрузка из русского Excel)", () => {
  const buf = toCp1251("Полис;ФИО\r\n1;Тишин Юрий Романович\r\n2;Ёлкина Ёлка\r\n");
  assert.equal(decodeTextBytes(new Uint8Array(buf)).startsWith("Полис;ФИО"), true);
  const wb = readWorkbook(XLSX, buf, "old.CSV");
  const rows = sheetToRows(XLSX, wb, wb.SheetNames[0]);
  assert.deepEqual(extractColumn(rows, { colIndex: 1 }).values, ["Тишин Юрий Романович", "Ёлкина Ёлка"]);
});

test("csv с запятой и значениями в кавычках, содержащими запятую", () => {
  const buf = new TextEncoder().encode('a,b\n1,"79054194015, 4194015"\n').buffer;
  const wb = readWorkbook(XLSX, buf, "x.csv");
  const rows = sheetToRows(XLSX, wb, wb.SheetNames[0]);
  assert.deepEqual(extractColumn(rows, { colIndex: 1 }).values, ["79054194015, 4194015"]);
});

test("несколько листов: sheetToRows берёт нужный лист", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["A"], ["1"]]), "Первый");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["B"], ["2"], ["3"]]), "Второй");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const back = readWorkbook(XLSX, buf, "m.xlsx");
  assert.deepEqual(back.SheetNames, ["Первый", "Второй"]);
  assert.deepEqual(extractColumn(sheetToRows(XLSX, back, "Второй"), { colIndex: 0 }).values, ["2", "3"]);
  assert.deepEqual(sheetToRows(XLSX, back, "Нет такого"), []);
});

test("лимит значений: обрезает и сообщает об этом", () => {
  const rows = [["h"]];
  for (let i = 0; i < MAX_VALUES + 5; i++) rows.push([String(i)]);
  const { values, truncated } = extractColumn(rows, { colIndex: 0 });
  assert.equal(values.length, MAX_VALUES);
  assert.equal(truncated, true);
});

test("readWorkbook без библиотеки даёт понятную ошибку", () => {
  assert.throws(() => readWorkbook(undefined, new ArrayBuffer(0), "a.xlsx"), /Библиотека/);
});

// ---------- режим «строки» ----------

function gridOf(aoa, startRowPadding = 0) {
  const padded = Array.from({ length: startRowPadding }, () => []).concat(aoa);
  const wb = readWorkbook(XLSX, xlsxBuffer(padded), "g.xlsx");
  return sheetToGrid(XLSX, wb, wb.SheetNames[0]);
}

test("extractRows: несколько столбцов, настоящие номера строк Excel", () => {
  const grid = gridOf(DATA); // заголовок - строка 1, пустая строка - 4
  const cols = [{ index: 1, varName: "fio" }, { index: 0, varName: "policy" }];
  const { rows } = extractRows(grid, { columns: cols });
  assert.deepEqual(rows, [
    { fio: "Тишин Юрий Романович", policy: "25470CFI4440002174", _row: 2 },
    { fio: "Шапарь Елена Ивановна", policy: "25470CFI4440002995", _row: 3 },
    { fio: "Дубль", policy: "25470CFI4440002174", _row: 5 },
  ]);
});

test("extractRows: пустые строки пропускаются, номера строк не «съезжают»", () => {
  const grid = gridOf([["h1", "h2"], ["a", "1"], ["", ""], ["", ""], ["b", "2"]]);
  const { rows } = extractRows(grid, { columns: [{ index: 0, varName: "x" }] });
  assert.deepEqual(rows.map((r) => [r.x, r._row]), [["a", 2], ["b", 5]]);
});

test("extractRows: без заголовка, unique по всем выбранным столбцам, skipEmpty", () => {
  const grid = gridOf([["a", "1"], ["a", "1"], ["a", "2"], ["", "3"]]);
  const cols = [{ index: 0, varName: "x" }, { index: 1, varName: "y" }];
  assert.equal(extractRows(grid, { columns: cols, hasHeader: false }).rows.length, 4);
  assert.equal(extractRows(grid, { columns: cols, hasHeader: false, unique: true }).rows.length, 3);
  // строка считается пустой, только если пусты ВСЕ выбранные столбцы
  const onlyX = extractRows(grid, { columns: [{ index: 0, varName: "x" }], hasHeader: false });
  assert.equal(onlyX.rows.length, 3);
});

test("extractRows: лист начинается не с первой строки - номера всё равно настоящие", () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([["Полис"], ["A1"], ["A2"]]);
  XLSX.utils.sheet_add_aoa(ws, [["Полис"], ["A1"], ["A2"]], { origin: "A4" }); // данные с 4-й строки
  delete ws.A1; delete ws.A2; delete ws.A3;
  ws["!ref"] = "A4:A6";
  XLSX.utils.book_append_sheet(wb, ws, "S");
  const grid = sheetToGrid(XLSX, readWorkbook(XLSX, XLSX.write(wb, { type: "array", bookType: "xlsx" }), "s.xlsx"), "S");
  assert.equal(grid.firstRow, 4);
  const { rows } = extractRows(grid, { columns: [{ index: 0, varName: "p" }] });
  assert.deepEqual(rows.map((r) => [r.p, r._row]), [["A1", 5], ["A2", 6]]);
});

test("extractRows: лимит строк и пустой лист", () => {
  const aoa = [["h"]];
  for (let i = 0; i < MAX_ROWS + 3; i++) aoa.push([String(i + 1)]);
  const r = extractRows(gridOf(aoa), { columns: [{ index: 0, varName: "x" }] });
  assert.equal(r.rows.length, MAX_ROWS);
  assert.equal(r.truncated, true);
  assert.deepEqual(sheetToGrid(XLSX, { Sheets: {} }, "нет"), { rows: [], firstRow: 1 });
});

test("gridNonBlankRows + listColumns: заголовок - первая непустая строка", () => {
  const grid = gridOf([["Полис", "ФИО"], ["1", "a"]], 2); // две пустые строки сверху
  const rows = gridNonBlankRows(grid);
  assert.deepEqual(listColumns(rows, true).map((c) => c.header), ["Полис", "ФИО"]);
});

// ---------- пропуск по длине значения ----------
import { valueLength, lengthRuleMatches, LENGTH_OPS } from "../excel-import.js";

test("valueLength: символы, только цифры, без пробелов, эмодзи как один символ", () => {
  assert.equal(valueLength("25470CFI4440002174"), 18);
  assert.equal(valueLength("+7 (905) 419-40-15", "digits"), 11);
  assert.equal(valueLength(" a b ", "nospace"), 2);
  assert.equal(valueLength("😀a"), 2);
  assert.equal(valueLength(null), 0);
});

test("lengthRuleMatches: все операции, пустое n не действует", () => {
  const m = (op, n, v) => lengthRuleMatches({ op, n, count: "chars" }, v);
  assert.equal(m("neq", 5, "abcd"), true);
  assert.equal(m("neq", 5, "abcde"), false);
  assert.equal(m("eq", 5, "abcde"), true);
  assert.equal(m("gt", 5, "abcdef"), true);
  assert.equal(m("gt", 5, "abcde"), false);
  assert.equal(m("gte", 5, "abcde"), true);
  assert.equal(m("lt", 5, "abcd"), true);
  assert.equal(m("lte", 5, "abcde"), true);
  assert.equal(m("neq", "", "abcd"), false);
  assert.equal(m("neq", "abc", "abcd"), false);
  assert.equal(m("wat", 5, "abcd"), false);
  assert.deepEqual(Object.keys(LENGTH_OPS).sort(), ["eq", "gt", "gte", "lt", "lte", "neq"]);
});

test("extractColumn: пропуск по длине + счётчик skipped", () => {
  const rows = [["Полис"], ["25470CFI4440002174"], ["123"], ["25470CFI44400021740"], ["25470CFI4440002995"]];
  const r = extractColumn(rows, { colIndex: 0, lengthRules: [{ op: "neq", n: 18, count: "chars" }] });
  assert.deepEqual(r.values, ["25470CFI4440002174", "25470CFI4440002995"]);
  assert.equal(r.skipped, 2);
  const two = extractColumn(rows, { colIndex: 0, lengthRules: [{ op: "lt", n: 10 }, { op: "gt", n: 18 }] });
  assert.equal(two.values.length, 2);
  assert.equal(two.skipped, 2);
});

test("extractRows: правило привязано к столбцу по имени переменной, номера строк сохраняются", () => {
  const grid = gridOf([
    ["Полис", "Телефон"],
    ["25470CFI4440002174", "+7 (905) 419-40-15"],
    ["короткий", "+7 (918) 165-88-46"],
    ["25470CFI4440002995", "12345"],
  ]);
  const cols = [{ index: 0, varName: "policy" }, { index: 1, varName: "phone" }];
  const r = extractRows(grid, {
    columns: cols,
    lengthRules: [
      { col: "policy", op: "neq", n: 18, count: "chars" },
      { col: "phone", op: "neq", n: 11, count: "digits" },
    ],
  });
  assert.deepEqual(r.rows.map((x) => x._row), [2]);
  assert.equal(r.skipped, 2);
  // правило на несуществующий столбец не действует и не падает
  const ghost = extractRows(grid, { columns: cols, lengthRules: [{ col: "nope", op: "gt", n: 0 }] });
  assert.equal(ghost.rows.length, 3);
  assert.equal(ghost.skipped, 0);
});
