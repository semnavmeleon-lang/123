// Всплывающее окно расширения: список макросов с кнопкой запуска, статус и прогресс выполнения.

import { loadMacros, uid } from "./common.js";
import { h, clear, button, iconButton } from "./ui/dom.js";
import { pluralRu } from "./ui/meta.js";

const root = document.getElementById("root");

let macros = [];
let run = null; // { runId, macroId, progress?: {index,total,label} }
const status = {}; // macroId -> { state: "ok" | "err", text }

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
  root.append(
    h("div", { class: "pop-head" }, h("div", { class: "brand" }, h("span", { class: "brand-logo" }, "⚡"), "Макросы"), button("Конструктор", { onClick: () => openBuilder("") }))
  );
  if (!macros.length) {
    root.append(h("div", { class: "pop-empty" }, h("div", {}, "Макросов пока нет"), button("Создать первый", { kind: "primary", icon: "＋", onClick: () => openBuilder("?new=1") })));
    return;
  }
  const list = h("div", { class: "pop-list", "data-role": "pop-list" });
  for (const m of macros) {
    const running = run && run.macroId === m.id;
    const n = (m.steps || []).length;
    const st = status[m.id];
    const sub = running
      ? h("div", { class: "pop-status run" }, run.progress ? `Запись ${run.progress.index} из ${run.progress.total}` : "Выполняется…")
      : st
        ? h("div", { class: "pop-status " + st.state }, st.text)
        : h("span", { class: "macro-sub" }, `${n} ${pluralRu(n, "шаг", "шага", "шагов")}`);
    const runBtn = h("button", { type: "button", class: "pop-run" + (running ? " stop" : ""), title: running ? "Остановить" : "Запустить", "aria-label": running ? "Остановить" : "Запустить", "data-run": m.id }, running ? "■" : "▶");
    runBtn.addEventListener("click", () => (running ? stop() : onRun(m)));
    const item = h(
      "div",
      { class: "pop-item" + (running ? " running" : "") },
      runBtn,
      h("div", { class: "macro-txt" }, h("span", { class: "macro-name", title: m.name }, m.name || "Без имени"), sub),
      iconButton("✎", "Открыть в конструкторе", () => openBuilder("?m=" + m.id))
    );
    if (running && run.progress) {
      item.append(h("div", { class: "progress", style: "position:absolute;left:0;right:0;bottom:0;height:3px;border:0;border-radius:0 0 10px 10px;max-width:none" }, h("i", { style: `width:${Math.round(((run.progress.index - 1) / run.progress.total) * 100)}%` })));
      item.style.position = "relative";
    }
    list.append(item);
  }
  root.append(list);
}

function onRun(macro) {
  if (run) return;
  const needsForm = (macro.inputs || []).length > 0;
  if (needsForm) showForm(macro);
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
  form.append(h("div", { class: "row" }, button("Отмена", { onClick: render }), h("div", { class: "spacer" }), button("Запустить", { kind: "primary", icon: "▶", onClick: () => start(macro, values) })));
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
    status[run.macroId] = { state: "ok", text: "✔ Готово" };
    run = null;
    render();
  } else if (msg.type === "mb-run-error") {
    const stopped = /Остановлено/.test(msg.message || "");
    status[run.macroId] = { state: stopped ? "run" : "err", text: stopped ? "Остановлено" : "✖ " + msg.message };
    run = null;
    render();
  }
});

refresh();
