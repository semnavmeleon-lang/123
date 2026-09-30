// Конструктор макросов. Три зоны: список макросов (слева), структура макроса - дерево шагов (центр)
// и свойства выбранного шага или макроса (справа). Внизу - панель хода выполнения.

import { loadMacros, saveMacros, newMacro, uid, defaultStep, newTrigger, TRIGGER_LABELS, REPORTS_KEY, PROGRESS_KEY, progressKey, loadProgressAll, resetProgress, substitute } from "./common.js";
import { buildConfig, parseImport, mergeConfig, importAsCopies, progressSummary } from "./logic.js";
import { h, clear, textInput, checkbox, segmented, button, iconButton, popover, menuList, modal, confirmDialog, toast, downloadText } from "./ui/dom.js";
import { STEP_META, PALETTE, CATEGORIES, stepTitle, describeStep, validateStep, validateMacro, collectVars, collectValueSources, buildSampleVars, describeSampleVars, scopeIssues, resumeLoops, resumableProgress, describeProgress, pluralRu, walkSteps } from "./ui/meta.js";
import { stepBody, hasBody, branchesOf } from "./ui/editors.js";

const sideEl = document.getElementById("side");
const mainEl = document.getElementById("main");
const editorEl = document.getElementById("editor");

let allMacros = [];
let current = null;
let selectedId = null; // id шага или "macro" (настройки макроса)
let run = null; // { runId, macroId }
let recording = false;
let pickState = null;
let reportsCount = 0;
let targetTabId = null;
let saveTimer = null;
const rows = new Map(); // step.id -> { row, detail, warn, step }
const ui = {};

const dlLists = h("datalist", { id: "dl-lists" });
document.body.append(dlLists);
const importInput = h("input", { type: "file", accept: "application/json", style: "display:none", "data-role": "import-file" });
document.body.append(importInput);

// ---------------- сохранение ----------------

async function persist() {
  saveTimer = null;
  if (!current) return;
  current.updatedAt = Date.now();
  const i = allMacros.findIndex((m) => m.id === current.id);
  if (i === -1) allMacros.push(current);
  else allMacros[i] = current;
  await saveMacros(allMacros);
  renderSide();
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
}
async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    await persist();
  }
}
// Любое изменение в редакторе: сохранить и обновить описания шагов, статус и подсказки
function touch() {
  scheduleSave();
  refreshRows();
  refreshStatus();
  refreshDatalist();
  if (progressViews.size) refreshProgressViews();
}

// ---------------- поиск шага в макросе ----------------

function locate(id) {
  let found = null;
  (function visit(arr, path, parent) {
    arr.forEach((step, idx) => {
      if (found) return;
      const p = [...path, idx + 1];
      if (step.id === id) {
        found = { arr, idx, step, path: p, parent };
        return;
      }
      for (const b of branchesOf(step)) visit(b.arr, p, { arr, idx, step });
    });
  })(current.steps, [], null);
  return found;
}

// Откуда цикл «Для каждой записи» берёт список по умолчанию: таблица из «Данных из Excel/CSV», иначе первый список
function defaultLoopSource() {
  let table = "";
  walkSteps(current.steps, (s) => { if (!table && s.type === "loadExcel" && s.mode === "rows" && s.varName) table = s.varName; });
  return table || collectVars(current).lists[0] || "";
}

// Поместить шаг и все шаги ниже него (на этом же уровне) в новый цикл «Для каждой записи»
function wrapInLoop({ arr, idx }) {
  const loop = defaultStep("loopList");
  loop.sourceKey = defaultLoopSource();
  loop.steps = arr.splice(idx);
  arr.push(loop);
  touch();
  renderTree();
  renderInspector();
  toast(`В цикл помещено шагов: ${loop.steps.length}`, "ok");
}

// Вынести шаг из цикла или условия: он встанет сразу после него
function moveOut({ arr, idx, parent }) {
  const [step] = arr.splice(idx, 1);
  parent.arr.splice(parent.idx + 1, 0, step);
  touch();
  renderTree();
  renderInspector();
}

// ---------------- API для редакторов шагов ----------------

const api = {
  save: touch,
  rerender: () => {
    renderTree();
    renderInspector();
  },
  toast,
  valueSources: () => collectValueSources(current),
  pick: (target, refs, opts) => pickElement(target, refs, opts),
  highlight: (target, refs, opts) => highlightOnPage(target, refs, opts),
  bindProgress(step, line, resetBtn) {
    progressViews.add({ step, line, resetBtn });
    resetBtn.addEventListener("click", async () => {
      await resetProgress(current.id, step.id);
      toast("Прогресс сброшен: следующий запуск начнётся с первой записи", "ok");
      refreshProgressViews();
    });
    refreshProgressViews();
  },
};

// Строки «обработано N из M» в панели цикла обновляются сами: при правке таблицы и во время запуска
const progressViews = new Set();
async function refreshProgressViews() {
  const all = await loadProgressAll();
  for (const v of [...progressViews]) if (!v.line.isConnected) progressViews.delete(v);
  if (!current) return;
  const loops = resumeLoops(current);
  for (const v of progressViews) {
    const found = loops.find((x) => x.step === v.step);
    const sum = progressSummary(all[progressKey(current.id, v.step.id)], found ? found.list : null);
    const d = describeProgress(sum);
    v.line.className = "result-line " + (d.kind === "ok" ? "" : d.kind);
    v.line.textContent = d.text;
    v.resetBtn.disabled = !sum;
  }
}

// ---------------- список макросов ----------------

function renderSide() {
  clear(sideEl);
  const list = h("div", { class: "macro-list", role: "list", "data-role": "macro-list" });
  for (const m of allMacros) {
    const n = (m.steps || []).length;
    const item = h(
      "button",
      { type: "button", class: "macro-item" + (current && m.id === current.id ? " active" : ""), "data-macro-id": m.id },
      h("span", { class: "macro-name" }, m.name || "Без имени"),
      h("span", { class: "macro-sub" }, `${n} ${pluralRu(n, "шаг", "шага", "шагов")}`)
    );
    item.addEventListener("click", () => selectMacro(m.id));
    list.append(item);
  }
  const reports = button(reportsCount ? `Отчёты (${reportsCount})` : "Отчёты", { onClick: openReports });
  reports.dataset.role = "reports-link";
  sideEl.append(
    h("div", { class: "side-title" }, "Макросы"),
    list,
    h("div", { class: "side-foot" }, button("Новый макрос", { kind: "primary", onClick: openTemplates }), h("div", { class: "side-links" }, reports, button("Конфиг", { onClick: openConfig })))
  );
}

async function selectMacro(id) {
  await flush();
  current = allMacros.find((m) => m.id === id) || null;
  selectedId = null;
  history.replaceState(null, "", current ? "?m=" + current.id : location.pathname);
  renderAll();
}

// ---------------- шаблоны нового макроса ----------------

const TEMPLATES = [
  { id: "blank", name: "Пустой макрос", sub: "Собрать шаги с нуля" },
  { id: "excel-obzvon.json", name: "Обзвон по столбцу Excel", sub: "Номера из файла, набор на IP-телефоне" },
  { id: "proverka-strok.json", name: "Проверка строк таблицы на сайте", sub: "Поиск, сравнение, карточка в новой вкладке, отчёт" },
];

async function createFromTemplate(id) {
  let macro;
  if (id === "blank") {
    macro = newMacro("Новый макрос");
  } else {
    try {
      const data = await (await fetch(chrome.runtime.getURL("examples/" + id))).json();
      macro = importAsCopies(parseImport(data).macros)[0];
    } catch (e) {
      toast("Не удалось загрузить шаблон: " + e.message, "error");
      return;
    }
  }
  await flush();
  allMacros.push(macro);
  current = macro;
  selectedId = null;
  await saveMacros(allMacros);
  history.replaceState(null, "", "?m=" + macro.id);
  renderAll();
}

function templateList(onPick) {
  const list = h("div", { class: "tpl-list", "data-role": "templates" });
  for (const t of TEMPLATES) {
    const r = h("button", { type: "button", class: "tpl-row", "data-template": t.id }, h("span", {}, h("span", { class: "t-name" }, t.name), h("span", { class: "t-sub" }, t.sub)));
    r.addEventListener("click", () => onPick(t.id));
    list.append(r);
  }
  const imp = h("button", { type: "button", class: "tpl-row" }, h("span", {}, h("span", { class: "t-name" }, "Загрузить из файла"), h("span", { class: "t-sub" }, "Экспорт макроса или конфиг")));
  imp.addEventListener("click", () => importInput.click());
  list.append(imp);
  return list;
}

function openTemplates() {
  const m = modal({ title: "Новый макрос", body: templateList(async (id) => { m.close(); await createFromTemplate(id); }) });
}

// ---------------- рабочая область ----------------

function renderAll() {
  renderSide();
  renderMain();
}

function renderMain() {
  clear(editorEl);
  rows.clear();
  if (!current) {
    editorEl.append(h("div", { class: "empty-start" }, h("h1", {}, "Макросов пока нет"), h("p", { class: "muted" }, "Создайте макрос из шаблона или загрузите его из файла."), templateList((id) => createFromTemplate(id))));
    return;
  }
  current.inputs = current.inputs || [];
  current.triggers = current.triggers || [];
  current.steps = current.steps || [];

  const title = textInput({ value: current.name, placeholder: "Название макроса", onInput: (v) => { current.name = v; scheduleSave(); } });
  title.className = "macro-title";
  title.setAttribute("aria-label", "Название макроса");
  title.dataset.role = "macro-title";
  ui.status = h("button", { type: "button", class: "status", "data-role": "status" });
  ui.runBtn = button("Запустить", { kind: "primary", onClick: startRun });
  ui.runBtn.dataset.role = "run";
  ui.stopBtn = button("Остановить", { kind: "danger", onClick: stopRun });
  ui.stopBtn.dataset.role = "stop";
  const more = button("Действия", {});
  more.dataset.role = "more";
  more.addEventListener("click", () => {
    const pop = popover(
      more,
      menuList(
        [
          { label: "Дублировать макрос", onClick: duplicateMacro },
          { label: "Экспортировать в JSON", onClick: exportMacro },
          { label: "Импортировать из JSON...", onClick: () => importInput.click() },
          "-",
          { label: "Удалить макрос", danger: true, onClick: deleteMacro },
        ],
        () => pop.close()
      ),
      { align: "right" }
    );
  });

  ui.tabSelect = h("select", { "data-role": "tab-select", "aria-label": "Рабочая вкладка" });
  ui.tabSelect.addEventListener("change", () => { targetTabId = ui.tabSelect.value ? Number(ui.tabSelect.value) : null; });
  refreshTabs();

  ui.tree = h("div", { class: "tree", "data-role": "steps", role: "tree" });
  ui.tree.addEventListener("keydown", onTreeKey);
  ui.count = h("span", { class: "count" });
  ui.recordBtn = button(recording ? "Остановить запись" : "Записать действия", { tip: "Кликайте по сайту на рабочей вкладке: шаги добавятся сами", onClick: toggleRecording });
  ui.inspector = h("section", { class: "pane inspector", "data-role": "inspector" });

  editorEl.append(
    h("div", { class: "toolbar" }, title, ui.status, h("div", { class: "spacer" }), ui.stopBtn, ui.runBtn, more),
    h("div", { class: "tabbar" }, h("span", { class: "lbl" }, "Рабочая вкладка:"), ui.tabSelect, button("Обновить", { kind: "small", onClick: refreshTabs })),
    h(
      "div",
      { class: "workspace" },
      h("section", { class: "pane structure" }, h("div", { class: "pane-head" }, h("h2", {}, "Структура"), ui.count, h("div", { class: "spacer" }), ui.recordBtn), ui.tree),
      ui.inspector
    )
  );
  updateRunButtons();
  if (!selectedId || (selectedId !== "macro" && !locate(selectedId))) selectedId = current.steps.length ? current.steps[0].id : "macro";
  renderTree();
  renderInspector();
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  clear(ui.tabSelect);
  for (const t of tabs) {
    if (!t.url || /^(chrome|edge|chrome-extension):\/\//.test(t.url)) continue;
    ui.tabSelect.append(h("option", { value: t.id }, (t.title || t.url).slice(0, 80)));
  }
  if (!ui.tabSelect.options.length) ui.tabSelect.append(h("option", { value: "" }, "нет подходящих вкладок: откройте нужный сайт"));
  if (targetTabId && Array.from(ui.tabSelect.options).some((o) => o.value === String(targetTabId))) ui.tabSelect.value = String(targetTabId);
  else targetTabId = ui.tabSelect.value ? Number(ui.tabSelect.value) : null;
}

const getTargetTabId = () => (ui.tabSelect && ui.tabSelect.value ? Number(ui.tabSelect.value) : null);

// ---------------- дерево шагов ----------------

function selectStep(id, focus) {
  selectedId = id;
  renderTree();
  renderInspector();
  if (focus) {
    const r = ui.tree.querySelector(".tree-row.selected");
    if (r) r.focus();
  }
}

function onTreeKey(e) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const list = Array.from(ui.tree.querySelectorAll(".tree-row"));
  const i = list.findIndex((r) => r.classList.contains("selected"));
  const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
  if (!next) return;
  e.preventDefault();
  selectStep(next.dataset.stepId || "macro", true);
}

function renderTree() {
  rows.clear();
  clear(ui.tree);
  ui.count.textContent = current.steps.length ? `(${current.steps.length})` : "";
  ui.tree.append(settingsRow());
  renderList(current.steps, ui.tree, true);
  refreshRows();
  refreshStatus();
  refreshDatalist();
}

function settingsRow() {
  const parts = [];
  if (current.inputs.length) parts.push(`параметров: ${current.inputs.length}`);
  const auto = current.triggers.filter((t) => t.enabled).length;
  if (auto) parts.push(`автозапуск: ${auto}`);
  if (current.openInNewTab) parts.push("в новой вкладке");
  const row = h(
    "div",
    { class: "tree-row settings-row" + (selectedId === "macro" ? " selected" : ""), role: "treeitem", tabindex: "0", "data-role": "settings-row" },
    h("span", { class: "tr-num" }, ""),
    h("span", { class: "tr-title" }, "Настройки макроса"),
    h("span", { class: "tr-detail" }, parts.join(" · ")),
    h("span", {})
  );
  row.addEventListener("click", () => selectStep("macro"));
  return row;
}

function renderList(arr, container, top = false) {
  if (!arr.length && top) {
    container.append(
      h(
        "div",
        { class: "tree-empty" },
        h("div", {}, "В макросе пока нет шагов."),
        (() => {
          const b = button("Добавить первый шаг", { kind: "primary" });
          b.dataset.role = "add-first";
          b.addEventListener("click", () => openPalette(b, arr));
          return b;
        })()
      )
    );
    return;
  }
  arr.forEach((s, i) => {
    container.append(stepRow(s, i));
    const branches = branchesOf(s);
    if (branches.length) {
      const wrap = h("div", { class: "tree-children" });
      for (const b of branches) {
        wrap.append(h("div", { class: "tree-branch-label", "data-kind": b.kind }, b.label));
        const inner = h("div", { "data-branch": b.kind });
        renderList(b.arr, inner);
        wrap.append(inner);
      }
      container.append(wrap);
    }
  });
  const add = h("button", { type: "button", class: "tree-add", "data-role": "add-step" }, "Добавить шаг");
  add.addEventListener("click", () => openPalette(add, arr));
  container.append(add);
}

function stepRow(step, idx) {
  const row = h(
    "div",
    { class: "tree-row" + (selectedId === step.id ? " selected" : ""), role: "treeitem", tabindex: "0", "data-step-id": step.id, "data-step-type": step.type, "data-role": "step-row" },
    h("span", { class: "tr-num" }, idx + 1),
    h("span", { class: "tr-title" }, stepTitle(step.type)),
    h("span", { class: "tr-detail" }),
    h("span", { class: "tr-warn" })
  );
  row.addEventListener("click", () => selectStep(step.id));
  rows.set(step.id, { row, detail: row.children[2], warn: row.children[3], step });
  return row;
}

// Строка дерева показывает, что делает шаг, и что в нём не заполнено
function refreshRows() {
  // переменные, которых на этом месте ещё нет (например, столбец таблицы вне цикла)
  const scope = new Map();
  for (const i of scopeIssues(current)) scope.set(i.stepId, [...(scope.get(i.stepId) || []), i.message]);
  for (const { detail, warn, step } of rows.values()) {
    detail.textContent = describeStep(step);
    const issues = validateStep(step);
    const missing = scope.get(step.id) || [];
    warn.textContent = issues.length ? "Не заполнено" : missing.length ? "Нет данных" : "";
    warn.title = [...issues, ...missing].join("\n");
  }
  const note = ui.inspector && ui.inspector.querySelector('[data-role="scope-warn"]');
  if (note && selectedId && selectedId !== "macro") {
    const msgs = scope.get(selectedId) || [];
    note.textContent = msgs.join("\n");
    note.hidden = !msgs.length;
  }
  const settings = ui.tree && ui.tree.querySelector(".settings-row .tr-detail");
  if (settings) {
    const parts = [];
    if (current.inputs.length) parts.push(`параметров: ${current.inputs.length}`);
    const auto = current.triggers.filter((t) => t.enabled).length;
    if (auto) parts.push(`автозапуск: ${auto}`);
    if (current.openInNewTab) parts.push("в новой вкладке");
    settings.textContent = parts.join(" · ");
  }
}

function refreshStatus() {
  const el = ui.status;
  if (!el || !current) return;
  const issues = validateMacro(current);
  el.onclick = null;
  el.title = "";
  if (!current.steps.length) {
    el.className = "status none";
    el.textContent = "Нет шагов";
  } else if (issues.length) {
    el.className = "status warn";
    el.textContent = `Замечаний: ${issues.length}`;
    el.title = issues.slice(0, 8).map((i) => `${i.path}. ${i.message}`).join("\n");
    el.onclick = () => jumpTo(issues[0].stepId);
  } else {
    el.className = "status ok";
    el.textContent = "Готов к запуску";
  }
}

function jumpTo(stepId) {
  selectStep(stepId);
  const r = rows.get(stepId);
  if (r) r.row.scrollIntoView({ block: "center" });
}

function refreshDatalist() {
  if (!current) return;
  clear(dlLists);
  for (const n of collectVars(current).lists) dlLists.append(h("option", { value: n }));
}

// ---------------- палитра шагов ----------------

function addStep(arr, type) {
  const s = defaultStep(type);
  if (type === "loopList") s.sourceKey = defaultLoopSource() || s.sourceKey;
  arr.push(s);
  selectedId = s.id;
  renderTree();
  renderInspector();
  touch();
  requestAnimationFrame(() => {
    const r = rows.get(s.id);
    if (r) r.row.scrollIntoView({ block: "nearest" });
  });
}

function openPalette(anchor, arr) {
  const search = textInput({ placeholder: "Найти шаг" });
  search.classList.add("palette-search");
  search.dataset.role = "palette-search";
  const list = h("div");
  const box = h("div", { class: "palette", "data-role": "palette" }, search, list);
  let pop;
  const draw = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    let first = true;
    for (const g of PALETTE) {
      const items = g.types.filter((t) => !q || stepTitle(t).toLowerCase().includes(q) || STEP_META[t].tip.toLowerCase().includes(q));
      if (!items.length) continue;
      list.append(h("div", { class: "palette-cat" }, CATEGORIES[g.cat].label));
      for (const t of items) {
        const b = h("button", { type: "button", class: "palette-item" + (first ? " first" : ""), title: STEP_META[t].tip, "data-add": t }, stepTitle(t));
        b.addEventListener("click", () => {
          pop.close();
          addStep(arr, t);
        });
        list.append(b);
        first = false;
      }
    }
    if (first) list.append(h("div", { class: "palette-empty" }, "Ничего не найдено"));
  };
  search.addEventListener("input", draw);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const f = list.querySelector(".palette-item");
      if (f) f.click();
    }
  });
  draw();
  pop = popover(anchor, box);
  pop.place();
  search.focus();
}

// ---------------- панель свойств ----------------

function renderInspector() {
  clear(ui.inspector);
  if (selectedId === "macro") {
    ui.inspector.append(
      h("div", { class: "insp-head" }, h("div", { class: "insp-crumb" }, "Макрос"), h("div", { class: "insp-title" }, "Настройки макроса")),
      h("div", { class: "insp-body", "data-role": "inspector-body" }, macroSettings())
    );
    return;
  }
  const loc = selectedId ? locate(selectedId) : null;
  if (!loc) {
    ui.inspector.append(h("div", { class: "insp-empty" }, "Выберите шаг в структуре слева."));
    return;
  }
  const { arr, idx, step, path, parent } = loc;
  const move = (d) => {
    const j = idx + d;
    if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    touch();
    renderTree();
    renderInspector();
  };
  const actions = h(
    "div",
    { class: "insp-actions" },
    button("Проверить шаг", { kind: "small", tip: "Выполнить только этот шаг на рабочей вкладке", onClick: () => runSingleStep(step) }),
    button("Вверх", { kind: "small", disabled: idx === 0, onClick: () => move(-1) }),
    button("Вниз", { kind: "small", disabled: idx === arr.length - 1, onClick: () => move(1) }),
    button("В цикл", { kind: "small", tip: "Поместить этот шаг и все шаги ниже в цикл «Для каждой записи» (нужно, чтобы использовать столбцы таблицы)", onClick: () => wrapInLoop(loc) }),
    parent ? button("Вынести", { kind: "small", tip: "Вынести шаг из цикла или условия: он встанет сразу после него", onClick: () => moveOut(loc) }) : null,
    button("Копировать", { kind: "small", onClick: () => { const c = cloneStep(step); arr.splice(idx + 1, 0, c); selectedId = c.id; touch(); renderTree(); renderInspector(); } }),
    button("Удалить", { kind: "small danger", onClick: () => { arr.splice(idx, 1); selectedId = arr[Math.min(idx, arr.length - 1)] ? arr[Math.min(idx, arr.length - 1)].id : "macro"; touch(); renderTree(); renderInspector(); } })
  );
  ui.inspector.append(
    h("div", { class: "insp-head" }, h("div", { class: "insp-crumb" }, "Шаг " + path.join(".")), h("div", { class: "insp-title" }, stepTitle(step.type)), actions),
    h(
      "div",
      { class: "insp-body", "data-role": "inspector-body" },
      h("div", { class: "scope-warn", "data-role": "scope-warn", hidden: true }),
      hasBody(step) ? stepBody(step, api) : h("div", { class: "muted" }, "У этого шага нет настроек.")
    )
  );
  refreshRows();
}

function cloneStep(step) {
  const copy = JSON.parse(JSON.stringify(step));
  (function fresh(s) {
    s.id = uid();
    for (const k of ["steps", "then", "else", "catchSteps"]) (s[k] || []).forEach(fresh);
  })(copy);
  return copy;
}

// ---------------- настройки макроса (параметры, автозапуск) ----------------

function macroSettings() {
  const inputsBox = h("div", { class: "stack" });
  const drawInputs = () => {
    clear(inputsBox);
    current.inputs.forEach((inp, i) => {
      inputsBox.append(
        h(
          "div",
          { class: "param-row" },
          textInput({ value: inp.key, placeholder: "имя, например phones", mono: true, onInput: (v) => { inp.key = v.trim(); touch(); } }),
          textInput({ value: inp.label, placeholder: "подпись при запуске", onInput: (v) => { inp.label = v; scheduleSave(); } }),
          checkbox("список", inp.multiline, (v) => { inp.multiline = v; touch(); }, { tip: "Несколько значений: по одному в строке" }),
          textInput({ value: inp.default, placeholder: "по умолчанию", onInput: (v) => { inp.default = v; scheduleSave(); } }),
          iconButton("×", "Удалить параметр", () => { current.inputs.splice(i, 1); touch(); drawInputs(); })
        )
      );
    });
    inputsBox.append(h("div", {}, button("Добавить параметр", { onClick: () => { current.inputs.push({ key: "param" + (current.inputs.length + 1), label: "", multiline: false, default: "" }); touch(); drawInputs(); } })));
  };
  drawInputs();

  const trigBox = h("div", { class: "stack" });
  const sync = () => chrome.runtime.sendMessage({ action: "syncAlarms" }).catch(() => {});
  const drawTriggers = () => {
    clear(trigBox);
    current.triggers.forEach((t, i) => {
      const row = h("div", { class: "trigger-row" }, checkbox("", t.enabled, (v) => { t.enabled = v; touch(); sync(); }, { tip: "Включён" }), h("strong", {}, TRIGGER_LABELS[t.type] || t.type));
      if (t.type === "interval") row.append(textInput({ type: "number", min: 1, value: t.everyMinutes, onInput: (v) => { t.everyMinutes = v; scheduleSave(); sync(); } }), h("span", {}, "мин"));
      if (t.type === "daily") row.append(textInput({ type: "time", value: t.atTime || "09:00", onInput: (v) => { t.atTime = v; scheduleSave(); sync(); } }));
      if (t.type === "urlMatch") row.append(textInput({ value: t.pattern, placeholder: "https://example.com/orders*", mono: true, onInput: (v) => { t.pattern = v; scheduleSave(); } }));
      row.append(h("div", { class: "spacer" }), iconButton("×", "Удалить автозапуск", () => { current.triggers.splice(i, 1); touch(); sync(); drawTriggers(); }));
      trigBox.append(row);
    });
    const add = button("Добавить автозапуск", {});
    add.addEventListener("click", () => {
      const pop = popover(
        add,
        menuList(Object.entries(TRIGGER_LABELS).map(([type, label]) => ({ label, onClick: () => { current.triggers.push(newTrigger(type)); touch(); sync(); drawTriggers(); } })), () => pop.close())
      );
    });
    trigBox.append(h("div", {}, add));
  };
  drawTriggers();

  return [
    h("div", { class: "section" }, h("div", { class: "section-title" }, "Запуск"), checkbox("Запускать в новой вкладке", current.openInNewTab, (v) => { current.openInNewTab = v; touch(); })),
    h("div", { class: "section" }, h("div", { class: "section-title" }, "Параметры запуска"), inputsBox),
    h("div", { class: "section" }, h("div", { class: "section-title" }, "Автозапуск"), trigBox),
  ];
}

// ---------------- действия над макросом ----------------

async function duplicateMacro() {
  await flush();
  const copy = JSON.parse(JSON.stringify(current));
  copy.id = uid("m");
  copy.name = (current.name || "Без имени") + " (копия)";
  allMacros.push(copy);
  current = copy;
  selectedId = null;
  await saveMacros(allMacros);
  history.replaceState(null, "", "?m=" + copy.id);
  renderAll();
  toast("Копия создана", "ok");
}

function exportMacro() {
  downloadText((current.name || "macro").replace(/[\\/:*?"<>|]/g, "_") + ".json", JSON.stringify([current], null, 2), "application/json");
}

async function deleteMacro() {
  if (!(await confirmDialog(`Удалить макрос «${current.name || "Без имени"}»?`, { okText: "Удалить", danger: true, title: "Удаление" }))) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  allMacros = allMacros.filter((m) => m.id !== current.id);
  await saveMacros(allMacros);
  current = allMacros[0] || null;
  selectedId = null;
  history.replaceState(null, "", current ? "?m=" + current.id : location.pathname);
  renderAll();
}

// Один обработчик для «Импорт JSON» и «Загрузить конфиг»: понимает и конфиг целиком, и экспорт одного макроса
async function importFromFile(input, onDone) {
  const file = input.files[0];
  if (!file) return;
  try {
    await flush();
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
    selectedId = null;
    history.replaceState(null, "", "?m=" + current.id);
    renderAll();
    toast(info, "ok");
    if (onDone) onDone(info);
  } catch (e) {
    toast("Не удалось прочитать файл: " + e.message, "error");
  } finally {
    input.value = "";
  }
}
importInput.addEventListener("change", () => importFromFile(importInput));

// ---------------- отчёты и конфиг ----------------

async function refreshReportsCount() {
  const all = (await chrome.storage.local.get(REPORTS_KEY))[REPORTS_KEY] || {};
  reportsCount = Object.keys(all).length;
  renderSide();
}

function openReports() {
  const box = h("div", { "data-role": "reports" });
  const draw = async () => {
    const all = (await chrome.storage.local.get(REPORTS_KEY))[REPORTS_KEY] || {};
    const names = Object.keys(all).sort();
    clear(box);
    if (!names.length) {
      box.append(h("div", { class: "empty-note" }, "Накопленных отчётов пока нет"));
      return;
    }
    const list = h("div", { class: "list-rows" });
    for (const name of names) {
      const r = all[name];
      const kb = (new TextEncoder().encode(r.text || "").length / 1024).toFixed(1);
      list.append(
        h(
          "div",
          { class: "list-row", "data-report": name },
          h("div", { class: "grow" }, h("div", {}, name), h("div", { class: "sub" }, `${kb} КБ, ${new Date(r.updatedAt || 0).toLocaleString("ru-RU")}`)),
          button("Скачать", { kind: "small", onClick: () => downloadText(name, r.text || "", "text/markdown") }),
          button("Удалить", { kind: "small danger", onClick: async () => {
            if (!(await confirmDialog(`Удалить накопленный отчёт «${name}»?`, { okText: "Удалить", danger: true }))) return;
            const cur = (await chrome.storage.local.get(REPORTS_KEY))[REPORTS_KEY] || {};
            delete cur[name];
            await chrome.storage.local.set({ [REPORTS_KEY]: cur });
            draw();
          } })
        )
      );
    }
    box.append(list);
  };
  draw();
  modal({ title: "Отчёты (MD)", body: box });
}

function openConfig() {
  let includeData = false;
  const status = h("div", { class: "plain", "data-role": "config-status" });
  const file = h("input", { type: "file", accept: "application/json", style: "display:none", "data-role": "config-file" });
  file.addEventListener("change", () => importFromFile(file, (info) => { status.textContent = info; }));
  const save = () => {
    const cfg = buildConfig(allMacros, { includeData });
    downloadText(`macro-builder-config-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(cfg, null, 2), "application/json");
    status.textContent = `Сохранено макросов: ${cfg.macros.length}` + (includeData ? " (с данными таблиц: файл содержит персональные данные)." : "; данные таблиц в файл не попали.");
  };
  const saveBtn = button("Сохранить в файл", { kind: "primary", onClick: save });
  saveBtn.dataset.role = "config-save";
  modal({
    title: "Конфиг",
    body: h(
      "div",
      { class: "form-grid" },
      checkbox("Включить данные таблиц (персональные данные клиентов)", false, (v) => { includeData = v; }),
      h("div", { class: "row" }, saveBtn, button("Загрузить из файла", { onClick: () => file.click() }), file),
      status
    ),
  });
}

// ---------------- выбор и подсветка элементов на странице, запись действий ----------------

async function ensureContent(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {}
}

async function pickElement(target, refs, opts = {}) {
  const tabId = getTargetTabId();
  if (!tabId) {
    toast("Выберите рабочую вкладку вверху страницы", "error");
    return;
  }
  await ensureContent(tabId);
  pickState = { target, refs };
  chrome.tabs.sendMessage(tabId, { action: "startPicker", inputOnly: !!opts.inputOnly });
  chrome.tabs.update(tabId, { active: true });
}

// Значения для подстановки в селектор при подсветке и при «Проверить шаг»: первая запись загруженной таблицы
function sampleVars() {
  return buildSampleVars(current);
}

async function highlightOnPage(target, refs, opts = {}) {
  const tabId = getTargetTabId();
  if (!tabId) {
    toast("Выберите рабочую вкладку вверху страницы", "error");
    return;
  }
  const k = refs.keys;
  const vars = sampleVars();
  const step = {
    selectorType: target[k.type] || "css",
    selector: substitute(target[k.sel] || "", vars),
    scopeSelector: target.scopeSelector || "",
    scopeText: substitute(target.scopeText || "", vars),
    frameUrlIncludes: target[k.frame] || "",
  };
  if (!step.selector && !step.scopeSelector) {
    toast("Сначала укажите элемент", "error");
    return;
  }
  await ensureContent(tabId);
  let frameId = 0;
  if (step.frameUrlIncludes) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const m = frames && frames.find((f) => f.url && f.url.includes(step.frameUrlIncludes));
      if (m) frameId = m.frameId;
    } catch (e) {}
  }
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: "highlight", step, inputOnly: !!opts.inputOnly }, { frameId });
    chrome.tabs.update(tabId, { active: true });
    if (!res || !res.count) toast("На странице такой элемент не найден", "error");
  } catch (e) {
    toast("Не удалось подсветить: " + e.message, "error");
  }
}

async function toggleRecording() {
  const tabId = getTargetTabId();
  if (!recording && !tabId) {
    toast("Выберите рабочую вкладку вверху страницы", "error");
    return;
  }
  recording = !recording;
  chrome.runtime.sendMessage({ action: recording ? "startRecording" : "stopRecording", tabId });
  if (recording) chrome.tabs.update(tabId, { active: true });
  ui.recordBtn.textContent = recording ? "Остановить запись" : "Записать действия";
}

function handleRecordedEvent(msg) {
  if (!current) return;
  const steps = current.steps;
  if (msg.kind === "navigate") steps.push({ ...defaultStep("navigate"), url: msg.url });
  else if (msg.kind === "click") steps.push({ ...defaultStep("click"), selector: msg.selector, frameUrlIncludes: msg.frameUrl || "" });
  else if (msg.kind === "type") {
    const last = steps[steps.length - 1];
    if (last && last.type === "type" && last.selector === msg.selector) last.value = msg.value;
    else steps.push({ ...defaultStep("type"), selector: msg.selector, value: msg.value, frameUrlIncludes: msg.frameUrl || "" });
  }
  renderTree();
  touch();
}

// ---------------- запуск ----------------

const hasLoop = (macro) => {
  let found = false;
  walkSteps(macro.steps, (s) => { if (s.type === "loopList") found = true; });
  return found;
};

async function startRun() {
  if (run || !current) return;
  await flush();
  const issues = validateMacro(current);
  if (issues.length) {
    const ok = await confirmDialog(`Не всё заполнено (${issues.length}). Например: ${issues[0].message}. Запустить всё равно?`, { okText: "Всё равно запустить", title: "Проверьте макрос" });
    if (!ok) {
      jumpTo(issues[0].stepId);
      return;
    }
  }
  if (!current.inputs.length && !hasLoop(current)) {
    doRun({}, { newTab: !!current.openInNewTab, trial: 0 });
    return;
  }
  openRunDialog();
}

async function openRunDialog() {
  const saved = resumableProgress(current, await loadProgressAll(), current.id);
  let restart = false;
  const values = {};
  current.inputs.forEach((i) => { values[i.key] = i.default || ""; });
  let where = current.openInNewTab ? "new" : "tab";
  let trial = false;
  let trialN = 3;

  const inputsBox = h("div", { class: "form-grid" });
  for (const inp of current.inputs) {
    const ctl = inp.multiline ? h("textarea", { rows: 4 }) : h("input", { type: "text" });
    ctl.value = values[inp.key];
    ctl.addEventListener("input", () => { values[inp.key] = ctl.value; });
    inputsBox.append(h("label", { class: "field" }, h("span", { class: "field-label" }, inp.label || inp.key), ctl));
  }
  const whereBox = h("div", { class: "field" });
  const drawWhere = () => {
    clear(whereBox);
    whereBox.append(h("span", { class: "field-label" }, "Где выполнить"), segmented([["tab", "В рабочей вкладке"], ["new", "В новой вкладке"]], where, (v) => { where = v; drawWhere(); }));
    if (where === "tab") {
      const opt = ui.tabSelect && ui.tabSelect.selectedOptions[0];
      whereBox.append(h("span", { class: "muted" }, opt && opt.value ? opt.textContent : "Вкладка не выбрана: выберите её вверху страницы"));
    }
  };
  drawWhere();
  // сохранённый прогресс: продолжить с того места, где остановились, или пройти таблицу заново (пробный прогон прогресс не трогает)
  const progressBox = h("div", { class: "field", "data-role": "run-progress" });
  const drawProgress = () => {
    clear(progressBox);
    progressBox.hidden = !saved.length || trial;
    if (progressBox.hidden) return;
    const { sum } = saved[0];
    progressBox.append(
      h("span", { class: "field-label" }, "Прошлый запуск не дошёл до конца"),
      segmented([["continue", `Продолжить с записи ${sum.next}`], ["restart", "Начать сначала"]], restart ? "restart" : "continue", (v) => { restart = v === "restart"; drawProgress(); }),
      h("span", { class: "muted" }, `Обработано ${sum.done} из ${sum.total || "?"}` + (restart ? ": прогресс будет сброшен" : ": они будут пропущены"))
    );
  };
  const trialBox = h("div");
  const drawTrial = () => {
    clear(trialBox);
    const n = textInput({ type: "number", min: 1, value: trialN, onInput: (v) => { trialN = Math.max(1, parseInt(v, 10) || 1); } });
    n.style.width = "78px";
    trialBox.append(h("div", { class: "row" }, checkbox("Пробный прогон: только первые", trial, (v) => { trial = v; drawTrial(); drawProgress(); }), n, h("span", {}, "записей")));
  };
  if (hasLoop(current)) drawTrial();
  drawProgress();

  const m = modal({
    title: "Запуск: " + (current.name || "макрос"),
    body: h("div", { class: "form-grid" }, current.inputs.length ? inputsBox : null, whereBox, progressBox, hasLoop(current) ? trialBox : null),
    actions: [
      button("Отмена", { onClick: () => m.close() }),
      (() => {
        const b = button("Запустить", { kind: "primary", onClick: () => { m.close(); doRun(values, { newTab: where === "new", trial: trial ? trialN : 0, restart: restart && !trial }); } });
        b.dataset.role = "run-confirm";
        return b;
      })(),
    ],
  });
}

function doRun(inputValues, { newTab, trial, restart }) {
  const tabId = newTab ? null : getTargetTabId();
  if (!newTab && !tabId) {
    toast("Выберите рабочую вкладку вверху страницы или запустите в новой", "error");
    return;
  }
  startRunUi(current.name, uid("run"), current.id, trial ? `Пробный прогон: первые ${trial}` : "");
  chrome.runtime.sendMessage({ action: "runMacro", macro: { ...current, openInNewTab: newTab }, inputValues, runId: run.runId, tabId, trialLimit: trial, restartProgress: !!restart });
}

function runSingleStep(step) {
  const tabId = getTargetTabId();
  if (!tabId) {
    toast("Выберите рабочую вкладку вверху страницы", "error");
    return;
  }
  startRunUi("Один шаг: " + stepTitle(step.type), uid("run"), "single", "");
  // вне цикла у шага нет «текущей записи»: подставляем первую запись загруженной таблицы, как в пробном прогоне
  const sample = describeSampleVars(current);
  if (sample && JSON.stringify(step).includes("${")) addLog({ status: "info", text: "Значения для проверки шага - первая запись таблицы: " + sample, cls: "title" });
  chrome.runtime.sendMessage({ action: "runMacro", macro: { id: "single", name: "(один шаг)", openInNewTab: false, inputs: [], triggers: [], steps: [step] }, inputValues: sampleVars(), runId: run.runId, tabId });
}

function stopRun() {
  if (!run) return;
  chrome.runtime.sendMessage({ action: "stopRun", runId: run.runId });
  setDrawerTitle("Останавливаю", "run");
}

function updateRunButtons() {
  if (ui.runBtn) ui.runBtn.hidden = !!run;
  if (ui.stopBtn) ui.stopBtn.hidden = !run;
}

// ---------------- панель хода выполнения ----------------

const drawer = { el: null, lines: [], verbose: false, collapsed: false };

function buildDrawer() {
  drawer.title = h("span", { class: "drawer-title" }, "Выполнение");
  drawer.bar = h("i", { style: "width:0%" });
  drawer.progress = h("div", { class: "progress", hidden: true }, drawer.bar);
  drawer.label = h("span", { class: "progress-label" });
  drawer.log = h("div", { class: "log", "data-role": "log" });
  drawer.body = h("div", { class: "drawer-body" }, drawer.log);
  const verbose = checkbox("Подробно", false, (v) => { drawer.verbose = v; drawLog(); });
  verbose.addEventListener("click", (e) => e.stopPropagation());
  drawer.stop = button("Остановить", { kind: "small danger", onClick: (e) => { e.stopPropagation(); stopRun(); } });
  const close = button("Скрыть", { kind: "small", onClick: (e) => { e.stopPropagation(); drawer.el.hidden = true; } });
  const head = h("div", { class: "drawer-head" }, drawer.title, drawer.progress, drawer.label, h("div", { class: "spacer" }), verbose, drawer.stop, close);
  head.addEventListener("click", () => {
    drawer.collapsed = !drawer.collapsed;
    drawer.body.hidden = drawer.collapsed;
  });
  drawer.el = h("div", { class: "drawer", hidden: true, "data-role": "drawer" }, head, drawer.body);
  mainEl.append(drawer.el);
}

function setDrawerTitle(text, state) {
  drawer.title.textContent = text;
  drawer.title.className = "drawer-title " + (state || "");
  drawer.stop.hidden = state !== "run";
}

function startRunUi(name, runId, macroId, note) {
  if (!drawer.el) buildDrawer();
  run = { runId, macroId };
  drawer.lines = [];
  drawer.log.replaceChildren();
  drawer.progress.hidden = true;
  drawer.label.textContent = note;
  drawer.bar.style.width = "0%";
  drawer.el.hidden = false;
  drawer.collapsed = false;
  drawer.body.hidden = false;
  setDrawerTitle("Выполняется: " + name, "run");
  updateRunButtons();
}

// Без «Подробно» видны только важные события: записи цикла, предупреждения, ошибки, непрошедшие проверки, сохранение отчёта
function isImportant(e) {
  if (e.status === "warn" || e.status === "error" || e.status === "retrying") return true;
  if (e.type === "loopList" || e.type === "appendReport") return true;
  if (e.type === "condition" && e.message && e.message.startsWith("Не выполнено")) return true;
  return false;
}

function lineEl(e) {
  const label = e.type ? stepTitle(e.type) : "";
  const text = e.text || `${label}${e.message ? ": " + e.message : ""}`;
  return h("div", { class: "log-line " + (e.cls || e.status || "info") }, text);
}

function drawLog() {
  drawer.log.replaceChildren(...drawer.lines.filter((e) => drawer.verbose || e.important !== false).map(lineEl));
  drawer.body.scrollTop = drawer.body.scrollHeight;
}

function addLog(entry) {
  const e = { ...entry };
  e.important = entry.text ? true : isImportant(entry);
  drawer.lines.push(e);
  if (drawer.verbose || e.important) {
    drawer.log.append(lineEl(e));
    drawer.body.scrollTop = drawer.body.scrollHeight;
  }
}

function finishRun(state, message) {
  if (state === "ok") setDrawerTitle("Готово", "ok");
  else if (/Остановлено/.test(message || "")) setDrawerTitle("Остановлено", "");
  else setDrawerTitle("Ошибка: " + message, "err");
  if (state === "ok") {
    drawer.bar.style.width = "100%";
    addLog({ status: "ok", text: "Готово", type: "" });
  } else {
    addLog({ status: "error", text: message, type: "" });
  }
  run = null;
  updateRunButtons();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.action === "pickerResult" && pickState) {
    const { target, refs } = pickState;
    const k = refs.keys;
    target[k.type] = "css";
    target[k.sel] = msg.selector;
    refs.input.value = msg.selector;
    refs.type.value = "css";
    if (refs.frame) refs.frame.value = msg.frameUrl || "";
    target[k.frame] = msg.frameUrl || "";
    pickState = null;
    window.focus();
    chrome.tabs.getCurrent((tab) => tab && chrome.tabs.update(tab.id, { active: true }));
    touch();
    toast(msg.resolvedField ? "Выбрано поле ввода внутри нажатого элемента" : "Элемент выбран", "ok");
    return;
  }
  if (msg.action === "recordedEvent") {
    handleRecordedEvent(msg);
    return;
  }
  if (!run || msg.runId !== run.runId) return;
  if (msg.type === "mb-log") {
    // «запись N из M» уже показывает полоса прогресса
    if (msg.entry.type === "loopList" && /^запись \d/.test(msg.entry.message || "")) return;
    addLog(msg.entry);
  } else if (msg.type === "mb-progress") {
    drawer.progress.hidden = false;
    drawer.bar.style.width = Math.round(((msg.index - 1) / msg.total) * 100) + "%";
    drawer.label.textContent = `Запись ${msg.index} из ${msg.total}${msg.label ? ": " + msg.label : ""}`;
    addLog({ status: "info", type: "loopList", text: `Запись ${msg.index} из ${msg.total}${msg.label ? ": " + msg.label : ""}`, cls: "title" });
  } else if (msg.type === "mb-run-done") finishRun("ok");
  else if (msg.type === "mb-run-error") finishRun("error", msg.message);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[REPORTS_KEY]) refreshReportsCount();
  if (area === "local" && changes[PROGRESS_KEY]) refreshProgressViews();
});

// ---------------- старт ----------------

async function init() {
  allMacros = await loadMacros();
  const params = new URLSearchParams(location.search);
  const id = params.get("m");
  current = (id && allMacros.find((m) => m.id === id)) || allMacros[0] || null;
  renderAll();
  refreshReportsCount();
  if (params.get("new")) openTemplates();
}

init();
