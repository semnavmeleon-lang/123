// Service worker: единственное место, которое реально управляет вкладками и
// последовательно выполняет шаги макроса. content.js выполняет только один
// шаг за раз по команде отсюда - вся оркестрация (навигация, ожидание,
// циклы, условия, переменные) живёт здесь.

import { substitute } from "./common.js";

const runs = new Map(); // runId -> { cancelled }
let recordingTabId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {
    // страница нескриптуема (chrome://, webstore и т.п.) - игнорируем
  }
}

function sendToTab(tabId, message, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Таймаут ожидания ответа со страницы"));
      }
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

// Первая попытка может провалиться, если content.js ещё не успел
// задекларированно проинжектиться (сразу после навигации) - тогда
// подстраховываемся ручной инъекцией и пробуем ещё раз.
async function sendToContent(ctx, message, timeoutMs) {
  try {
    return await sendToTab(ctx.tabId, message, timeoutMs);
  } catch (e) {
    await ensureContentScript(ctx.tabId);
    await sleep(200);
    return await sendToTab(ctx.tabId, message, timeoutMs);
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    function finish() {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function doNavigate(ctx, step) {
  const url = substitute(step.url, ctx.vars);
  await chrome.tabs.update(ctx.tabId, { url });
  await waitForTabComplete(ctx.tabId, Number(step.timeoutMs) || 25000);
  await sleep(250);
  await ensureContentScript(ctx.tabId);
}

function subStep(step, vars) {
  const out = { ...step };
  for (const k of ["url", "selector", "value"]) {
    if (typeof out[k] === "string") out[k] = substitute(out[k], vars);
  }
  return out;
}

function resolveList(ctx, step) {
  const raw = ctx.vars[step.sourceKey];
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw || "")
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runSteps(ctx, steps) {
  for (const step of steps || []) {
    if (ctx.cancelled()) throw new Error("Остановлено пользователем");
    try {
      await runStep(ctx, step);
      ctx.log({ type: step.type, status: "ok" });
    } catch (e) {
      ctx.log({ type: step.type, status: "error", message: e.message });
      throw e;
    }
  }
}

async function runStep(ctx, step) {
  switch (step.type) {
    case "navigate":
      return doNavigate(ctx, step);
    case "wait":
      return sleep(Number(step.ms) || 0);
    case "loopCount": {
      const n = Math.max(0, Number(substitute(String(step.count ?? ""), ctx.vars)) || 0);
      for (let i = 0; i < n; i++) {
        if (ctx.cancelled()) return;
        ctx.vars[step.itemVar || "i"] = i;
        await runSteps(ctx, step.steps);
      }
      return;
    }
    case "loopList": {
      const list = resolveList(ctx, step);
      for (const item of list) {
        if (ctx.cancelled()) return;
        ctx.vars[step.itemVar || "item"] = item;
        await runSteps(ctx, step.steps);
      }
      return;
    }
    case "condition": {
      const res = await sendToContent(
        ctx,
        { action: "check", step: subStep(step, ctx.vars) },
        Number(step.timeoutMs) || 5000
      );
      const exists = !!(res && res.exists);
      const branch = step.mode === "notExists" ? !exists : exists;
      await runSteps(ctx, branch ? step.then : step.else);
      return;
    }
    case "customJs": {
      const res = await sendToContent(ctx, { action: "exec", step, vars: ctx.vars }, 20000);
      if (!res || !res.ok) throw new Error((res && res.error) || "Ошибка выполнения JS");
      if (step.saveTo) ctx.vars[step.saveTo] = res.value;
      return;
    }
    default: {
      const res = await sendToContent(
        ctx,
        { action: "exec", step: subStep(step, ctx.vars) },
        Number(step.timeoutMs) || 15000
      );
      if (!res || !res.ok) throw new Error((res && res.error) || "Шаг завершился с ошибкой");
      if (step.type === "extract" && step.varName) ctx.vars[step.varName] = res.value;
      return;
    }
  }
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] && tabs[0].id;
}

async function runMacro(macro, inputValues, runId, existingTabId) {
  const cancelState = { cancelled: false };
  runs.set(runId, cancelState);
  try {
    let tabId = existingTabId;
    if (macro.openInNewTab || !tabId) {
      const tab = await chrome.tabs.create({ url: "about:blank" });
      tabId = tab.id;
    }
    await ensureContentScript(tabId);

    const ctx = {
      tabId,
      vars: { ...inputValues },
      cancelled: () => !!runs.get(runId)?.cancelled,
      log: (entry) => broadcast({ type: "mb-log", runId, entry }),
    };

    broadcast({ type: "mb-run-start", runId, macroId: macro.id, macroName: macro.name });
    await runSteps(ctx, macro.steps);
    broadcast({ type: "mb-run-done", runId, macroId: macro.id });
  } catch (e) {
    broadcast({ type: "mb-run-error", runId, macroId: macro.id, message: e.message });
  } finally {
    runs.delete(runId);
  }
}

// Пока идёт запись, при каждой навигации целевой вкладки на новую страницу
// content.js там подгружается заново "с нуля" (декларативная инъекция), поэтому
// запись нужно каждый раз включать повторно - иначе клики после перехода
// по ссылке молча перестанут записываться.
const onRecordingNav = (tabId, info) => {
  if (tabId !== recordingTabId || info.status !== "complete") return;
  ensureContentScript(tabId).then(async () => {
    chrome.tabs.sendMessage(tabId, { action: "startRecording" }).catch(() => {});
    try {
      const tab = await chrome.tabs.get(tabId);
      broadcast({ action: "recordedEvent", kind: "navigate", url: tab.url });
    } catch (e) {}
  });
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "runMacro") {
    (async () => {
      const tabId = msg.macro.openInNewTab ? null : msg.tabId || (await getActiveTabId());
      runMacro(msg.macro, msg.inputValues || {}, msg.runId, tabId);
    })();
    sendResponse({ started: true });
    return false;
  }
  if (msg.action === "stopRun") {
    const st = runs.get(msg.runId);
    if (st) st.cancelled = true;
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "startRecording") {
    recordingTabId = msg.tabId;
    chrome.tabs.onUpdated.addListener(onRecordingNav);
    ensureContentScript(msg.tabId).then(() =>
      chrome.tabs.sendMessage(msg.tabId, { action: "startRecording" }).catch(() => {})
    );
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "stopRecording") {
    if (recordingTabId) chrome.tabs.sendMessage(recordingTabId, { action: "stopRecording" }).catch(() => {});
    chrome.tabs.onUpdated.removeListener(onRecordingNav);
    recordingTabId = null;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
