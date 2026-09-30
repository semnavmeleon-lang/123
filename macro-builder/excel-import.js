// Чтение Excel/CSV и извлечение одного столбца. Чистые функции без DOM и chrome.*:
// XLSX (SheetJS) передаётся снаружи, поэтому модуль одинаково работает в конструкторе
// (vendor/xlsx.full.min.js) и в тестах под Node.

// Предел значений, которые сохраняются внутри шага: они лежат в chrome.storage.local
// вместе с самим макросом, а квота там ограничена.
export const MAX_VALUES = 50000;

// 0 -> A, 25 -> Z, 26 -> AA
export function columnLetter(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// CSV из русского Excel обычно в windows-1251 (или UTF-8 с BOM) - пробуем UTF-8
// строго и только при ошибке декодирования падаем на 1251, иначе кириллица превращается в мусор.
export function decodeTextBytes(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch (e) {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

export function readWorkbook(XLSX, buffer, fileName) {
  if (!XLSX) throw new Error("Библиотека чтения Excel не загружена");
  if (/\.(csv|tsv|txt)$/i.test(fileName || "")) {
    // raw:true - ячейки остаются текстом ("007" не превращается в 7), разделитель SheetJS определяет сам
    return XLSX.read(decodeTextBytes(new Uint8Array(buffer)), { type: "string", raw: true });
  }
  return XLSX.read(buffer, { type: "array" });
}

// Лист -> массив строк-массивов со значениями в том виде, как их видно в Excel (форматированный текст).
export function sheetToRows(XLSX, workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return [];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: false });
  return aoa.map((row) => row.map((v) => (v == null ? "" : String(v))));
}

function width(rows) {
  let w = 0;
  for (const r of rows) if (r.length > w) w = r.length;
  return w;
}

// [{ index, letter, header, label }] - label для выпадающего списка: "B — Телефон".
export function listColumns(rows, hasHeader) {
  const headers = hasHeader && rows.length ? rows[0] : [];
  const cols = [];
  for (let i = 0; i < width(rows); i++) {
    const header = String(headers[i] ?? "").trim();
    const letter = columnLetter(i);
    cols.push({ index: i, letter, header, label: header ? `${letter} — ${header}` : `${letter} (без заголовка)` });
  }
  return cols;
}

// При повторной загрузке файла ищем столбец сначала по заголовку (порядок столбцов
// в свежей выгрузке мог поменяться), потом по прежнему номеру, иначе берём первый.
export function findColumnIndex(rows, { hasHeader, colLabel, colIndex }) {
  const cols = listColumns(rows, hasHeader);
  if (!cols.length) return 0;
  const want = String(colLabel || "").trim().toLowerCase();
  if (want) {
    const byHeader = cols.find((c) => c.header.toLowerCase() === want);
    if (byHeader) return byHeader.index;
  }
  const idx = Number(colIndex);
  return Number.isInteger(idx) && idx >= 0 && idx < cols.length ? idx : 0;
}

export function extractColumn(rows, { colIndex = 0, hasHeader = true, trim = true, skipEmpty = true, unique = false } = {}) {
  const out = [];
  const seen = new Set();
  let truncated = false;
  for (let r = hasHeader ? 1 : 0; r < rows.length; r++) {
    let v = String(rows[r][colIndex] ?? "");
    if (trim) v = v.trim();
    if (skipEmpty && v.trim() === "") continue;
    if (unique) {
      if (seen.has(v)) continue;
      seen.add(v);
    }
    if (out.length >= MAX_VALUES) {
      truncated = true;
      break;
    }
    out.push(v);
  }
  return { values: out, truncated };
}
