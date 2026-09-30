import {
  loadMacros,
  saveMacros,
  newMacro,
  uid,
  defaultStep,
  STEP_LABELS,
  STEP_GROUPS,
  newTrigger,
  TRIGGER_LABELS,
  NO_RETRY_STEP_TYPES,
} from "./common.js";
import {
  MAX_VALUES,
  readWorkbook,
  sheetToRows,
  listColumns,
  findColumnIndex,
  extractColumn,
} from "./excel-import.js";

const sidebarList = document.getElementById("sidebarList");
const nameInput = document.getElementById("macroName");
const newTabCheckbox = document.getElementById("openInNewTab");
const inputsTable = document.getElementById("inputsTable");
const addInputBtn = document.getElementById("addInputBtn");
const triggersTable = document.getElementById("triggersTable");
const addTriggerSelect = document.getElementById("addTriggerSelect");
const addTriggerBtn = document.getElementById("addTriggerBtn");
const stepsRoot = document.getElementById("stepsRoot");
const addStepSelect = document.getElementById("addStepSelect");
const addStepBtn = document.getElementById("addStepBtn");
const runBtn = document.getElementById("runBtn");
const stopBtn = document.getElementById("stopBtn");
const recordBtn = document.getElementById("recordBtn");
const targetTabSelect = document.getElementById("targetTabSelect");
const refreshTabsBtn = document.getElementById("refreshTabsBtn");
const logPanel = document.getElementById("logPanel");
const exportBtn = document.getElementById("exportBtn");
const importInput = document.getElementById("importInput");
const deleteBtn = document.getElementById("deleteBtn");
const duplicateBtn = document.getElementById("duplicateBtn");
const builderEmpty = document.getElementById("builderEmpty");
const builderCard = document.getElementById("builderCard");

let allMacros = [];
let current = null;
let currentRunId = null;
let pickTargetField = null; // { step, inputEl } - куда вписать результат пипетки
let recording = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function populateStepTypeOptions(select) {
  select.innerHTML = "";
  for (const group of STEP_GROUPS) {
    const og = document.createElement("optgroup");
    og.label = group.label;
    for (const t of group.types) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = STEP_LABELS[t];
      og.appendChild(opt);
    }
    select.appendChild(og);
  }
}
populateStepTypeOptions(addStepSelect);

async function init() {
  allMacros = await loadMacros();
  const params = new URLSearchParams(location.search);
  const id = params.get("m");
  if (id) current = allMacros.find((m) => m.id === id) || null;
  if (!current) {
    current = newMacro();
    allMacros.push(current);
    await persist();
    history.replaceState(null, "", "?m=" + current.id);
  }
  renderSidebar();
  renderMacro();
  refreshTargetTabs();
}

async function persist() {
  current.updatedAt = Date.now();
  const idx = allMacros.findIndex((m) => m.id === current.id);
  if (idx === -1) allMacros.push(current);
  else allMacros[idx] = current;
  await saveMacros(allMacros);
  renderSidebar();
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
}

function renderSidebar() {
  sidebarList.innerHTML = "";
  for (const m of allMacros) {
    const row = document.createElement("div");
    row.className = "pool-row" + (current && m.id === current.id ? " active" : "");
    row.innerHTML = `<span class="pool-name-wrap"><span class="pool-name">${escapeHtml(
      m.name || "Без имени"
    )}</span><span class="pool-hint">${(m.steps || []).length} шаг(ов)</span></span>`;
    row.addEventListener("click", () => {
      current = m;
      history.replaceState(null, "", "?m=" + m.id);
      renderSidebar();
      renderMacro();
    });
    sidebarList.appendChild(row);
  }
}

document.getElementById("newMacroBtn").addEventListener("click", async () => {
  current = newMacro();
  allMacros.push(current);
  await persist();
  history.replaceState(null, "", "?m=" + current.id);
  renderMacro();
});

function renderMacro() {
  builderCard.style.display = current ? "block" : "none";
  builderEmpty.style.display = current ? "none" : "block";
  if (!current) return;
  nameInput.value = current.name || "";
  newTabCheckbox.checked = !!current.openInNewTab;
  current.inputs = current.inputs || [];
  current.triggers = current.triggers || [];
  current.steps = current.steps || [];
  renderInputsTable();
  renderTriggersTable();
  rerenderAll();
}

nameInput.addEventListener("input", () => {
  current.name = nameInput.value;
  scheduleSave();
});
newTabCheckbox.addEventListener("change", () => {
  current.openInNewTab = newTabCheckbox.checked;
  scheduleSave();
});

function renderInputsTable() {
  inputsTable.innerHTML = "";
  current.inputs.forEach((inp, i) => {
    const row = document.createElement("div");
    row.className = "input-param-row";
    row.innerHTML = `
      <input type="text" placeholder="ключ (напр. phone)" value="${escapeHtml(inp.key)}" data-f="key">
      <input type="text" placeholder="подпись для пользователя" value="${escapeHtml(inp.label || "")}" data-f="label">
      <label class="checkbox-inline"><input type="checkbox" data-f="multiline" ${inp.multiline ? "checked" : ""}> список</label>
      <button type="button" class="pool-remove" title="Удалить">×</button>
    `;
    row.querySelector('[data-f="key"]').addEventListener("input", (e) => {
      inp.key = e.target.value.trim();
      scheduleSave();
    });
    row.querySelector('[data-f="label"]').addEventListener("input", (e) => {
      inp.label = e.target.value;
      scheduleSave();
    });
    row.querySelector('[data-f="multiline"]').addEventListener("change", (e) => {
      inp.multiline = e.target.checked;
      scheduleSave();
    });
    row.querySelector(".pool-remove").addEventListener("click", () => {
      current.inputs.splice(i, 1);
      renderInputsTable();
      scheduleSave();
    });
    inputsTable.appendChild(row);
  });
}

addInputBtn.addEventListener("click", () => {
  current.inputs.push({ key: "param" + (current.inputs.length + 1), label: "", multiline: false, default: "" });
  renderInputsTable();
  scheduleSave();
});

// ---------------- триггеры (расписание / автозапуск по URL) ----------------

for (const [type, label] of Object.entries(TRIGGER_LABELS)) {
  const opt = document.createElement("option");
  opt.value = type;
  opt.textContent = label;
  addTriggerSelect.appendChild(opt);
}

function renderTriggersTable() {
  triggersTable.innerHTML = "";
  current.triggers.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "trigger-row";

    const head = document.createElement("div");
    head.className = "trigger-row-head";
    const label = document.createElement("span");
    label.className = "step-badge";
    label.textContent = TRIGGER_LABELS[t.type] || t.type;
    head.appendChild(label);

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "checkbox-inline";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = !!t.enabled;
    enabledInput.addEventListener("change", () => {
      t.enabled = enabledInput.checked;
      scheduleSave();
    });
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(document.createTextNode(" включён"));
    head.appendChild(enabledLabel);

    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    head.appendChild(spacer);
    head.appendChild(
      mkIconBtn("×", "Удалить триггер", () => {
        current.triggers.splice(i, 1);
        renderTriggersTable();
        scheduleSave();
      })
    );
    row.appendChild(head);

    const fields = document.createElement("div");
    fields.className = "step-fields";
    if (t.type === "interval") {
      textField(fields, "Каждые N минут", t.everyMinutes, (v) => {
        t.everyMinutes = v;
        scheduleSave();
        chrome.runtime.sendMessage({ action: "syncAlarms" });
      });
    } else if (t.type === "daily") {
      const timeInput = document.createElement("input");
      timeInput.type = "time";
      timeInput.value = t.atTime || "09:00";
      timeInput.addEventListener("input", () => {
        t.atTime = timeInput.value;
        scheduleSave();
        chrome.runtime.sendMessage({ action: "syncAlarms" });
      });
      field(fields, "Время (каждый день)", timeInput);
    } else if (t.type === "urlMatch") {
      textField(
        fields,
        "Шаблон URL (можно * как маску)",
        t.pattern,
        (v) => {
          t.pattern = v;
          scheduleSave();
        },
        "https://example.com/orders*",
        true
      );
    }
    row.appendChild(fields);
    triggersTable.appendChild(row);
  });
}

addTriggerBtn.addEventListener("click", () => {
  current.triggers.push(newTrigger(addTriggerSelect.value));
  renderTriggersTable();
  scheduleSave();
  chrome.runtime.sendMessage({ action: "syncAlarms" });
});

// ---------------- дерево шагов ----------------

function renderStepsList(arr, container, depth) {
  container.innerHTML = "";
  if (!arr.length) {
    const hint = document.createElement("div");
    hint.className = "steps-empty-hint";
    hint.textContent = "Шагов пока нет";
    container.appendChild(hint);
  }
  arr.forEach((step, idx) => container.appendChild(renderStepCard(step, arr, idx)));
}

function mkIconBtn(txt, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pool-remove";
  b.textContent = txt;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function renderStepCard(step, arr, idx) {
  const card = document.createElement("div");
  card.className = "step-card";

  const head = document.createElement("div");
  head.className = "step-head";
  const badge = document.createElement("span");
  badge.className = "step-badge";
  badge.textContent = STEP_LABELS[step.type] || step.type;
  head.appendChild(badge);

  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  head.appendChild(spacer);

  head.appendChild(
    mkIconBtn("▶", "Выполнить только этот шаг", () => runSingleStep(step))
  );
  head.appendChild(
    mkIconBtn("↑", "Выше", () => {
      if (idx > 0) {
        [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
        rerenderAll();
        scheduleSave();
      }
    })
  );
  head.appendChild(
    mkIconBtn("↓", "Ниже", () => {
      if (idx < arr.length - 1) {
        [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
        rerenderAll();
        scheduleSave();
      }
    })
  );
  head.appendChild(
    mkIconBtn("⧉", "Дублировать", () => {
      arr.splice(idx + 1, 0, { ...JSON.parse(JSON.stringify(step)), id: uid() });
      rerenderAll();
      scheduleSave();
    })
  );
  head.appendChild(
    mkIconBtn("×", "Удалить", () => {
      arr.splice(idx, 1);
      rerenderAll();
      scheduleSave();
    })
  );
  card.appendChild(head);

  const fields = document.createElement("div");
  fields.className = "step-fields";
  renderStepFields(step, fields);
  card.appendChild(fields);

  if (!NO_RETRY_STEP_TYPES.includes(step.type)) {
    const retryFields = document.createElement("div");
    retryFields.className = "step-fields retry-fields";
    textField(retryFields, "Повторов при ошибке", step.retries, (v) => { step.retries = v; scheduleSave(); });
    textField(retryFields, "Задержка между попытками, мс", step.retryDelayMs, (v) => { step.retryDelayMs = v; scheduleSave(); });
    selectField(
      retryFields,
      "Если не получилось",
      [
        ["stop", "Остановить макрос"],
        ["skip", "Пропустить и продолжить"],
      ],
      step.onError || "stop",
      (v) => { step.onError = v; scheduleSave(); }
    );
    card.appendChild(retryFields);
  }

  if (step.type === "condition") {
    step.then = step.then || [];
    step.else = step.else || [];
    card.appendChild(renderBranch("Если найден — выполнить:", step.then));
    card.appendChild(renderBranch("Иначе:", step.else));
  }
  if (step.type === "loopCount" || step.type === "loopList") {
    step.steps = step.steps || [];
    card.appendChild(renderBranch("Повторяемые шаги:", step.steps));
  }

  return card;
}

function renderBranch(title, arr) {
  const wrap = document.createElement("div");
  wrap.className = "branch";
  const h = document.createElement("div");
  h.className = "branch-title";
  h.textContent = title;
  wrap.appendChild(h);

  const listEl = document.createElement("div");
  wrap.appendChild(listEl);
  renderStepsList(arr, listEl);

  const addRow = document.createElement("div");
  addRow.className = "add-step-row";
  const sel = document.createElement("select");
  populateStepTypeOptions(sel);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary-btn";
  btn.style.cssText = "width:auto;margin:0;";
  btn.textContent = "+ Добавить шаг";
  btn.addEventListener("click", () => {
    arr.push(defaultStep(sel.value));
    rerenderAll();
    scheduleSave();
  });
  addRow.appendChild(sel);
  addRow.appendChild(btn);
  wrap.appendChild(addRow);
  return wrap;
}

function rerenderAll() {
  renderStepsList(current.steps, stepsRoot);
}

function field(container, labelText, inputEl, wide) {
  const label = document.createElement("label");
  if (wide) label.className = "wide";
  label.textContent = labelText;
  label.appendChild(document.createElement("br"));
  label.appendChild(inputEl);
  container.appendChild(label);
  return inputEl;
}

function textField(container, labelText, value, onChange, placeholder, wide) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener("input", () => onChange(input.value));
  field(container, labelText, input, wide);
  return input;
}

function selectField(container, labelText, options, value, onChange) {
  const select = document.createElement("select");
  for (const [v, l] of options) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = l;
    if (v === value) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => onChange(select.value));
  field(container, labelText, select);
  return select;
}

function checkboxField(container, labelText, checked, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "checkbox-inline wide";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!checked;
  input.addEventListener("change", () => onChange(input.checked));
  wrap.appendChild(input);
  wrap.appendChild(document.createTextNode(" " + labelText));
  container.appendChild(wrap);
  return input;
}

function selectorFieldGroup(container, step) {
  selectField(
    container,
    "Тип селектора",
    [
      ["css", "CSS-селектор"],
      ["text", "По тексту"],
      ["xpath", "XPath"],
    ],
    step.selectorType,
    (v) => {
      step.selectorType = v;
      scheduleSave();
    }
  );

  const rowWrap = document.createElement("div");
  rowWrap.className = "row-with-btn";
  const input = document.createElement("input");
  input.type = "text";
  input.value = step.selector || "";
  input.placeholder = "селектор, текст или xpath";
  input.addEventListener("input", () => {
    step.selector = input.value;
    scheduleSave();
  });
  const pickBtn = document.createElement("button");
  pickBtn.type = "button";
  pickBtn.textContent = "🎯";
  pickBtn.title = "Выбрать элемент на целевой вкладке (в т.ч. внутри iframe)";

  const labelWrap = document.createElement("label");
  labelWrap.className = "wide";
  labelWrap.textContent = "Селектор";
  labelWrap.appendChild(rowWrap);
  rowWrap.appendChild(input);
  rowWrap.appendChild(pickBtn);
  container.appendChild(labelWrap);

  const frameInput = textField(
    container,
    "Фрейм: URL содержит (пусто = основная страница)",
    step.frameUrlIncludes,
    (v) => { step.frameUrlIncludes = v; scheduleSave(); },
    "напр. checkout или payments.example.com",
    true
  );

  pickBtn.addEventListener("click", () => startPickFor(step, input, frameInput));
}

function renderStepFields(step, container) {
  switch (step.type) {
    case "navigate":
      textField(container, "URL (можно ${переменные})", step.url, (v) => { step.url = v; scheduleSave(); }, "https://example.com", true);
      break;
    case "click":
      selectorFieldGroup(container, step);
      textField(container, "Индекс совпадения (0 — первый)", step.index, (v) => { step.index = v; scheduleSave(); });
      textField(container, "Таймаут ожидания, мс", step.timeoutMs, (v) => { step.timeoutMs = v; scheduleSave(); });
      break;
    case "type":
      selectorFieldGroup(container, step);
      textField(container, "Текст для ввода (можно ${переменные})", step.value, (v) => { step.value = v; scheduleSave(); }, "", true);
      checkboxField(container, "Очищать поле перед вводом", step.clear, (v) => { step.clear = v; scheduleSave(); });
      checkboxField(container, "Нажать Enter после ввода", step.pressEnter, (v) => { step.pressEnter = v; scheduleSave(); });
      textField(container, "Таймаут ожидания, мс", step.timeoutMs, (v) => { step.timeoutMs = v; scheduleSave(); });
      break;
    case "wait":
      textField(container, "Пауза, мс", step.ms, (v) => { step.ms = v; scheduleSave(); });
      break;
    case "waitFor":
      selectorFieldGroup(container, step);
      textField(container, "Таймаут, мс", step.timeoutMs, (v) => { step.timeoutMs = v; scheduleSave(); });
      break;
    case "extract":
      selectorFieldGroup(container, step);
      selectField(
        container,
        "Что взять",
        [
          ["text", "Текст"],
          ["value", "Value (поля ввода)"],
          ["html", "HTML"],
          ["href", "Атрибут href"],
          ["src", "Атрибут src"],
        ],
        step.attr,
        (v) => { step.attr = v; scheduleSave(); }
      );
      textField(container, "Сохранить в переменную", step.varName, (v) => { step.varName = v; scheduleSave(); }, "result");
      checkboxField(container, "Собрать все совпадения списком", step.multiple, (v) => { step.multiple = v; scheduleSave(); });
      break;
    case "extractTable": {
      selectField(
        container,
        "Тип селектора строк",
        [
          ["css", "CSS-селектор"],
          ["xpath", "XPath"],
        ],
        step.rowSelectorType,
        (v) => { step.rowSelectorType = v; scheduleSave(); }
      );
      textField(
        container,
        "Селектор строк (каждое совпадение — одна строка таблицы)",
        step.rowSelector,
        (v) => { step.rowSelector = v; scheduleSave(); },
        "tr, .product-card",
        true
      );
      textField(container, "Сохранить в переменную", step.varName, (v) => { step.varName = v; scheduleSave(); }, "rows");
      textField(
        container,
        "Фрейм: URL содержит (пусто = основная страница)",
        step.frameUrlIncludes,
        (v) => { step.frameUrlIncludes = v; scheduleSave(); },
        "",
        true
      );

      step.columns = step.columns && step.columns.length ? step.columns : [{ key: "col1", selector: "", attr: "text" }];
      const colsLabel = document.createElement("label");
      colsLabel.className = "wide";
      colsLabel.textContent = "Колонки (селектор — относительно строки, пусто = вся строка)";
      const colsWrap = document.createElement("div");
      colsWrap.className = "inputs-table";
      colsLabel.appendChild(colsWrap);
      container.appendChild(colsLabel);

      step.columns.forEach((col, i) => {
        const row = document.createElement("div");
        row.className = "input-param-row";
        row.innerHTML = `
          <input type="text" placeholder="имя колонки" value="${escapeHtml(col.key || "")}" data-f="key">
          <input type="text" placeholder="селектор внутри строки" value="${escapeHtml(col.selector || "")}" data-f="sel">
          <select data-f="attr">
            <option value="text">Текст</option>
            <option value="value">Value</option>
            <option value="html">HTML</option>
            <option value="href">href</option>
            <option value="src">src</option>
          </select>
          <button type="button" class="pool-remove" title="Удалить колонку">×</button>
        `;
        row.querySelector('[data-f="attr"]').value = col.attr || "text";
        row.querySelector('[data-f="key"]').addEventListener("input", (e) => { col.key = e.target.value.trim(); scheduleSave(); });
        row.querySelector('[data-f="sel"]').addEventListener("input", (e) => { col.selector = e.target.value; scheduleSave(); });
        row.querySelector('[data-f="attr"]').addEventListener("change", (e) => { col.attr = e.target.value; scheduleSave(); });
        row.querySelector(".pool-remove").addEventListener("click", () => {
          step.columns.splice(i, 1);
          rerenderAll();
          scheduleSave();
        });
        colsWrap.appendChild(row);
      });

      const addColBtn = document.createElement("button");
      addColBtn.type = "button";
      addColBtn.className = "secondary-btn";
      addColBtn.style.cssText = "width:auto;margin:0;";
      addColBtn.textContent = "+ Колонка";
      addColBtn.addEventListener("click", () => {
        step.columns.push({ key: "col" + (step.columns.length + 1), selector: "", attr: "text" });
        rerenderAll();
        scheduleSave();
      });
      container.appendChild(addColBtn);
      break;
    }
    case "exportCsv":
      textField(
        container,
        "Переменная с таблицей (результат «Извлечь таблицу»)",
        step.sourceVar,
        (v) => { step.sourceVar = v; scheduleSave(); },
        "rows"
      );
      textField(container, "Имя файла (можно ${переменные})", step.filename, (v) => { step.filename = v; scheduleSave(); }, "export.csv");
      break;
    case "loadExcel":
      renderLoadExcelFields(step, container);
      break;
    case "condition":
      selectorFieldGroup(container, step);
      selectField(
        container,
        "Условие",
        [
          ["exists", "Элемент найден"],
          ["notExists", "Элемент НЕ найден"],
        ],
        step.mode,
        (v) => { step.mode = v; scheduleSave(); }
      );
      textField(container, "Таймаут проверки, мс", step.timeoutMs, (v) => { step.timeoutMs = v; scheduleSave(); });
      break;
    case "loopCount":
      textField(container, "Сколько раз (можно ${переменную})", step.count, (v) => { step.count = v; scheduleSave(); });
      textField(container, "Имя переменной-счётчика", step.itemVar, (v) => { step.itemVar = v; scheduleSave(); });
      break;
    case "loopList":
      textField(
        container,
        "Переменная со списком (входной параметр, столбец из Excel или ранее извлечённая)",
        step.sourceKey,
        (v) => { step.sourceKey = v; scheduleSave(); },
        "phones"
      );
      textField(container, "Имя переменной текущего элемента", step.itemVar, (v) => { step.itemVar = v; scheduleSave(); });
      break;
    case "customJs": {
      const ta = document.createElement("textarea");
      ta.rows = 6;
      ta.value = step.code || "";
      ta.addEventListener("input", () => { step.code = ta.value; scheduleSave(); });
      const label = document.createElement("label");
      label.className = "wide";
      label.textContent = "Код (доступны vars, helpers.$ / helpers.$$ / await helpers.sleep(ms), return значение)";
      label.appendChild(ta);
      container.appendChild(label);
      textField(container, "Сохранить возвращённое значение в переменную (необязательно)", step.saveTo, (v) => { step.saveTo = v; scheduleSave(); });
      textField(
        container,
        "Фрейм: URL содержит (пусто = основная страница)",
        step.frameUrlIncludes,
        (v) => { step.frameUrlIncludes = v; scheduleSave(); },
        "",
        true
      );
      break;
    }
    case "keypress":
      textField(container, "Клавиша (Enter, Tab, Escape...)", step.key, (v) => { step.key = v; scheduleSave(); });
      break;
    case "scroll":
      selectField(
        container,
        "Режим",
        [
          ["bottom", "В конец страницы"],
          ["toElement", "К элементу"],
        ],
        step.mode,
        (v) => { step.mode = v; scheduleSave(); rerenderAll(); }
      );
      if (step.mode === "toElement") selectorFieldGroup(container, step);
      break;
  }
}

// ---------------- шаг «Загрузить столбец из Excel/CSV» ----------------

// Разобранные книги живут только в памяти страницы конструктора (step.id -> книга) и
// нужны, чтобы менять лист/столбец без повторного выбора файла. В макросе сохраняется
// только снимок столбца (step.values).
const excelCache = new Map();

function excelRows(cache, sheet) {
  if (!cache.rows.has(sheet)) cache.rows.set(sheet, sheetToRows(globalThis.XLSX, cache.wb, sheet));
  return cache.rows.get(sheet);
}

function recomputeExcel(step) {
  const cache = excelCache.get(step.id);
  if (!cache) return;
  const rows = excelRows(cache, step.sheet);
  const cols = listColumns(rows, step.hasHeader);
  const col = cols[step.colIndex] || cols[0];
  step.colIndex = col ? col.index : 0;
  step.colLabel = col ? col.header : "";
  const { values, truncated } = extractColumn(rows, step);
  step.values = values;
  step.truncated = truncated;
}

async function loadExcelFile(step, file) {
  try {
    const wb = readWorkbook(globalThis.XLSX, await file.arrayBuffer(), file.name);
    if (!wb.SheetNames.length) throw new Error("в файле нет листов");
    const cache = { wb, rows: new Map() };
    excelCache.set(step.id, cache);
    // Прежние настройки применяем по возможности: лист - по имени, столбец - по заголовку.
    step.sheet = wb.SheetNames.includes(step.sheet) ? step.sheet : wb.SheetNames[0];
    step.fileName = file.name;
    step.colIndex = findColumnIndex(excelRows(cache, step.sheet), step);
    recomputeExcel(step);
    rerenderAll();
    scheduleSave();
  } catch (e) {
    alert("Не удалось прочитать файл: " + e.message);
  }
}

function excelSummaryText(step) {
  if (!step.values || !step.values.length) return "Данных пока нет — выберите файл Excel или CSV.";
  const head = step.values.slice(0, 3).join(" · ");
  const more = step.values.length > 3 ? " …" : "";
  const tail = step.truncated ? ` ВНИМАНИЕ: список обрезан до ${MAX_VALUES} значений.` : "";
  return (
    `Сохранено значений: ${step.values.length} (файл «${step.fileName}», лист «${step.sheet}», ` +
    `столбец «${step.colLabel || "без заголовка"}»). Первые: ${head}${more}.${tail}`
  );
}

function renderLoadExcelFields(step, container) {
  const cache = excelCache.get(step.id);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".xlsx,.xlsm,.xls,.csv,.tsv,.txt";
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) loadExcelFile(step, fileInput.files[0]);
  });
  field(container, "Файл (.xlsx, .xls, .xlsm, .csv)", fileInput, true);

  const summary = document.createElement("div");
  summary.className = "field-note" + (step.truncated ? " warn" : "");
  summary.textContent = excelSummaryText(step);
  container.appendChild(summary);
  const refreshSummary = () => {
    summary.className = "field-note" + (step.truncated ? " warn" : "");
    summary.textContent = excelSummaryText(step);
  };
  const recompute = () => {
    recomputeExcel(step);
    refreshSummary();
    scheduleSave();
  };

  if (cache) {
    selectField(
      container,
      "Лист",
      cache.wb.SheetNames.map((n) => [n, n]),
      step.sheet,
      (v) => {
        step.sheet = v;
        step.colIndex = findColumnIndex(excelRows(cache, v), step);
        recomputeExcel(step);
        rerenderAll();
        scheduleSave();
      }
    );
    const cols = listColumns(excelRows(cache, step.sheet), step.hasHeader);
    selectField(
      container,
      "Столбец",
      cols.map((c) => [String(c.index), c.label]),
      String(step.colIndex),
      (v) => {
        step.colIndex = Number(v);
        recompute();
      }
    );
    checkboxField(container, "Первая строка — заголовки (не входит в список)", step.hasHeader, (v) => {
      step.hasHeader = v;
      step.colIndex = findColumnIndex(excelRows(cache, step.sheet), { ...step, hasHeader: v });
      recomputeExcel(step);
      rerenderAll();
      scheduleSave();
    });
    checkboxField(container, "Обрезать пробелы по краям", step.trim, (v) => { step.trim = v; recompute(); });
    checkboxField(container, "Пропускать пустые ячейки", step.skipEmpty, (v) => { step.skipEmpty = v; recompute(); });
    checkboxField(container, "Только уникальные значения", step.unique, (v) => { step.unique = v; recompute(); });
  } else if (step.values && step.values.length) {
    const note = document.createElement("div");
    note.className = "field-note";
    note.textContent = "Чтобы сменить лист, столбец или обновить данные, выберите файл заново — прежние настройки подставятся сами.";
    container.appendChild(note);
  }

  textField(
    container,
    "Сохранить список в переменную (дальше — «Для каждого значения из списка»)",
    step.varName,
    (v) => { step.varName = v.trim(); scheduleSave(); },
    "list",
    true
  );
}

addStepBtn.addEventListener("click", () => {
  current.steps.push(defaultStep(addStepSelect.value));
  rerenderAll();
  scheduleSave();
});

// ---------------- целевая вкладка, пипетка, запись ----------------

async function refreshTargetTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const prev = targetTabSelect.value;
  targetTabSelect.innerHTML = "";
  for (const t of tabs) {
    if (!t.url || t.url.startsWith("chrome-extension://") || t.url.startsWith("chrome://")) continue;
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = (t.title || t.url).slice(0, 55);
    targetTabSelect.appendChild(opt);
  }
  if (prev && Array.from(targetTabSelect.options).some((o) => o.value === prev)) targetTabSelect.value = prev;
}
refreshTabsBtn.addEventListener("click", refreshTargetTabs);

function getTargetTabId() {
  const v = targetTabSelect.value;
  return v ? Number(v) : null;
}

async function ensureContentScriptInTarget(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {}
}

async function startPickFor(step, inputEl, frameInputEl) {
  const tabId = getTargetTabId();
  if (!tabId) {
    alert("Выберите целевую вкладку сверху.");
    return;
  }
  await ensureContentScriptInTarget(tabId);
  pickTargetField = { step, inputEl, frameInputEl };
  // Сообщение без frameId уходит во ВСЕ фреймы вкладки (all_frames:true в manifest) -
  // пипетка сработает там, где физически произошёл клик, включая iframe.
  chrome.tabs.sendMessage(tabId, { action: "startPicker" });
  chrome.tabs.update(tabId, { active: true });
}

async function runSingleStep(step) {
  const tabId = getTargetTabId();
  if (!tabId) {
    alert("Выберите целевую вкладку сверху.");
    return;
  }
  logPanel.innerHTML = "";
  currentRunId = uid("run");
  const miniMacro = { id: "single", name: "(один шаг)", openInNewTab: false, inputs: [], triggers: [], steps: [step] };
  chrome.runtime.sendMessage({ action: "runMacro", macro: miniMacro, inputValues: {}, runId: currentRunId, tabId });
}

recordBtn.addEventListener("click", async () => {
  const tabId = getTargetTabId();
  if (!tabId) {
    alert("Выберите целевую вкладку сверху.");
    return;
  }
  recording = !recording;
  recordBtn.textContent = recording ? "⏹ Остановить запись" : "● Записать шаги";
  recordBtn.classList.toggle("recording", recording);
  chrome.runtime.sendMessage({ action: recording ? "startRecording" : "stopRecording", tabId });
  if (recording) chrome.tabs.update(tabId, { active: true });
});

function handleRecordedEvent(msg) {
  if (!current) return;
  if (msg.kind === "navigate") {
    current.steps.push({ ...defaultStep("navigate"), url: msg.url });
  } else if (msg.kind === "click") {
    current.steps.push({
      ...defaultStep("click"),
      selectorType: "css",
      selector: msg.selector,
      frameUrlIncludes: msg.frameUrl || "",
    });
  } else if (msg.kind === "type") {
    const last = current.steps[current.steps.length - 1];
    if (last && last.type === "type" && last.selector === msg.selector) {
      last.value = msg.value;
    } else {
      current.steps.push({
        ...defaultStep("type"),
        selectorType: "css",
        selector: msg.selector,
        value: msg.value,
        frameUrlIncludes: msg.frameUrl || "",
      });
    }
  }
  rerenderAll();
  scheduleSave();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "pickerResult" && pickTargetField) {
    pickTargetField.step.selectorType = "css";
    pickTargetField.step.selector = msg.selector;
    pickTargetField.inputEl.value = msg.selector;
    if (pickTargetField.frameInputEl) {
      pickTargetField.step.frameUrlIncludes = msg.frameUrl || "";
      pickTargetField.frameInputEl.value = msg.frameUrl || "";
    }
    pickTargetField = null;
    window.focus();
    scheduleSave();
    return;
  }
  if (msg.action === "recordedEvent") {
    handleRecordedEvent(msg);
    return;
  }
  if (msg.type === "mb-log" && msg.runId === currentRunId) {
    const label = STEP_LABELS[msg.entry.type] || msg.entry.type;
    appendLog(`${label} — ${msg.entry.status}${msg.entry.message ? ": " + msg.entry.message : ""}`, msg.entry.status);
    return;
  }
  if (msg.type === "mb-run-start" && msg.runId === currentRunId) {
    appendLog("Запуск…", "info");
    return;
  }
  if (msg.type === "mb-run-done" && msg.runId === currentRunId) {
    appendLog("Готово ✔", "ok");
    currentRunId = null;
    return;
  }
  if (msg.type === "mb-run-error" && msg.runId === currentRunId) {
    appendLog("Ошибка: " + msg.message, "error");
    currentRunId = null;
    return;
  }
});

// ---------------- запуск / остановка ----------------

function appendLog(text, status) {
  const line = document.createElement("div");
  line.className = "log-line log-" + (status || "info");
  line.textContent = text;
  logPanel.appendChild(line);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function promptMultiline(label) {
  return prompt(label + " (несколько значений — через запятую или каждое с новой строки)", "");
}

runBtn.addEventListener("click", async () => {
  const inputValues = {};
  if (current.inputs && current.inputs.length) {
    for (const inp of current.inputs) {
      const v = inp.multiline ? promptMultiline(inp.label || inp.key) : prompt(inp.label || inp.key, inp.default || "");
      if (v === null) return;
      inputValues[inp.key] = v;
    }
  }
  const tabId = current.openInNewTab ? null : getTargetTabId();
  if (!current.openInNewTab && !tabId) {
    alert("Выберите целевую вкладку сверху или включите запуск в новой вкладке.");
    return;
  }
  logPanel.innerHTML = "";
  currentRunId = uid("run");
  chrome.runtime.sendMessage({ action: "runMacro", macro: current, inputValues, runId: currentRunId, tabId });
});

stopBtn.addEventListener("click", () => {
  if (currentRunId) chrome.runtime.sendMessage({ action: "stopRun", runId: currentRunId });
});

// ---------------- удаление / дублирование / импорт-экспорт ----------------

deleteBtn.addEventListener("click", async () => {
  if (!confirm("Удалить этот макрос?")) return;
  allMacros = allMacros.filter((m) => m.id !== current.id);
  await saveMacros(allMacros);
  current = allMacros[0] || null;
  history.replaceState(null, "", current ? "?m=" + current.id : location.pathname);
  renderSidebar();
  renderMacro();
});

duplicateBtn.addEventListener("click", async () => {
  const copy = JSON.parse(JSON.stringify(current));
  copy.id = uid("m");
  copy.name = (current.name || "Без имени") + " (копия)";
  allMacros.push(copy);
  current = copy;
  await persist();
  history.replaceState(null, "", "?m=" + current.id);
  renderSidebar();
  renderMacro();
});

exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify([current], null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (current.name || "macro").replace(/[\\/:*?"<>|]/g, "_") + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
});

importInput.addEventListener("change", async () => {
  const file = importInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const items = Array.isArray(data) ? data : [data];
    for (const m of items) {
      m.id = uid("m");
      m.inputs = m.inputs || [];
      m.triggers = m.triggers || [];
      m.steps = m.steps || [];
      allMacros.push(m);
    }
    await saveMacros(allMacros);
    current = items[items.length - 1];
    history.replaceState(null, "", "?m=" + current.id);
    renderSidebar();
    renderMacro();
  } catch (e) {
    alert("Не удалось прочитать файл: " + e.message);
  } finally {
    importInput.value = "";
  }
});

init();
