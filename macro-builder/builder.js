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
  TEST_KINDS,
  defaultTest,
  REPORTS_KEY,
  PROGRESS_KEY,
} from "./common.js";
import {
  OP_LABELS,
  UNARY_OPS,
  migrateCondition,
  suggestVarName,
  buildConfig,
  parseImport,
  mergeConfig,
  importAsCopies,
} from "./logic.js";
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
  LENGTH_OPS,
  LENGTH_COUNT,
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
const varsBar = document.getElementById("varsBar");
const reportsList = document.getElementById("reportsList");
const reportsHint = document.getElementById("reportsHint");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const loadConfigInput = document.getElementById("loadConfigInput");
const cfgIncludeData = document.getElementById("cfgIncludeData");
const configHint = document.getElementById("configHint");

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
    card.appendChild(renderBranch("То (проверки выполнены):", step.then));
    card.appendChild(renderBranch("Иначе:", step.else));
  }
  if (step.type === "loopCount" || step.type === "loopList") {
    step.steps = step.steps || [];
    card.appendChild(renderBranch("Повторяемые шаги:", step.steps));
  }
  if (step.type === "loopList" && step.onRowError === "continue") {
    step.catchSteps = step.catchSteps || [];
    const b = renderBranch("При ошибке в записи (доступна ${_error}), затем — следующая запись:", step.catchSteps);
    b.classList.add("catch-branch");
    card.appendChild(b);
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
  renderVarsBar();
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

  // Область поиска: искать внутри строки/контейнера, содержащего нужный текст (напр. «три точки» в строке с ФИО)
  textField(
    container,
    "Искать внутри контейнера (CSS строки, напр. tr или .result-row; пусто = вся страница)",
    step.scopeSelector,
    (v) => { step.scopeSelector = v; scheduleSave(); },
    "tr",
    true
  );
  textField(
    container,
    "…у которого в тексте есть (можно ${переменные}, напр. ${fio}); XPath внутри — относительный, с «.//»",
    step.scopeText,
    (v) => { step.scopeText = v; scheduleSave(); },
    "${fio}",
    true
  );
}

function hintNote(container, text) {
  const d = document.createElement("div");
  d.className = "field-note";
  d.textContent = text;
  container.appendChild(d);
  return d;
}

function checksRow(container, items) {
  const row = document.createElement("div");
  row.className = "checks-row";
  for (const [label, checked, onChange] of items) {
    const l = document.createElement("label");
    const i = document.createElement("input");
    i.type = "checkbox";
    i.checked = !!checked;
    i.addEventListener("change", () => onChange(i.checked));
    l.appendChild(i);
    l.appendChild(document.createTextNode(" " + label));
    row.appendChild(l);
  }
  container.appendChild(row);
}

function normChecks(container, t) {
  checksRow(container, [
    ["не различать регистр", t.ignoreCase !== false, (v) => { t.ignoreCase = v; scheduleSave(); }],
    ["е = ё", t.yo !== false, (v) => { t.yo = v; scheduleSave(); }],
    ["схлопывать пробелы", t.collapseSpaces !== false, (v) => { t.collapseSpaces = v; scheduleSave(); }],
    ["игнорировать знаки препинания", !!t.stripPunct, (v) => { t.stripPunct = v; scheduleSave(); }],
  ]);
}

function opSelect(container, t, label) {
  selectField(
    container,
    label,
    Object.entries(OP_LABELS),
    t.op,
    (v) => { t.op = v; scheduleSave(); rerenderAll(); }
  );
}

// Одна проверка условия: «элемент есть», «текст элемента ~ значение», «значение ~ значение».
function renderTestCard(step, t, i) {
  const card = document.createElement("div");
  card.className = "test-card";
  const head = document.createElement("div");
  head.className = "test-card-head";
  const badge = document.createElement("span");
  badge.className = "step-badge";
  badge.textContent = `${i + 1}. ${TEST_KINDS[t.kind] || t.kind}`;
  head.appendChild(badge);
  const negLabel = document.createElement("label");
  negLabel.className = "checkbox-inline";
  const neg = document.createElement("input");
  neg.type = "checkbox";
  neg.checked = !!t.negate;
  neg.addEventListener("change", () => { t.negate = neg.checked; scheduleSave(); });
  negLabel.appendChild(neg);
  negLabel.appendChild(document.createTextNode(" НЕ (инвертировать)"));
  head.appendChild(negLabel);
  const sp = document.createElement("span");
  sp.style.flex = "1";
  head.appendChild(sp);
  head.appendChild(
    mkIconBtn("×", "Удалить проверку", () => {
      step.tests.splice(i, 1);
      rerenderAll();
      scheduleSave();
    })
  );
  card.appendChild(head);

  const f = document.createElement("div");
  f.className = "step-fields";
  if (t.kind === "var") {
    textField(f, "Левое значение (можно ${переменные})", t.left, (v) => { t.left = v; scheduleSave(); }, "${found}");
    opSelect(f, t, "Операция");
    if (!UNARY_OPS.includes(t.op)) textField(f, "Правое значение (можно ${переменные})", t.right, (v) => { t.right = v; scheduleSave(); }, "${fio}", true);
    normChecks(f, t);
  } else {
    selectorFieldGroup(f, t);
    if (t.kind === "elementText") {
      selectField(
        f,
        "Что читать у элемента",
        [["text", "Текст"], ["value", "Value (поля ввода)"], ["href", "Атрибут href"]],
        t.attr || "text",
        (v) => { t.attr = v; scheduleSave(); }
      );
      selectField(
        f,
        "Какие из найденных элементов проверять",
        [["any", "Хотя бы один подходит"], ["first", "Первый подходит"], ["all", "Все подходят"]],
        t.which || "any",
        (v) => { t.which = v; scheduleSave(); }
      );
      opSelect(f, t, "Сравнение");
      if (!UNARY_OPS.includes(t.op)) textField(f, "Со значением (можно ${переменные}, напр. ${fio})", t.value, (v) => { t.value = v; scheduleSave(); }, "${fio}");
      normChecks(f, t);
    }
    checksRow(f, [["учитывать только видимые элементы", t.visibleOnly !== false, (v) => { t.visibleOnly = v; scheduleSave(); }]]);
  }
  textField(f, "Ждать выполнения проверки до, мс (0 — не ждать, опросить один раз)", t.waitMs, (v) => { t.waitMs = v; scheduleSave(); });
  card.appendChild(f);
  return card;
}

function renderConditionFields(step, container) {
  migrateCondition(step);
  selectField(
    container,
    "Выполнить «то», если",
    [
      ["all", "выполнены ВСЕ проверки (И)"],
      ["any", "выполнена ХОТЯ БЫ ОДНА проверка (ИЛИ)"],
    ],
    step.logic,
    (v) => { step.logic = v; scheduleSave(); }
  );
  textField(container, "Таймаут ответа страницы, мс", step.timeoutMs, (v) => { step.timeoutMs = v; scheduleSave(); });
  step.tests.forEach((t, i) => container.appendChild(renderTestCard(step, t, i)));

  const addRow = document.createElement("div");
  addRow.className = "add-step-row";
  addRow.style.gridColumn = "1 / -1";
  const sel = document.createElement("select");
  for (const [k, label] of Object.entries(TEST_KINDS)) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = label;
    sel.appendChild(o);
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary-btn";
  btn.style.cssText = "width:auto;margin:0;";
  btn.textContent = "+ Проверка";
  btn.addEventListener("click", () => {
    step.tests.push(defaultTest(sel.value));
    rerenderAll();
    scheduleSave();
  });
  addRow.appendChild(sel);
  addRow.appendChild(btn);
  container.appendChild(addRow);
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
      renderConditionFields(step, container);
      break;
    case "hover":
      selectorFieldGroup(container, step);
      textField(container, "Индекс совпадения (0 — первый)", step.index, (v) => { step.index = v; scheduleSave(); });
      textField(container, "Таймаут ожидания, мс", step.timeoutMs, (v) => { step.timeoutMs = v; scheduleSave(); });
      break;
    case "switchTab":
      selectField(
        container,
        "Как получить вкладку",
        [
          ["popup", "Дождаться вкладки, которую открыла страница (после клика)"],
          ["href", "Открыть ссылку (href) найденного элемента средствами расширения"],
        ],
        step.source || "popup",
        (v) => { step.source = v; scheduleSave(); rerenderAll(); }
      );
      textField(container, "Ждать, мс", step.timeoutMs, (v) => { step.timeoutMs = v; scheduleSave(); });
      if (step.source === "href") {
        selectorFieldGroup(container, step);
        textField(container, "Индекс совпадения (0 — первый)", step.index, (v) => { step.index = v; scheduleSave(); });
      } else {
        hintNote(
          container,
          "Следующие шаги выполняются в новой вкладке. Если вкладка не открывается, разрешите всплывающие окна для сайта " +
            "(значок в адресной строке Chrome) или выберите вариант с href. Незакрытые вкладки закрываются в конце каждой записи цикла."
        );
      }
      break;
    case "closeTab":
      hintNote(container, "Закрывает текущую вкладку (открытую макросом) и возвращает выполнение в предыдущую.");
      break;
    case "setVar":
      textField(container, "Имя переменной", step.varName, (v) => { step.varName = v.trim(); scheduleSave(); }, "status");
      selectField(
        container,
        "Действие",
        [
          ["set", "Записать значение"],
          ["increment", "Увеличить на число (счётчик)"],
        ],
        step.mode || "set",
        (v) => { step.mode = v; scheduleSave(); }
      );
      textField(container, "Значение (можно ${переменные}; для счётчика пусто = +1)", step.value, (v) => { step.value = v; scheduleSave(); }, "", true);
      break;
    case "appendReport": {
      textField(container, "Имя файла (в папке «Загрузки»; можно ${переменные})", step.filename, (v) => { step.filename = v; scheduleSave(); }, "report.md", true);
      const header = document.createElement("textarea");
      header.rows = 2;
      header.value = step.header || "";
      header.addEventListener("input", () => { step.header = header.value; scheduleSave(); });
      field(container, "Заголовок файла (один раз в начале нового отчёта)", header, true);
      const tpl = document.createElement("textarea");
      tpl.rows = 5;
      tpl.value = step.template || "";
      tpl.placeholder = "## Строка ${_row}: ${fio}\\n- Статус: ${status}";
      tpl.addEventListener("input", () => { step.template = tpl.value; scheduleSave(); });
      field(container, "Что дописать (Markdown, можно ${переменные})", tpl, true);
      checkboxField(container, "Начинать отчёт заново при каждом запуске (иначе дописывать к накопленному)", step.resetPerRun !== false, (v) => { step.resetPerRun = v; scheduleSave(); });
      hintNote(container, "Файл сохраняется в «Загрузки» в конце запуска (в том числе при ошибке или остановке); накопленное также видно слева в «Отчёты».");
      break;
    }
    case "loopContinue":
      hintNote(container, "Пропускает остаток текущей записи цикла и переходит к следующей (обычно внутри «то» или «иначе» условия).");
      break;
    case "loopBreak":
      hintNote(container, "Прекращает цикл и переходит к шагам после него.");
      break;
    case "stopMacro":
      hintNote(container, "Завершает весь макрос (это не ошибка). Накопленные отчёты сохраняются.");
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
      hintNote(
        container,
        "Для строк таблицы поля столбцов доступны как ${имя}, плюс ${_row} (строка Excel), ${_index} и ${_total}."
      );
      textField(container, "Обработать не больше записей (0 — все; удобно для пробного прогона)", step.limit, (v) => { step.limit = v; scheduleSave(); });
      selectField(
        container,
        "Если в записи ошибка",
        [
          ["stop", "Остановить макрос"],
          ["continue", "Пропустить запись и идти дальше (шаги «При ошибке»)"],
        ],
        step.onRowError || "stop",
        (v) => { step.onRowError = v; scheduleSave(); rerenderAll(); }
      );
      checkboxField(container, "Помнить прогресс и продолжать с места остановки при следующем запуске", step.resume, (v) => { step.resume = v; scheduleSave(); rerenderAll(); });
      if (step.resume) {
        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "secondary-btn";
        resetBtn.style.cssText = "width:auto;margin:0;";
        resetBtn.textContent = "Сбросить прогресс (начать сначала)";
        resetBtn.addEventListener("click", async () => {
          const all = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY] || {};
          delete all[current.id + ":" + step.id];
          await chrome.storage.local.set({ [PROGRESS_KEY]: all });
          resetBtn.textContent = "Прогресс сброшен ✔";
        });
        container.appendChild(resetBtn);
      }
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

// ---------------- шаг «Загрузить данные из Excel/CSV» ----------------

// Разобранные книги живут только в памяти страницы конструктора (step.id -> книга) и нужны, чтобы
// менять лист/столбцы без повторного выбора файла. В макросе сохраняется только снимок данных
// (step.values для одного столбца, step.rows для таблицы построчно).
const excelCache = new Map();

function excelRows(cache, sheet) {
  if (!cache.rows.has(sheet)) cache.rows.set(sheet, sheetToRows(globalThis.XLSX, cache.wb, sheet));
  return cache.rows.get(sheet);
}

function excelGrid(cache, sheet) {
  if (!cache.grids.has(sheet)) cache.grids.set(sheet, sheetToGrid(globalThis.XLSX, cache.wb, sheet));
  return cache.grids.get(sheet);
}

const VAR_NAME_RE = /^[A-Za-z_]\w*$/;

function makeColumn(col, used) {
  return { index: col.index, header: col.header, varName: suggestVarName(col.header || col.letter, col.index, used) };
}

function recomputeExcel(step) {
  const cache = excelCache.get(step.id);
  if (!cache) return;
  const cols = listColumns(excelRows(cache, step.sheet), step.hasHeader);
  if (step.mode === "rows") {
    step.columns = (step.columns || []).filter((c) => c.index < cols.length).map((c) => ({ ...c, header: cols[c.index].header }));
    const { rows, truncated, skipped } = extractRows(excelGrid(cache, step.sheet), step);
    step.rows = rows;
    step.truncated = truncated;
    step.skipped = skipped;
    return;
  }
  const col = cols[step.colIndex] || cols[0];
  step.colIndex = col ? col.index : 0;
  step.colLabel = col ? col.header : "";
  const { values, truncated, skipped } = extractColumn(excelRows(cache, step.sheet), step);
  step.values = values;
  step.truncated = truncated;
  step.skipped = skipped;
}

async function loadExcelFile(step, file) {
  try {
    const wb = readWorkbook(globalThis.XLSX, await file.arrayBuffer(), file.name);
    if (!wb.SheetNames.length) throw new Error("в файле нет листов");
    const cache = { wb, rows: new Map(), grids: new Map() };
    excelCache.set(step.id, cache);
    // Прежние настройки применяем по возможности: лист - по имени, столбцы - по заголовку.
    step.sheet = wb.SheetNames.includes(step.sheet) ? step.sheet : wb.SheetNames[0];
    step.fileName = file.name;
    const rows = excelRows(cache, step.sheet);
    const cols = listColumns(rows, step.hasHeader);
    if (step.mode === "rows") {
      const used = [];
      step.columns = (step.columns || [])
        .map((c) => {
          const byHeader = c.header && cols.find((x) => x.header.toLowerCase() === c.header.toLowerCase());
          return { ...c, index: byHeader ? byHeader.index : c.index };
        })
        .filter((c) => c.index < cols.length);
      step.columns.forEach((c) => used.push(c.varName));
      if (!step.columns.length && cols.length) step.columns = [makeColumn(cols[Math.min(step.colIndex || 0, cols.length - 1)], used)];
    } else {
      step.colIndex = findColumnIndex(rows, step);
    }
    recomputeExcel(step);
    rerenderAll();
    scheduleSave();
  } catch (e) {
    alert("Не удалось прочитать файл: " + e.message);
  }
}

function excelSummaryText(step) {
  const rowsMode = step.mode === "rows";
  const data = rowsMode ? step.rows : step.values;
  if (!data || !data.length) {
    return step.skipped
      ? `После пропуска по длине не осталось записей (пропущено ${step.skipped}) — проверьте правила ниже.`
      : "Данных пока нет — выберите файл Excel или CSV.";
  }
  const skippedNote = step.skipped ? ` Пропущено по длине значения: ${step.skipped}.` : "";
  const src = `файл «${step.fileName}», лист «${step.sheet}»`;
  const limit = rowsMode ? MAX_ROWS : MAX_VALUES;
  const tail = skippedNote + (step.truncated ? ` ВНИМАНИЕ: список обрезан до ${limit} записей.` : "");
  if (!rowsMode) {
    const head = data.slice(0, 3).join(" · ");
    return `Сохранено значений: ${data.length} (${src}, столбец «${step.colLabel || "без заголовка"}»). Первые: ${head}${data.length > 3 ? " …" : ""}.${tail}`;
  }
  const cols = (step.columns || []).map((c) => `${c.varName} ← «${c.header || "без заголовка"}»`).join(", ");
  const first = Object.entries(data[0]).map(([k, v]) => `${k}=${v}`).join("; ");
  return `Сохранено строк: ${data.length} (${src}). Переменные: ${cols}. Первая строка: ${first}.${tail}`;
}

// Правила пропуска записей по длине значения: «пропускать, если длина значения столбца … больше/меньше/не равна N».
function renderLengthRules(step, container, rowsMode, recompute) {
  step.lengthRules = step.lengthRules || [];
  const wrap = document.createElement("div");
  wrap.style.gridColumn = "1 / -1";
  const title = document.createElement("div");
  title.className = "branch-title";
  title.textContent = "Пропускать записи по длине значения (в символах)";
  wrap.appendChild(title);

  const mkSelect = (options, value, onChange) => {
    const sel = document.createElement("select");
    sel.style.width = "auto";
    for (const [v, l] of options) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  };

  step.lengthRules.forEach((rule, i) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;font-size:13px;";
    const t1 = document.createElement("span");
    t1.textContent = rowsMode ? "Пропускать, если длина столбца" : "Пропускать, если длина значения";
    row.appendChild(t1);
    if (rowsMode) {
      const names = (step.columns || []).map((c) => [c.varName, c.varName]);
      if (rule.col && !names.some(([v]) => v === rule.col)) names.push([rule.col, rule.col + " (не выбран)"]);
      row.appendChild(mkSelect(names, rule.col, (v) => { rule.col = v; recompute(); }));
    }
    row.appendChild(mkSelect(Object.entries(LENGTH_OPS), rule.op, (v) => { rule.op = v; recompute(); }));
    const n = document.createElement("input");
    n.type = "number";
    n.min = "0";
    n.style.width = "80px";
    n.placeholder = "N";
    n.value = rule.n ?? "";
    n.addEventListener("input", () => { rule.n = n.value; recompute(); });
    row.appendChild(n);
    row.appendChild(mkSelect(Object.entries(LENGTH_COUNT), rule.count || "chars", (v) => { rule.count = v; recompute(); }));
    row.appendChild(
      mkIconBtn("×", "Удалить правило", () => {
        step.lengthRules.splice(i, 1);
        recompute();
        rerenderAll();
      })
    );
    wrap.appendChild(row);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary-btn";
  add.style.cssText = "width:auto;margin:0;";
  add.textContent = "+ Правило пропуска";
  add.addEventListener("click", () => {
    const first = (step.columns || [])[0];
    step.lengthRules.push({ col: rowsMode && first ? first.varName : "", op: "neq", n: "", count: "chars" });
    rerenderAll();
    scheduleSave();
  });
  wrap.appendChild(add);
  container.appendChild(wrap);
}

function renderLoadExcelFields(step, container) {
  const cache = excelCache.get(step.id);
  const rowsMode = step.mode === "rows";

  selectField(
    container,
    "Что загрузить",
    [
      ["column", "Один столбец → список значений"],
      ["rows", "Несколько столбцов → таблица построчно (для цикла по строкам)"],
    ],
    step.mode || "column",
    (v) => {
      step.mode = v;
      if (v === "rows" && step.varName === "list") step.varName = "rows";
      if (v === "column" && step.varName === "rows") step.varName = "list";
      if (v === "rows" && !(step.columns && step.columns.length) && cache) {
        const cols = listColumns(excelRows(cache, step.sheet), step.hasHeader);
        if (cols.length) step.columns = [makeColumn(cols[Math.min(step.colIndex || 0, cols.length - 1)], [])];
      }
      recomputeExcel(step);
      rerenderAll();
      scheduleSave();
    }
  );

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".xlsx,.xlsm,.xls,.csv,.tsv,.txt";
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) loadExcelFile(step, fileInput.files[0]);
  });
  field(container, "Файл (.xlsx, .xls, .xlsm, .csv)", fileInput);

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
        const rows = excelRows(cache, v);
        if (rowsMode) {
          const cols = listColumns(rows, step.hasHeader);
          step.columns = (step.columns || [])
            .map((c) => {
              const byHeader = c.header && cols.find((x) => x.header.toLowerCase() === c.header.toLowerCase());
              return { ...c, index: byHeader ? byHeader.index : c.index };
            })
            .filter((c) => c.index < cols.length);
        } else {
          step.colIndex = findColumnIndex(rows, step);
        }
        recomputeExcel(step);
        rerenderAll();
        scheduleSave();
      }
    );
    const cols = listColumns(excelRows(cache, step.sheet), step.hasHeader);
    if (!rowsMode) {
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
    } else {
      const wrap = document.createElement("div");
      wrap.className = "wide";
      wrap.style.gridColumn = "1 / -1";
      const title = document.createElement("div");
      title.className = "branch-title";
      title.textContent = "Столбцы: отметьте нужные и задайте имя переменной (латиница, цифры, _)";
      wrap.appendChild(title);
      step.columns = step.columns || [];
      for (const c of cols) {
        const picked = step.columns.find((x) => x.index === c.index);
        const row = document.createElement("div");
        row.className = "col-pick";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!picked;
        const name = document.createElement("span");
        name.textContent = c.label;
        const vn = document.createElement("input");
        vn.type = "text";
        vn.placeholder = "имя переменной";
        vn.value = picked ? picked.varName : "";
        vn.disabled = !picked;
        cb.addEventListener("change", () => {
          if (cb.checked) step.columns.push(makeColumn(c, step.columns.map((x) => x.varName)));
          else step.columns = step.columns.filter((x) => x.index !== c.index);
          step.columns.sort((a, b) => a.index - b.index);
          recomputeExcel(step);
          rerenderAll();
          scheduleSave();
        });
        vn.addEventListener("input", () => {
          if (!picked) return;
          const oldName = picked.varName;
          picked.varName = vn.value.trim();
          (step.lengthRules || []).forEach((r) => { if (r.col === oldName) r.col = picked.varName; });
          vn.style.borderColor = VAR_NAME_RE.test(picked.varName) ? "" : "var(--error)";
          recompute();
        });
        row.appendChild(cb);
        row.appendChild(name);
        row.appendChild(vn);
        wrap.appendChild(row);
      }
      container.appendChild(wrap);
      const bad = step.columns.filter((c) => !VAR_NAME_RE.test(c.varName));
      const dup = step.columns.length !== new Set(step.columns.map((c) => c.varName)).size;
      if (!step.columns.length) hintNote(container, "Отметьте хотя бы один столбец.").classList.add("warn");
      else if (bad.length || dup) hintNote(container, "Имена переменных должны быть уникальными: латиница, цифры и _, не с цифры.").classList.add("warn");
    }
    checkboxField(container, "Первая строка — заголовки (не входит в данные)", step.hasHeader, (v) => {
      step.hasHeader = v;
      if (rowsMode) {
        const nc = listColumns(excelRows(cache, step.sheet), v);
        step.columns = (step.columns || []).filter((c) => c.index < nc.length);
      } else {
        step.colIndex = findColumnIndex(excelRows(cache, step.sheet), { ...step, hasHeader: v });
      }
      recomputeExcel(step);
      rerenderAll();
      scheduleSave();
    });
    checkboxField(container, "Обрезать пробелы по краям", step.trim, (v) => { step.trim = v; recompute(); });
    checkboxField(
      container,
      rowsMode ? "Пропускать строки, где все выбранные ячейки пустые" : "Пропускать пустые ячейки",
      step.skipEmpty,
      (v) => { step.skipEmpty = v; recompute(); }
    );
    checkboxField(container, rowsMode ? "Только уникальные строки" : "Только уникальные значения", step.unique, (v) => { step.unique = v; recompute(); });
    renderLengthRules(step, container, rowsMode, recompute);
  } else if ((rowsMode ? step.rows : step.values) && (rowsMode ? step.rows : step.values).length) {
    hintNote(container, "Чтобы сменить лист, столбцы или обновить данные, выберите файл заново — прежние настройки подставятся сами.");
  }

  textField(
    container,
    rowsMode
      ? "Сохранить таблицу в переменную (дальше — «Для каждого значения из списка» с этой переменной)"
      : "Сохранить список в переменную (дальше — «Для каждого значения из списка»)",
    step.varName,
    (v) => { step.varName = v.trim(); scheduleSave(); },
    rowsMode ? "rows" : "list",
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

// Один обработчик для «Импорт JSON» и «Загрузить конфиг»: понимает и конфиг целиком, и экспорт одного макроса.
async function importFromFile(input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const parsed = parseImport(JSON.parse(await file.text()));
    let info;
    if (parsed.kind === "config") {
      const keep = current && current.id;
      const merged = mergeConfig(allMacros, parsed.macros);
      allMacros = merged.macros;
      current = allMacros.find((m) => m.id === keep) || allMacros[allMacros.length - 1];
      info = `Конфиг загружен: добавлено макросов ${merged.added}, заменено ${merged.replaced}.`;
    } else {
      const copies = importAsCopies(parsed.macros);
      allMacros.push(...copies);
      current = copies[copies.length - 1];
      info = `Импортировано макросов: ${copies.length}.`;
    }
    await saveMacros(allMacros);
    history.replaceState(null, "", "?m=" + current.id);
    renderSidebar();
    renderMacro();
    configHint.textContent = info;
  } catch (e) {
    alert("Не удалось прочитать файл: " + e.message);
  } finally {
    input.value = "";
  }
}
importInput.addEventListener("change", () => importFromFile(importInput));
loadConfigInput.addEventListener("change", () => importFromFile(loadConfigInput));

// ---------------- конфиг: сохранить все макросы в файл ----------------

function downloadText(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.split("/").pop();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

saveConfigBtn.addEventListener("click", () => {
  const includeData = cfgIncludeData.checked;
  const cfg = buildConfig(allMacros, { includeData });
  downloadText(`macro-builder-config-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(cfg, null, 2), "application/json");
  configHint.textContent =
    `Сохранено макросов: ${cfg.macros.length}` +
    (includeData ? " (вместе с данными таблиц — файл содержит персональные данные, не пересылайте его)." : "; данные таблиц в файл не попали — после загрузки выберите файл Excel в шаге заново.");
});

// ---------------- отчёты (MD), накопленные запусками ----------------

async function renderReports() {
  const all = (await chrome.storage.local.get(REPORTS_KEY))[REPORTS_KEY] || {};
  reportsList.innerHTML = "";
  const names = Object.keys(all).sort();
  reportsHint.style.display = names.length ? "none" : "block";
  for (const name of names) {
    const r = all[name];
    const row = document.createElement("div");
    row.className = "pool-row";
    const kb = (new TextEncoder().encode(r.text || "").length / 1024).toFixed(1);
    row.innerHTML = `<span class="pool-name-wrap"><span class="pool-name">${escapeHtml(name)}</span><span class="pool-hint">${kb} КБ · ${escapeHtml(
      new Date(r.updatedAt || 0).toLocaleString("ru-RU")
    )}</span></span>`;
    row.appendChild(mkIconBtn("⬇", "Скачать .md", () => downloadText(name, r.text || "", "text/markdown")));
    row.appendChild(
      mkIconBtn("×", "Удалить накопленный отчёт", async () => {
        if (!confirm(`Удалить накопленный отчёт «${name}»?`)) return;
        const cur = (await chrome.storage.local.get(REPORTS_KEY))[REPORTS_KEY] || {};
        delete cur[name];
        await chrome.storage.local.set({ [REPORTS_KEY]: cur });
      })
    );
    reportsList.appendChild(row);
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[REPORTS_KEY]) renderReports();
});

// ---------------- переменные: клик вставляет ${имя} в последнее выбранное поле ----------------

let lastField = null;
stepsRoot.addEventListener("focusin", (e) => {
  if (e.target.matches && e.target.matches("input[type=text], textarea")) lastField = e.target;
});
stepsRoot.addEventListener("change", () => renderVarsBar());

function collectVarNames() {
  const names = new Set(["_row", "_index", "_total", "_error", "_now", "_date", "_time"]);
  for (const i of (current && current.inputs) || []) if (i.key) names.add(i.key);
  (function walk(arr) {
    for (const st of arr || []) {
      if (st.type === "loadExcel" && st.mode === "rows") (st.columns || []).forEach((c) => c.varName && names.add(c.varName));
      if (["extract", "extractTable", "setVar"].includes(st.type) && st.varName) names.add(st.varName);
      if (st.type === "customJs" && st.saveTo) names.add(st.saveTo);
      if (["loopList", "loopCount"].includes(st.type) && st.itemVar) names.add(st.itemVar);
      walk(st.steps);
      walk(st.then);
      walk(st.else);
      walk(st.catchSteps);
    }
  })(current && current.steps);
  return [...names];
}

function insertAtCaret(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + text.length;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

function renderVarsBar() {
  varsBar.innerHTML = "";
  if (!current) return;
  const label = document.createElement("span");
  label.textContent = "Переменные:";
  varsBar.appendChild(label);
  for (const name of collectVarNames()) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "var-chip";
    chip.textContent = "${" + name + "}";
    chip.addEventListener("mousedown", (e) => e.preventDefault()); // не отнимать фокус у поля
    chip.addEventListener("click", () => {
      if (lastField && document.contains(lastField)) insertAtCaret(lastField, "${" + name + "}");
    });
    varsBar.appendChild(chip);
  }
}

init();
renderReports();
