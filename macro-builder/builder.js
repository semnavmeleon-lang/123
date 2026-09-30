// Конструктор макросов: слева список макросов, справа редактор выбранного макроса
// (компактные раскрываемые карточки шагов), внизу панель хода выполнения.

import { loadMacros, saveMacros, newMacro, uid, defaultStep, newTrigger, TRIGGER_LABELS, REPORTS_KEY, PROGRESS_KEY } from "./common.js";
import { buildConfig, parseImport, mergeConfig, importAsCopies } from "./logic.js";
import {
  h, clear, textInput, selectInput, checkbox, segmented, button, iconButton, disclosure, popover, menuList, modal, confirmDialog, toast, downloadText, insertAtCaret,
} from "./ui/dom.js";
import { STEP_META, PALETTE, CATEGORIES, stepTitle, describeStep, validateStep, validateMacro, collectVars, pluralRu, walkSteps } from "./ui/meta.js";
import { stepBody, hasBody, branchesOf } from "./ui/editors.js";

const sideEl = document.getElementById("side");
const mainEl = document.getElementById("main");

let allMacros = [];
let current = null;
let openStepId = null; // раскрыт один шаг за раз - страница остаётся короткой
let run = null; // { runId, macroId }
let recording = false;
let pickState = null;
let lastField = null;
let reportsCount = 0;
let targetTabId = null;
let saveTimer = null;
const cards = new Map(); // step.id -> { card, detail, warn, step }
const ui = {}; // ссылки на элементы шапки

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
// Любое изменение в редакторе: сохранить и обновить описания карточек, статус и подсказки переменных
function touch() {
  scheduleSave();
  refreshCards();
  refreshStatus();
  refreshDatalist();
}

// ---------------- API для редакторов шагов ----------------

const api = {
  save: touch,
  rerender: () => rerenderSteps(),
  toast,
  vars: () => collectVars(current),
  pick: (target, refs) => pickElement(target, refs),
  insertVar(name) {
    if (lastField && document.contains(lastField)) insertAtCaret(lastField, "${" + name + "}");
    else toast("Сначала нажмите на поле, куда вставить", "info");
  },
  async resetProgress(step) {
    const all = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY] || {};
    delete all[current.id + ":" + step.id];
    await chrome.storage.local.set({ [PROGRESS_KEY]: all });
  },
};

document.addEventListener("focusin", (e) => {
  const t = e.target;
  if (t && t.matches && t.matches("input:not([type=checkbox]):not([type=file]), textarea") && t.closest(".step-body")) lastField = t;
});

// ---------------- боковая панель ----------------

function sideLink(icon, label, badge, onClick) {
  const b = h("button", { type: "button", class: "side-link" }, h("span", {}, icon), h("span", {}, label), badge ? h("span", { class: "badge" }, badge) : null);
  b.addEventListener("click", onClick);
  return b;
}

function renderSide() {
  clear(sideEl);
  const list = h("div", { class: "macro-list", role: "list", "data-role": "macro-list" });
  for (const m of allMacros) {
    const n = (m.steps || []).length;
    const item = h(
      "button",
      { type: "button", class: "macro-item" + (current && m.id === current.id ? " active" : ""), "data-macro-id": m.id },
      h("span", { class: "macro-ico" }, "⚡"),
      h("span", { class: "macro-txt" }, h("span", { class: "macro-name" }, m.name || "Без имени"), h("span", { class: "macro-sub" }, `${n} ${pluralRu(n, "шаг", "шага", "шагов")}`))
    );
    item.addEventListener("click", () => selectMacro(m.id));
    list.append(item);
  }
  sideEl.append(
    h("div", { class: "side-head" }, h("div", { class: "brand" }, h("span", { class: "brand-logo" }, "⚡"), "Макро-конструктор"), button("Новый макрос", { kind: "primary", icon: "＋", onClick: openTemplates })),
    list,
    h("div", { class: "side-foot" }, sideLink("📝", "Отчёты", reportsCount || null, openReports), sideLink("💾", "Конфиг", null, openConfig))
  );
}

async function selectMacro(id) {
  await flush();
  current = allMacros.find((m) => m.id === id) || null;
  openStepId = null;
  history.replaceState(null, "", current ? "?m=" + current.id : location.pathname);
  renderAll();
}

// ---------------- шаблоны нового макроса ----------------

const TEMPLATES = [
  { id: "blank", icon: "✨", name: "Пустой макрос", sub: "Собрать шаги с нуля" },
  { id: "excel-obzvon.json", icon: "📞", name: "Обзвон по столбцу Excel", sub: "Номера из файла → набор на IP-телефоне" },
  { id: "proverka-strok.json", icon: "✅", name: "Проверка строк таблицы на сайте", sub: "Поиск → сравнение → карточка в новой вкладке → отчёт" },
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
  openStepId = null;
  await saveMacros(allMacros);
  history.replaceState(null, "", "?m=" + macro.id);
  renderAll();
}

function templateCards(onPick) {
  const grid = h("div", { class: "tpl-grid", "data-role": "templates" });
  for (const t of TEMPLATES) {
    const c = h("button", { type: "button", class: "tpl-card", "data-template": t.id }, h("span", { class: "t-ico" }, t.icon), h("span", { class: "t-name" }, t.name), h("span", { class: "t-sub" }, t.sub));
    c.addEventListener("click", () => onPick(t.id));
    grid.append(c);
  }
  const imp = h("button", { type: "button", class: "tpl-card" }, h("span", { class: "t-ico" }, "📂"), h("span", { class: "t-name" }, "Загрузить из файла"), h("span", { class: "t-sub" }, "Экспорт макроса или конфиг"));
  imp.addEventListener("click", () => importInput.click());
  grid.append(imp);
  return grid;
}

function openTemplates() {
  const m = modal({ title: "Новый макрос", wide: true, body: templateCards(async (id) => { m.close(); await createFromTemplate(id); }) });
}

// ---------------- главная область ----------------

function renderAll() {
  renderSide();
  renderMain();
}

function hero() {
  return h(
    "div",
    { class: "hero" },
    h("h1", {}, "Автоматизируйте действия в браузере"),
    p("Соберите макрос из готовых шагов и запускайте его вручную или по расписанию."),
    templateCards(async (id) => createFromTemplate(id))
  );
}
const p = (t) => h("p", {}, t);

function renderMain() {
  clear(mainEl);
  cards.clear();
  if (!current) {
    mainEl.append(hero());
    return;
  }
  current.inputs = current.inputs || [];
  current.triggers = current.triggers || [];
  current.steps = current.steps || [];

  const title = textInput({ value: current.name, placeholder: "Название макроса", onInput: (v) => { current.name = v; scheduleSave(); } });
  title.className = "macro-title";
  title.setAttribute("aria-label", "Название макроса");
  title.dataset.role = "macro-title";
  ui.status = h("button", { type: "button", class: "status-chip", "data-role": "status" });
  ui.runBtn = button("Запустить", { kind: "primary", icon: "▶", onClick: startRun });
  ui.runBtn.dataset.role = "run";
  ui.stopBtn = button("Остановить", { kind: "danger", icon: "■", onClick: stopRun });
  ui.stopBtn.dataset.role = "stop";
  const more = iconButton("⋯", "Ещё", () => {
    const pop = popover(
      more,
      menuList(
        [
          { icon: "⧉", label: "Дублировать макрос", onClick: duplicateMacro },
          { icon: "⬇", label: "Экспортировать в JSON", onClick: exportMacro },
          { icon: "⬆", label: "Импортировать из JSON…", onClick: () => importInput.click() },
          "-",
          { icon: "🗑", label: "Удалить макрос", danger: true, onClick: deleteMacro },
        ],
        () => pop.close()
      ),
      { align: "right" }
    );
  });
  more.dataset.role = "more";

  mainEl.append(
    h("div", { class: "topbar" }, h("div", { class: "topbar-inner" }, title, ui.status, ui.stopBtn, ui.runBtn, more)),
    h("div", { class: "content" }, tabStrip(), stepsSection(), settingsSection())
  );
  updateRunButtons();
  rerenderSteps();
}

// --- рабочая вкладка (для «Выбрать на странице», записи и запуска в текущей вкладке)

function tabStrip() {
  ui.tabSelect = h("select", { "data-role": "tab-select", "aria-label": "Рабочая вкладка" });
  ui.tabSelect.addEventListener("change", () => { targetTabId = ui.tabSelect.value ? Number(ui.tabSelect.value) : null; });
  refreshTabs();
  return h("div", { class: "tabstrip" }, h("span", { class: "lbl" }, "🗔 Рабочая вкладка"), ui.tabSelect, iconButton("⟳", "Обновить список вкладок", refreshTabs));
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  clear(ui.tabSelect);
  for (const t of tabs) {
    if (!t.url || /^(chrome|edge|chrome-extension):\/\//.test(t.url)) continue;
    ui.tabSelect.append(h("option", { value: t.id }, (t.title || t.url).slice(0, 70)));
  }
  if (!ui.tabSelect.options.length) ui.tabSelect.append(h("option", { value: "" }, "нет подходящих вкладок — откройте нужный сайт"));
  if (targetTabId && Array.from(ui.tabSelect.options).some((o) => o.value === String(targetTabId))) ui.tabSelect.value = String(targetTabId);
  else targetTabId = ui.tabSelect.value ? Number(ui.tabSelect.value) : null;
}

const getTargetTabId = () => (ui.tabSelect && ui.tabSelect.value ? Number(ui.tabSelect.value) : null);

// --- шаги

function stepsSection() {
  ui.steps = h("div", { class: "steps", "data-role": "steps" });
  ui.stepsCount = h("span", { class: "count" });
  ui.recordBtn = button(recording ? "Остановить запись" : "Записать действия", { kind: "ghost", icon: recording ? "⏹" : "●", tip: "Кликайте по сайту на рабочей вкладке — шаги добавятся сами", onClick: toggleRecording });
  return h("section", {}, h("div", { class: "section-head" }, h("h2", {}, "Шаги ", ui.stepsCount), h("div", { class: "spacer" }), ui.recordBtn), ui.steps);
}

function rerenderSteps() {
  cards.clear();
  renderList(current.steps, ui.steps, true);
  ui.stepsCount.textContent = current.steps.length ? `· ${current.steps.length}` : "";
  refreshCards();
  refreshStatus();
  refreshDatalist();
}

function renderList(arr, container, top = false) {
  clear(container);
  if (!arr.length && top) {
    container.append(
      h(
        "div",
        { class: "steps-empty" },
        h("div", {}, "В макросе пока нет шагов"),
        (() => {
          const b = button("Добавить первый шаг", { kind: "primary", icon: "＋" });
          b.dataset.role = "add-first";
          b.addEventListener("click", () => openPalette(b, arr));
          return b;
        })()
      )
    );
    return;
  }
  arr.forEach((s, i) => container.append(stepCard(s, arr, i)));
  const add = h("button", { type: "button", class: "add-step", "data-role": "add-step" }, "＋ Добавить шаг");
  add.addEventListener("click", () => openPalette(add, arr));
  container.append(add);
}

function branchEl({ kind, label, arr }) {
  const list = h("div", { class: "steps" });
  renderList(arr, list);
  return h("div", { class: "branch", "data-kind": kind }, h("div", { class: "branch-label" }, label), list);
}

function cloneStep(step) {
  const copy = JSON.parse(JSON.stringify(step));
  (function fresh(s) {
    s.id = uid();
    for (const k of ["steps", "then", "else", "catchSteps"]) (s[k] || []).forEach(fresh);
  })(copy);
  return copy;
}

function stepCard(step, arr, idx) {
  const meta = STEP_META[step.type] || { cat: "code", icon: "❔" };
  const expandable = hasBody(step);
  const open = expandable && openStepId === step.id;
  const card = h("div", { class: "step" + (open ? " open" : ""), "data-cat": meta.cat, "data-step-type": step.type, "data-step-id": step.id });
  const detail = h("span", { class: "step-detail" });
  const warn = h("span", { class: "step-warn", hidden: true });

  const menuBtn = iconButton("⋯", "Ещё", () => {
    const pop = popover(
      menuBtn,
      menuList(
        [
          { icon: "⧉", label: "Дублировать", onClick: () => { arr.splice(idx + 1, 0, cloneStep(step)); touch(); rerenderSteps(); } },
          { icon: "🗑", label: "Удалить", danger: true, onClick: () => { arr.splice(idx, 1); if (openStepId === step.id) openStepId = null; touch(); rerenderSteps(); } },
        ],
        () => pop.close()
      ),
      { align: "right" }
    );
  });
  const actions = h(
    "div",
    { class: "step-actions" },
    iconButton("▶", "Выполнить только этот шаг на рабочей вкладке", () => runSingleStep(step)),
    iconButton("↑", "Выше", () => { if (idx > 0) { [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; touch(); rerenderSteps(); } }),
    iconButton("↓", "Ниже", () => { if (idx < arr.length - 1) { [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]]; touch(); rerenderSteps(); } }),
    menuBtn
  );
  const head = h(
    "div",
    { class: "step-head", role: "button", tabindex: "0", "aria-expanded": String(open), "aria-disabled": expandable ? null : "true", "data-role": "step-head" },
    h("span", { class: "chev" }, expandable ? "▶" : ""),
    h("span", { class: "step-num" }, idx + 1),
    h("span", { class: "step-ico", "aria-hidden": "true" }, meta.icon),
    h("span", { class: "step-title" }, stepTitle(step.type)),
    detail,
    warn,
    actions
  );
  const toggle = () => {
    if (!expandable) return;
    openStepId = open ? null : step.id;
    rerenderSteps();
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  card.append(head);
  if (open) card.append(h("div", { class: "step-body", "data-role": "step-body" }, stepBody(step, api)));
  const branches = branchesOf(step);
  if (branches.length) card.append(h("div", { class: "step-branches" }, branches.map(branchEl)));
  cards.set(step.id, { card, detail, warn, step });
  return card;
}

// Свёрнутая карточка показывает, что именно делает шаг, и что в нём не заполнено
function refreshCards() {
  for (const { detail, warn, step, card } of cards.values()) {
    const d = describeStep(step);
    detail.textContent = d;
    detail.classList.toggle("empty", !d);
    const issues = validateStep(step);
    warn.hidden = !issues.length;
    warn.textContent = issues.length ? "⚠ " + issues[0] : "";
    warn.title = issues.join("\n");
    card.classList.toggle("has-warn", !!issues.length);
  }
}

function refreshStatus() {
  const chip = ui.status;
  if (!chip || !current) return;
  const issues = validateMacro(current);
  chip.onclick = null;
  if (!current.steps.length) {
    chip.className = "status-chip";
    chip.textContent = "Нет шагов";
  } else if (issues.length) {
    chip.className = "status-chip warn";
    chip.textContent = `⚠ ${issues.length} ${pluralRu(issues.length, "замечание", "замечания", "замечаний")}`;
    chip.title = issues.slice(0, 8).map((i) => `${i.path}. ${i.message}`).join("\n");
    chip.onclick = () => jumpTo(issues[0].stepId);
  } else {
    chip.className = "status-chip ok";
    chip.textContent = "✔ Готов к запуску";
    chip.title = "";
  }
}

function jumpTo(stepId) {
  openStepId = stepId;
  rerenderSteps();
  const c = cards.get(stepId);
  if (c) {
    c.card.scrollIntoView({ block: "center", behavior: "smooth" });
    c.card.classList.add("attention");
    setTimeout(() => c.card.classList.remove("attention"), 1400);
  }
}

function refreshDatalist() {
  if (!current) return;
  clear(dlLists);
  for (const n of collectVars(current).lists) dlLists.append(h("option", { value: n }));
}

// --- палитра шагов

function addStep(arr, type) {
  const s = defaultStep(type);
  if (type === "loopList") {
    const lists = collectVars(current).lists;
    if (lists.length) s.sourceKey = lists[0];
  }
  arr.push(s);
  if (hasBody(s)) openStepId = s.id;
  rerenderSteps();
  touch();
  requestAnimationFrame(() => {
    const c = cards.get(s.id);
    if (c) c.card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function openPalette(anchor, arr) {
  const search = textInput({ placeholder: "Найти шаг…" });
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
      const grid = h("div", { class: "palette-grid" });
      for (const t of items) {
        const b = h("button", { type: "button", class: "palette-item" + (first ? " first" : ""), title: STEP_META[t].tip, "data-add": t }, h("span", { class: "ico" }, STEP_META[t].icon), h("span", {}, stepTitle(t)));
        b.addEventListener("click", () => {
          pop.close();
          addStep(arr, t);
        });
        grid.append(b);
        first = false;
      }
      list.append(h("div", { class: "palette-group", style: `--cat: ${CATEGORIES[g.cat].color}` }, h("div", { class: "palette-cat" }, CATEGORIES[g.cat].label), grid));
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

// --- настройки макроса

function settingsSection() {
  const inputsBox = h("div");
  const drawInputs = () => {
    clear(inputsBox);
    current.inputs.forEach((inp, i) => {
      inputsBox.append(
        h(
          "div",
          { class: "param-row" },
          textInput({ value: inp.key, placeholder: "имя (например phones)", mono: true, onInput: (v) => { inp.key = v.trim(); touch(); } }),
          textInput({ value: inp.label, placeholder: "подпись при запуске", onInput: (v) => { inp.label = v; scheduleSave(); } }),
          checkbox("список", inp.multiline, (v) => { inp.multiline = v; touch(); }, { tip: "Несколько значений: по одному в строке" }),
          textInput({ value: inp.default, placeholder: "значение по умолчанию", onInput: (v) => { inp.default = v; scheduleSave(); } }),
          iconButton("✕", "Удалить параметр", () => { current.inputs.splice(i, 1); touch(); drawInputs(); }, { danger: true })
        )
      );
    });
    inputsBox.append(button("Добавить параметр", { kind: "ghost", icon: "＋", onClick: () => { current.inputs.push({ key: "param" + (current.inputs.length + 1), label: "", multiline: false, default: "" }); touch(); drawInputs(); } }));
  };
  drawInputs();

  const trigBox = h("div");
  const sync = () => chrome.runtime.sendMessage({ action: "syncAlarms" }).catch(() => {});
  const drawTriggers = () => {
    clear(trigBox);
    current.triggers.forEach((t, i) => {
      const row = h("div", { class: "trigger-row" }, checkbox("", t.enabled, (v) => { t.enabled = v; scheduleSave(); sync(); }, { tip: "Включён" }), h("strong", {}, TRIGGER_LABELS[t.type] || t.type));
      if (t.type === "interval") row.append(textInput({ type: "number", min: 1, value: t.everyMinutes, onInput: (v) => { t.everyMinutes = v; scheduleSave(); sync(); } }), h("span", {}, "мин"));
      if (t.type === "daily") row.append(textInput({ type: "time", value: t.atTime || "09:00", onInput: (v) => { t.atTime = v; scheduleSave(); sync(); } }));
      if (t.type === "urlMatch") row.append(textInput({ value: t.pattern, placeholder: "https://example.com/orders*", mono: true, onInput: (v) => { t.pattern = v; scheduleSave(); } }));
      row.append(h("div", { class: "spacer" }), iconButton("✕", "Удалить триггер", () => { current.triggers.splice(i, 1); scheduleSave(); sync(); drawTriggers(); }, { danger: true }));
      trigBox.append(row);
    });
    const add = button("Добавить автозапуск", { kind: "ghost", icon: "＋" });
    add.addEventListener("click", () => {
      const pop = popover(
        add,
        menuList(Object.entries(TRIGGER_LABELS).map(([type, label]) => ({ label, onClick: () => { current.triggers.push(newTrigger(type)); scheduleSave(); sync(); drawTriggers(); } })), () => pop.close())
      );
    });
    trigBox.append(add);
  };
  drawTriggers();

  return h(
    "section",
    {},
    h("div", { class: "section-head" }, h("h2", {}, "Настройки")),
    h(
      "div",
      { class: "card", "data-role": "settings" },
      disclosure("Параметры запуска", inputsBox, { badge: current.inputs.length || null }),
      disclosure("Автозапуск", trigBox, { badge: current.triggers.filter((t) => t.enabled).length || null }),
      h("div", { style: "padding:12px 0 4px" }, checkbox("Запускать в новой вкладке", current.openInNewTab, (v) => { current.openInNewTab = v; scheduleSave(); }))
    )
  );
}

// ---------------- действия над макросом ----------------

async function duplicateMacro() {
  await flush();
  const copy = JSON.parse(JSON.stringify(current));
  copy.id = uid("m");
  copy.name = (current.name || "Без имени") + " (копия)";
  allMacros.push(copy);
  current = copy;
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
    openStepId = null;
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
    const rows = h("div", { class: "list-rows" });
    for (const name of names) {
      const r = all[name];
      const kb = (new TextEncoder().encode(r.text || "").length / 1024).toFixed(1);
      rows.append(
        h(
          "div",
          { class: "list-row", "data-report": name },
          h("div", { class: "grow" }, h("div", {}, name), h("div", { class: "sub" }, `${kb} КБ · ${new Date(r.updatedAt || 0).toLocaleString("ru-RU")}`)),
          button("Скачать", { icon: "⬇", onClick: () => downloadText(name, r.text || "", "text/markdown") }),
          iconButton("✕", "Удалить", async () => {
            if (!(await confirmDialog(`Удалить накопленный отчёт «${name}»?`, { okText: "Удалить", danger: true }))) return;
            const cur = (await chrome.storage.local.get(REPORTS_KEY))[REPORTS_KEY] || {};
            delete cur[name];
            await chrome.storage.local.set({ [REPORTS_KEY]: cur });
            draw();
          }, { danger: true })
        )
      );
    }
    box.append(rows);
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
    status.textContent = `Сохранено макросов: ${cfg.macros.length}` + (includeData ? " (с данными таблиц — файл содержит персональные данные)." : "; данные таблиц в файл не попали.");
  };
  const saveBtn = button("Сохранить в файл", { kind: "primary", icon: "⬇", onClick: save });
  saveBtn.dataset.role = "config-save";
  modal({
    title: "Конфиг",
    body: h(
      "div",
      { class: "form-grid" },
      checkbox("Включить данные таблиц (персональные данные клиентов)", false, (v) => { includeData = v; }),
      h("div", { class: "row" }, saveBtn, button("Загрузить из файла", { icon: "⬆", onClick: () => file.click() }), file),
      status
    ),
  });
}

// ---------------- выбор элемента и запись действий ----------------

async function pickElement(target, refs) {
  const tabId = getTargetTabId();
  if (!tabId) {
    toast("Выберите рабочую вкладку вверху страницы", "error");
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {}
  pickState = { target, refs };
  chrome.tabs.sendMessage(tabId, { action: "startPicker" });
  chrome.tabs.update(tabId, { active: true });
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
  renderMain();
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
  rerenderSteps();
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

function openRunDialog() {
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
      whereBox.append(h("span", { class: "file-sub" }, opt && opt.value ? "🗔 " + opt.textContent : "Вкладка не выбрана — выберите её вверху страницы"));
    }
  };
  drawWhere();
  const trialBox = h("div");
  const drawTrial = () => {
    clear(trialBox);
    trialBox.append(
      h("div", { class: "row" }, checkbox("Пробный прогон: только первые", trial, (v) => { trial = v; drawTrial(); }), textInput({ type: "number", min: 1, value: trialN, onInput: (v) => { trialN = Math.max(1, parseInt(v, 10) || 1); } }), h("span", {}, "записей"))
    );
    trialBox.querySelector("input[type=number]").style.width = "78px";
  };
  if (hasLoop(current)) drawTrial();

  const m = modal({
    title: "Запуск: " + (current.name || "макрос"),
    body: h("div", { class: "form-grid" }, current.inputs.length ? inputsBox : null, whereBox, hasLoop(current) ? trialBox : null),
    actions: [
      button("Отмена", { onClick: () => m.close() }),
      (() => {
        const b = button("Запустить", { kind: "primary", icon: "▶", onClick: () => { m.close(); doRun(values, { newTab: where === "new", trial: trial ? trialN : 0 }); } });
        b.dataset.role = "run-confirm";
        return b;
      })(),
    ],
  });
}

function doRun(inputValues, { newTab, trial }) {
  const tabId = newTab ? null : getTargetTabId();
  if (!newTab && !tabId) {
    toast("Выберите рабочую вкладку вверху страницы или запустите в новой", "error");
    return;
  }
  startRunUi(current.name, uid("run"), current.id, trial ? `Пробный прогон · первые ${trial}` : "");
  chrome.runtime.sendMessage({ action: "runMacro", macro: { ...current, openInNewTab: newTab }, inputValues, runId: run.runId, tabId, trialLimit: trial });
}

function runSingleStep(step) {
  const tabId = getTargetTabId();
  if (!tabId) {
    toast("Выберите рабочую вкладку вверху страницы", "error");
    return;
  }
  startRunUi("Один шаг: " + stepTitle(step.type), uid("run"), "single", "");
  chrome.runtime.sendMessage({ action: "runMacro", macro: { id: "single", name: "(один шаг)", openInNewTab: false, inputs: [], triggers: [], steps: [step] }, inputValues: {}, runId: run.runId, tabId });
}

function stopRun() {
  if (!run) return;
  chrome.runtime.sendMessage({ action: "stopRun", runId: run.runId });
  setDrawerTitle("Останавливаю…", "run");
}

function updateRunButtons() {
  if (ui.runBtn) ui.runBtn.hidden = !!run;
  if (ui.stopBtn) ui.stopBtn.hidden = !run;
}

// ---------------- панель хода выполнения ----------------

const drawer = {
  el: null,
  lines: [],
  verbose: false,
  collapsed: false,
};

function buildDrawer() {
  drawer.dot = h("span", { class: "dot" });
  drawer.title = h("span", {}, "Выполнение");
  drawer.bar = h("i", { style: "width:0%" });
  drawer.progress = h("div", { class: "progress", hidden: true }, drawer.bar);
  drawer.label = h("span", { class: "progress-label" });
  drawer.log = h("div", { class: "log", "data-role": "log" });
  drawer.body = h("div", { class: "drawer-body" }, drawer.log);
  const verbose = checkbox("Подробно", false, (v) => { drawer.verbose = v; drawLog(); });
  verbose.addEventListener("click", (e) => e.stopPropagation());
  const stopBtn = button("Остановить", { kind: "danger", onClick: (e) => { e.stopPropagation(); stopRun(); } });
  stopBtn.classList.add("btn-small");
  drawer.stop = stopBtn;
  const close = iconButton("✕", "Скрыть панель", () => { drawer.el.hidden = true; });
  const head = h("div", { class: "drawer-head" }, h("div", { class: "drawer-title" }, drawer.dot, drawer.title), drawer.progress, drawer.label, h("div", { class: "spacer" }), verbose, stopBtn, close);
  head.addEventListener("click", () => {
    drawer.collapsed = !drawer.collapsed;
    drawer.body.hidden = drawer.collapsed;
  });
  drawer.el = h("div", { class: "drawer", hidden: true, "data-role": "drawer" }, head, drawer.body);
  document.body.append(drawer.el);
  // панель фиксирована внизу: страница получает отступ под её высоту, чтобы нижние кнопки не оказывались под ней
  new ResizeObserver(() => { mainEl.style.paddingBottom = drawer.el.hidden ? "" : drawer.el.offsetHeight + 24 + "px"; }).observe(drawer.el);
}

function setDrawerTitle(text, state) {
  drawer.title.textContent = text;
  drawer.dot.className = "dot " + (state || "");
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

const ICONS = { ok: "✔", warn: "⚠", error: "✖", info: "•", retrying: "↻" };

// Без «Подробно» видны только важные события: записи цикла, предупреждения, ошибки, непрошедшие проверки, сохранение отчёта
function isImportant(e) {
  if (e.status === "warn" || e.status === "error" || e.status === "retrying") return true;
  if (e.type === "loopList" || e.type === "appendReport") return true;
  if (e.type === "condition" && e.message && e.message.startsWith("✘")) return true;
  return false;
}

function lineEl(e) {
  const label = e.type ? stepTitle(e.type) : "";
  const text = e.text || `${label}${e.message ? ": " + e.message : e.status === "ok" ? "" : ""}`;
  return h("div", { class: "log-line " + (e.cls || e.status || "info") }, h("span", {}, ICONS[e.status] || "•"), h("span", {}, text));
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
    toast("Элемент выбран", "ok");
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
  }
  else if (msg.type === "mb-progress") {
    drawer.progress.hidden = false;
    drawer.bar.style.width = Math.round(((msg.index - 1) / msg.total) * 100) + "%";
    drawer.label.textContent = `Запись ${msg.index} из ${msg.total}${msg.label ? " · " + msg.label : ""}`;
    addLog({ status: "info", type: "loopList", text: `Запись ${msg.index} из ${msg.total}${msg.label ? " — " + msg.label : ""}`, cls: "title" });
  } else if (msg.type === "mb-run-done") finishRun("ok");
  else if (msg.type === "mb-run-error") finishRun("error", msg.message);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[REPORTS_KEY]) refreshReportsCount();
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
