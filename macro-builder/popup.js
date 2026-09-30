// Всплывающее окно расширения: список макросов с запуском, статусом и прогрессом выполнения.

import { loadMacros, uid } from "./common.js";
import { h, clear, button } from "./ui/dom.js";
import { pluralRu } from "./ui/meta.js";

const root = document.getElementById("root");

let macros = [];
let run = null; // { runId, macroId, progress?: {index,total,label} }
const status = {}; // macroId -> { state: "ok" | "err" | "run", text }

function openBuilder(params) {
  chrome.tabs.create({ url: chrome.runtime.getURL("builder.html") + (params || "") });
  window.close();
}

async function refresh() {
  macros = await loadMacros();
  render();
}

function render() {
  clear(root);
  root.append(h("div", { class: "pop-head" }, h("div", { class: "grow" }, "Макросы"), button("Конструктор", { kind: "small", onClick: () => openBuilder("") })));
  if (!macros.length) {
    root.append(h("div", { class: "pop-empty" }, h("div", {}, "Макросов пока нет."), button("Создать первый", { kind: "primary", onClick: () => openBuilder("?new=1") })));
    return;
  }
  const list = h("div", { class: "pop-list", "data-role": "pop-list" });
  for (const m of macros) {
    const running = run && run.macroId === m.id;
    const n = (m.steps || []).length;
    const st = status[m.id];
    const sub = running
      ? h("div", { class: "pop-status run" }, run.progress ? `Запись ${run.progress.index} из ${run.progress.total}` : "Выполняется")
      : st
        ? h("div", { class: "pop-status " + st.state }, st.text)
        : h("span", { class: "macro-sub" }, `${n} ${pluralRu(n, "шаг", "шага", "шагов")}`);
    const runBtn = button(running ? "Стоп" : "Запустить", { kind: running ? "danger small" : "primary small", onClick: () => (running ? stop() : onRun(m)) });
    runBtn.dataset.run = m.id;
    const item = h(
      "div",
      { class: "pop-item" + (running ? " running" : "") },
      h("div", { class: "macro-txt" }, h("span", { class: "macro-name", title: m.name }, m.name || "Без имени"), sub),
      runBtn,
      button("Изменить", { kind: "small", onClick: () => openBuilder("?m=" + m.id) })
    );
    if (running && run.progress) item.append(h("div", { class: "progress" }, h("i", { style: `width:${Math.round(((run.progress.index - 1) / run.progress.total) * 100)}%` })));
    list.append(item);
  }
  root.append(list);
}

function onRun(macro) {
  if (run) return;
  if ((macro.inputs || []).length) showForm(macro);
  else start(macro, {});
}

// Параметры запуска - на месте списка, без отдельных окон
function showForm(macro) {
  clear(root);
  const values = {};
  const form = h("div", { class: "pop-form" }, h("strong", {}, macro.name || "Макрос"));
  for (const inp of macro.inputs) {
    values[inp.key] = inp.default || "";
    const ctl = inp.multiline ? h("textarea", { rows: 4 }) : h("input", { type: "text" });
    ctl.value = values[inp.key];
    ctl.addEventListener("input", () => { values[inp.key] = ctl.value; });
    form.append(h("label", { class: "field" }, h("span", { class: "field-label" }, inp.label || inp.key), ctl));
  }
  form.append(h("div", { class: "row" }, button("Отмена", { onClick: render }), h("div", { class: "spacer" }), button("Запустить", { kind: "primary", onClick: () => start(macro, values) })));
  root.append(form);
}

function start(macro, inputValues) {
  run = { runId: uid("run"), macroId: macro.id };
  delete status[macro.id];
  render();
  chrome.runtime.sendMessage({ action: "runMacro", macro, inputValues, runId: run.runId });
}

function stop() {
  if (run) chrome.runtime.sendMessage({ action: "stopRun", runId: run.runId });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!run || !msg || msg.runId !== run.runId) return;
  if (msg.type === "mb-progress") {
    run.progress = { index: msg.index, total: msg.total, label: msg.label };
    render();
  } else if (msg.type === "mb-run-done") {
    status[run.macroId] = { state: "ok", text: "Готово" };
    run = null;
    render();
  } else if (msg.type === "mb-run-error") {
    const stopped = /Остановлено/.test(msg.message || "");
    status[run.macroId] = { state: stopped ? "run" : "err", text: stopped ? "Остановлено" : "Ошибка: " + msg.message };
    run = null;
    render();
  }
});

refresh();
