import { loadMacros, saveMacros, uid, STEP_LABELS } from "./common.js";

const listEl = document.getElementById("list");
const emptyHint = document.getElementById("emptyHint");
const newBtn = document.getElementById("newBtn");
const openBuilderBtn = document.getElementById("openBuilderBtn");
const inputForm = document.getElementById("inputForm");
const runPanel = document.getElementById("runPanel");
const runLog = document.getElementById("runLog");
const stopBtn = document.getElementById("stopBtn");

let macros = [];
let currentRunId = null;
let activeMacroId = null;
const rowStatus = {}; // macroId -> 'idle' | 'running' | 'ok' | 'error'

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function refresh() {
  macros = await loadMacros();
  render();
}

function render() {
  listEl.innerHTML = "";
  emptyHint.style.display = macros.length ? "none" : "block";
  for (const m of macros) {
    const row = document.createElement("div");
    row.className = "pool-row";
    const status = rowStatus[m.id] || "idle";
    const dotClass = status === "idle" ? "pending" : status;
    row.innerHTML = `
      <span class="dot dot-${dotClass}"></span>
      <span class="pool-name-wrap">
        <span class="pool-name">${escapeHtml(m.name || "Без имени")}</span>
        <span class="pool-hint">${(m.steps || []).length} шаг(ов)</span>
      </span>
    `;
    row.appendChild(mkBtn("▶", "Запустить", () => onRun(m)));
    row.appendChild(mkBtn("✎", "Редактировать", () => openBuilder(m.id)));
    row.appendChild(mkBtn("×", "Удалить", () => onDelete(m.id)));
    listEl.appendChild(row);
  }
}

function mkBtn(txt, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pool-remove";
  b.textContent = txt;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

async function onDelete(id) {
  if (!confirm("Удалить макрос?")) return;
  macros = macros.filter((m) => m.id !== id);
  await saveMacros(macros);
  render();
}

function openBuilder(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL("builder.html") + (id ? "?m=" + id : "") });
}

newBtn.addEventListener("click", () => openBuilder(""));
openBuilderBtn.addEventListener("click", () => openBuilder(""));

function onRun(macro) {
  if (macro.inputs && macro.inputs.length) showInputForm(macro);
  else startRun(macro, {});
}

function showInputForm(macro) {
  inputForm.innerHTML = "";
  inputForm.style.display = "block";
  const title = document.createElement("div");
  title.className = "section-label";
  title.textContent = "Параметры: " + (macro.name || "");
  inputForm.appendChild(title);

  const values = {};
  for (const inp of macro.inputs) {
    const label = document.createElement("label");
    label.style.cssText = "display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px;";
    label.textContent = inp.label || inp.key;
    const control = inp.multiline ? document.createElement("textarea") : document.createElement("input");
    if (!inp.multiline) control.type = "text";
    else control.rows = 3;
    control.value = inp.default || "";
    control.style.marginTop = "4px";
    values[inp.key] = control.value;
    control.addEventListener("input", () => {
      values[inp.key] = control.value;
    });
    label.appendChild(document.createElement("br"));
    label.appendChild(control);
    inputForm.appendChild(label);
  }

  const goBtn = document.createElement("button");
  goBtn.type = "button";
  goBtn.className = "secondary-btn";
  goBtn.textContent = "Запустить";
  goBtn.style.cssText = "background:var(--primary);color:#fff;border-color:var(--primary);";
  goBtn.addEventListener("click", () => {
    inputForm.style.display = "none";
    startRun(macro, values);
  });
  inputForm.appendChild(goBtn);
}

function startRun(macro, inputValues) {
  currentRunId = uid("run");
  activeMacroId = macro.id;
  rowStatus[macro.id] = "running";
  render();
  runPanel.style.display = "block";
  runLog.textContent = "";
  chrome.runtime.sendMessage({ action: "runMacro", macro, inputValues, runId: currentRunId });
}

stopBtn.addEventListener("click", () => {
  if (currentRunId) chrome.runtime.sendMessage({ action: "stopRun", runId: currentRunId });
});

function appendLog(text, status) {
  const line = document.createElement("div");
  line.className = "log-line log-" + (status || "info");
  line.textContent = text;
  runLog.appendChild(line);
  runLog.scrollTop = runLog.scrollHeight;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.runId || msg.runId !== currentRunId) return;
  if (msg.type === "mb-run-start") {
    appendLog("Запуск: " + msg.macroName, "info");
  } else if (msg.type === "mb-log") {
    const label = STEP_LABELS[msg.entry.type] || msg.entry.type;
    appendLog(`${label} — ${msg.entry.status}${msg.entry.message ? ": " + msg.entry.message : ""}`, msg.entry.status);
  } else if (msg.type === "mb-run-done") {
    rowStatus[activeMacroId] = "ok";
    appendLog("Готово ✔", "ok");
    render();
  } else if (msg.type === "mb-run-error") {
    rowStatus[activeMacroId] = "error";
    appendLog("Ошибка: " + msg.message, "error");
    render();
  }
});

refresh();
