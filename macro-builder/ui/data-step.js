// Редактор шага «Данные из Excel/CSV»: выбор файла, предпросмотр таблицы, выбор столбцов кликом
// по заголовку, правила пропуска строк. Разобранные книги живут только в памяти страницы
// (step.id -> книга); в макросе хранится снимок данных (values / rows).

import { h, field, textInput, selectInput, checkbox, segmented, disclosure, button, iconButton } from "./dom.js";
import { suggestVarName } from "../logic.js";
import { pluralRu } from "./meta.js";
import {
  MAX_VALUES,
  MAX_ROWS,
  readWorkbook,
  sheetToRows,
  sheetToGrid,
  listColumns,
  findColumnIndex,
  extractColumn,
  extractRows,
  lengthRuleMatches,
  LENGTH_OPS,
  LENGTH_COUNT,
} from "../excel-import.js";

const cache = new Map(); // step.id -> { wb, rows: Map, grids: Map }
const PREVIEW_ROWS = 8;
const VAR_RE = /^[A-Za-z_]\w*$/;

const XLSX = () => globalThis.XLSX;

function rowsOf(c, sheet) {
  if (!c.rows.has(sheet)) c.rows.set(sheet, sheetToRows(XLSX(), c.wb, sheet));
  return c.rows.get(sheet);
}
function gridOf(c, sheet) {
  if (!c.grids.has(sheet)) c.grids.set(sheet, sheetToGrid(XLSX(), c.wb, sheet));
  return c.grids.get(sheet);
}

function makeColumn(col, used) {
  return { index: col.index, header: col.header, varName: suggestVarName(col.header || col.letter, col.index, used) };
}

// Пересчитывает данные шага из книги и настроек (режим, столбцы, правила).
export function recompute(step) {
  const c = cache.get(step.id);
  if (!c) return;
  const cols = listColumns(rowsOf(c, step.sheet), step.hasHeader);
  if (step.mode === "rows") {
    step.columns = (step.columns || []).filter((x) => x.index < cols.length).map((x) => ({ ...x, header: cols[x.index].header }));
    const r = extractRows(gridOf(c, step.sheet), step);
    step.rows = r.rows;
    step.truncated = r.truncated;
    step.skipped = r.skipped;
    return;
  }
  const col = cols[step.colIndex] || cols[0];
  step.colIndex = col ? col.index : 0;
  step.colLabel = col ? col.header : "";
  const r = extractColumn(rowsOf(c, step.sheet), step);
  step.values = r.values;
  step.truncated = r.truncated;
  step.skipped = r.skipped;
}

// При смене листа/файла столбцы подхватываются по заголовку (порядок в свежей выгрузке мог поменяться).
function remapColumns(step, cols) {
  const byHeader = (name) => name && cols.find((x) => x.header.toLowerCase() === name.toLowerCase());
  if (step.mode === "rows") {
    step.columns = (step.columns || [])
      .map((c) => {
        const found = byHeader(c.header);
        return { ...c, index: found ? found.index : c.index };
      })
      .filter((c) => c.index < cols.length);
    if (!step.columns.length && cols.length) step.columns = [makeColumn(cols[Math.min(step.colIndex || 0, cols.length - 1)], [])];
  }
}

async function loadFile(step, file, api) {
  try {
    const wb = readWorkbook(XLSX(), await file.arrayBuffer(), file.name);
    if (!wb.SheetNames.length) throw new Error("в файле нет листов");
    const c = { wb, rows: new Map(), grids: new Map() };
    cache.set(step.id, c);
    step.sheet = wb.SheetNames.includes(step.sheet) ? step.sheet : wb.SheetNames[0];
    step.fileName = file.name;
    const rows = rowsOf(c, step.sheet);
    const cols = listColumns(rows, step.hasHeader);
    if (step.mode === "rows") remapColumns(step, cols);
    else step.colIndex = findColumnIndex(rows, step);
    recompute(step);
    api.save();
    api.rerender();
  } catch (e) {
    api.toast("Не удалось прочитать файл: " + e.message, "error");
  }
}

// Модель предпросмотра: заголовки и первые строки с пометкой «будет пропущена»
function previewModel(step, c) {
  const rowsMode = step.mode === "rows";
  const grid = gridOf(c, step.sheet);
  const nonBlank = [];
  grid.rows.forEach((r, i) => {
    if (r.some((v) => String(v).trim() !== "")) nonBlank.push({ cells: r, rowNum: grid.firstRow + i });
  });
  const cols = listColumns(nonBlank.map((x) => x.cells), step.hasHeader);
  const data = (step.hasHeader ? nonBlank.slice(1) : nonBlank).slice(0, PREVIEW_ROWS);
  const selected = rowsMode ? (step.columns || []).map((x) => x.index) : [step.colIndex];
  const nameOf = (varName) => (step.columns || []).find((x) => x.varName === varName);
  const rows = data.map((r) => {
    const vals = (i) => String(r.cells[i] ?? "").trim();
    let skipped = false;
    if (step.skipEmpty && selected.every((i) => vals(i) === "")) skipped = true;
    for (const rule of step.lengthRules || []) {
      const idx = rowsMode ? (nameOf(rule.col) || {}).index : step.colIndex;
      if (idx != null && lengthRuleMatches(rule, step.trim ? vals(idx) : String(r.cells[idx] ?? ""))) skipped = true;
    }
    return { rowNum: r.rowNum, cells: r.cells, skipped };
  });
  return { cols, rows, selected, total: nonBlank.length - (step.hasHeader ? 1 : 0) };
}

function previewTable(step, c, api) {
  const rowsMode = step.mode === "rows";
  const m = previewModel(step, c);
  const head = h("tr", {}, h("th", { class: "rownum" }, "№"));
  for (const col of m.cols) {
    const on = m.selected.includes(col.index);
    const picked = rowsMode ? (step.columns || []).find((x) => x.index === col.index) : null;
    const th = h("th", { class: "pickable" + (on ? " on" : ""), title: rowsMode ? "Нажмите, чтобы добавить или убрать столбец" : "Нажмите, чтобы выбрать столбец" });
    const name = h("div", { class: "name" });
    if (rowsMode) {
      const cb = h("input", { type: "checkbox" });
      cb.checked = on;
      cb.tabIndex = -1;
      name.append(cb);
    }
    name.append(h("span", {}, `${col.letter} · ${col.header || "без заголовка"}`));
    const box = h("div", { class: "col-head" }, name);
    if (picked) {
      const vn = textInput({ value: picked.varName, placeholder: "переменная", mono: true, tip: "Имя переменной: в шагах доступно как ${имя}" });
      vn.classList.toggle("invalid", !VAR_RE.test(picked.varName));
      vn.addEventListener("click", (e) => e.stopPropagation());
      vn.addEventListener("input", () => {
        const old = picked.varName;
        picked.varName = vn.value.trim();
        (step.lengthRules || []).forEach((r) => {
          if (r.col === old) r.col = picked.varName;
        });
        vn.classList.toggle("invalid", !VAR_RE.test(picked.varName));
        recompute(step);
        api.save();
      });
      box.append(vn);
    }
    th.append(box);
    th.addEventListener("click", () => {
      if (rowsMode) {
        if (on) step.columns = step.columns.filter((x) => x.index !== col.index);
        else step.columns = [...(step.columns || []), makeColumn(col, (step.columns || []).map((x) => x.varName))].sort((a, b) => a.index - b.index);
      } else {
        step.colIndex = col.index;
      }
      recompute(step);
      api.save();
      api.rerender();
    });
    head.append(th);
  }
  const body = m.rows.map((r) =>
    h("tr", { class: r.skipped ? "skipped" : "" }, h("td", { class: "rownum" }, r.rowNum), m.cols.map((col) => h("td", { class: m.selected.includes(col.index) ? "on" : "" }, r.cells[col.index] ?? "")))
  );
  return h("div", { class: "preview-wrap", "data-role": "preview" }, h("table", { class: "preview" }, h("thead", {}, head), h("tbody", {}, body)));
}

// Пересчитывает, какие строки предпросмотра будут пропущены (зачёркнутые), не перерисовывая таблицу -
// чтобы ввод числа в правило не терял фокус.
function markSkipped(previewEl, step, c) {
  if (!previewEl || !c) return;
  const m = previewModel(step, c);
  previewEl.querySelectorAll("tbody tr").forEach((tr, i) => tr.classList.toggle("skipped", !!(m.rows[i] && m.rows[i].skipped)));
}

// Без файла в памяти (после перезагрузки страницы) показываем сохранённые данные без возможности менять столбцы
function savedPreview(step) {
  const rowsMode = step.mode === "rows";
  const data = rowsMode ? step.rows : (step.values || []).map((v) => ({ [step.colLabel || "значение"]: v }));
  if (!data || !data.length) return null;
  const keys = Object.keys(data[0]);
  return h(
    "div",
    { class: "preview-wrap", "data-role": "preview" },
    h(
      "table",
      { class: "preview" },
      h("thead", {}, h("tr", {}, keys.map((k) => h("th", {}, k === "_row" ? "№ строки" : k)))),
      h("tbody", {}, data.slice(0, PREVIEW_ROWS).map((r) => h("tr", {}, keys.map((k) => h("td", {}, r[k] ?? "")))))
    )
  );
}

function resultLine(step) {
  const rowsMode = step.mode === "rows";
  const data = rowsMode ? step.rows : step.values;
  const line = h("div", { class: "result-line", "data-role": "result" });
  const update = () => {
    const d = rowsMode ? step.rows : step.values;
    const n = d ? d.length : 0;
    const noun = rowsMode ? pluralRu(n, "строка", "строки", "строк") : pluralRu(n, "значение", "значения", "значений");
    const extra = [];
    if (step.skipped) extra.push(`пропущено ${step.skipped}`);
    if (step.truncated) extra.push(`список обрезан до ${rowsMode ? MAX_ROWS : MAX_VALUES}`);
    if (!n) {
      line.className = "result-line " + (step.skipped ? "warn" : "none");
      line.textContent = step.skipped ? `Ничего не осталось: пропущено ${step.skipped}` : "Данных пока нет";
    } else {
      line.className = "result-line" + (step.truncated ? " warn" : "");
      line.textContent = `✔ ${n} ${noun} готово${extra.length ? " · " + extra.join(" · ") : ""}`;
    }
  };
  update();
  line.update = update;
  return line;
}

function rulesEditor(step, api, result, onChange) {
  step.lengthRules = step.lengthRules || [];
  const rowsMode = step.mode === "rows";
  const wrap = h("div", { class: "rules", "data-role": "rules" });
  const changed = () => {
    recompute(step);
    result.update();
    if (onChange) onChange();
    api.save();
  };
  step.lengthRules.forEach((rule, i) => {
    const row = h("div", { class: "rule" }, h("span", {}, "Пропускать, если длина"));
    if (rowsMode) {
      const names = (step.columns || []).map((c) => [c.varName, c.varName]);
      if (rule.col && !names.some(([v]) => v === rule.col)) names.push([rule.col, `${rule.col} (не выбран)`]);
      row.append(selectInput(names, rule.col, (v) => { rule.col = v; changed(); api.rerender(); }));
    }
    row.append(selectInput(Object.entries(LENGTH_OPS), rule.op, (v) => { rule.op = v; changed(); api.rerender(); }));
    row.append(textInput({ type: "number", min: 0, value: rule.n ?? "", placeholder: "N", onInput: (v) => { rule.n = v; changed(); }, tip: "Число символов" }));
    row.append(selectInput(Object.entries(LENGTH_COUNT), rule.count || "chars", (v) => { rule.count = v; changed(); api.rerender(); }, { tip: "Как считать длину" }));
    row.append(
      iconButton("✕", "Удалить правило", () => {
        step.lengthRules.splice(i, 1);
        changed();
        api.rerender();
      }, { danger: true })
    );
    wrap.append(row);
  });
  wrap.append(
    button("Добавить правило", {
      kind: "ghost",
      icon: "＋",
      onClick: () => {
        const first = (step.columns || [])[0];
        step.lengthRules.push({ col: rowsMode && first ? first.varName : "", op: "neq", n: "", count: "chars" });
        api.save();
        api.rerender();
      },
    })
  );
  return wrap;
}

export function dataStepBody(step, api) {
  const c = cache.get(step.id);
  const rowsMode = step.mode === "rows";
  const root = h("div", { class: "stack", "data-role": "data-step" });

  // 1. файл + лист
  const fileInput = h("input", { type: "file", accept: ".xlsx,.xlsm,.xls,.csv,.tsv,.txt", "data-role": "file" });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) loadFile(step, fileInput.files[0], api);
  });
  const drop = h(
    "div",
    { class: "file-drop" },
    fileInput,
    button(step.fileName ? "Выбрать другой файл" : "Выбрать файл Excel или CSV", { kind: step.fileName ? "default" : "primary", icon: "📂", onClick: () => fileInput.click() }),
    step.fileName ? h("div", { style: { minWidth: 0 } }, h("div", { class: "file-name" }, step.fileName)) : null
  );
  if (c) {
    const sheetSel = selectInput(c.wb.SheetNames.map((n) => [n, n]), step.sheet, (v) => {
      step.sheet = v;
      remapColumns(step, listColumns(rowsOf(c, v), step.hasHeader));
      if (!rowsMode) step.colIndex = findColumnIndex(rowsOf(c, v), step);
      recompute(step);
      api.save();
      api.rerender();
    });
    drop.append(h("div", { class: "spacer" }), h("div", { class: "row" }, h("span", { class: "file-sub" }, "Лист"), sheetSel));
  }
  root.append(drop);

  // 2. режим
  root.append(
    segmented(
      [["column", "Один столбец"], ["rows", "Таблица: несколько столбцов"]],
      step.mode || "column",
      (v) => {
        step.mode = v;
        if (v === "rows" && step.varName === "list") step.varName = "rows";
        if (v === "column" && step.varName === "rows") step.varName = "list";
        if (v === "rows" && !(step.columns && step.columns.length) && c) {
          const cols = listColumns(rowsOf(c, step.sheet), step.hasHeader);
          if (cols.length) step.columns = [makeColumn(cols[Math.min(step.colIndex || 0, cols.length - 1)], [])];
        }
        recompute(step);
        api.save();
        api.rerender();
      }
    )
  );

  // 3. предпросмотр
  const result = resultLine(step);
  let previewEl = null;
  if (c) {
    previewEl = previewTable(step, c, api);
    root.append(previewEl);
  } else {
    const sp = savedPreview(step);
    if (sp) root.append(sp);
  }
  root.append(result);

  // 4. обработка и правила пропуска
  if (c) {
    const recomputeAndShow = () => {
      recompute(step);
      result.update();
      api.save();
      api.rerender();
    };
    root.append(
      h(
        "div",
        { class: "row wrap" },
        checkbox("Первая строка — заголовки", step.hasHeader, (v) => {
          step.hasHeader = v;
          const cols = listColumns(rowsOf(c, step.sheet), v);
          if (rowsMode) step.columns = (step.columns || []).filter((x) => x.index < cols.length);
          else step.colIndex = findColumnIndex(rowsOf(c, step.sheet), { ...step, hasHeader: v });
          recomputeAndShow();
        }),
        checkbox("Обрезать пробелы", step.trim, (v) => { step.trim = v; recomputeAndShow(); }),
        checkbox(rowsMode ? "Пропускать пустые строки" : "Пропускать пустые ячейки", step.skipEmpty, (v) => { step.skipEmpty = v; recomputeAndShow(); }),
        checkbox(rowsMode ? "Только уникальные строки" : "Только уникальные значения", step.unique, (v) => { step.unique = v; recomputeAndShow(); })
      )
    );
    root.append(disclosure("Пропускать записи по длине значения", rulesEditor(step, api, result, () => markSkipped(previewEl, step, c)), { open: (step.lengthRules || []).length > 0, badge: (step.lengthRules || []).length || null }));
  }

  // 5. имя переменной
  root.append(
    disclosure(
      "Имя переменной",
      field("Сохранить в переменную", textInput({ value: step.varName, mono: true, placeholder: rowsMode ? "rows" : "list", onInput: (v) => { step.varName = v.trim(); api.save(); } }), { tip: "Дальше её выбирают в шаге «Для каждой записи»" })
    )
  );
  return root;
}
