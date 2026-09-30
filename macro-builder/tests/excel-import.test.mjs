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
