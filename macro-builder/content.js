// Content script: инжектится декларативно на КАЖДУЮ страницу (manifest.json).
// Ничего не импортирует (classic script) - выполняет ровно один шаг за раз
// по команде от background.js, плюс режимы "выбрать элемент" и "запись действий"
// для конструктора. Никакой оркестрации (циклы/условия/переменные) здесь нет -
// это всё в background.js, чтобы пережить перезагрузку страницы между шагами.

(function () {
  if (window.__mbContentLoaded) return;
  window.__mbContentLoaded = true;

  function queryAll(step) {
    const { selectorType, selector } = step;
    if (!selector) return [];
    if (selectorType === "text") {
      const all = Array.from(document.querySelectorAll("body *"));
      const needle = selector.trim().toLowerCase();
      return all.filter(
        (el) => el.children.length === 0 && (el.textContent || "").trim().toLowerCase().includes(needle)
      );
    }
    if (selectorType === "xpath") {
      try {
        const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const arr = [];
        for (let i = 0; i < result.snapshotLength; i++) arr.push(result.snapshotItem(i));
        return arr;
      } catch (e) {
        return [];
      }
    }
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (e) {
      return [];
    }
  }

  function getOne(step) {
    const list = queryAll(step);
    const idx = Number(step.index) || 0;
    return list[idx] || null;
  }

  function waitFor(step, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function tick() {
        const el = getOne(step);
        if (el) return resolve(el);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, 150);
      })();
    });
  }

  // Прямое el.value = ... не замечается React/Vue-контролируемыми полями,
  // т.к. они патчат value через дескриптор. Вызываем нативный сеттер и сами
  // диспатчим input/change - это то, что обычно слушают такие фреймворки.
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fireEnter(el) {
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  async function execClick(step) {
    const el = await waitFor(step, Number(step.timeoutMs) || 8000);
    if (!el) throw new Error("Элемент не найден: " + step.selector);
    el.scrollIntoView({ block: "center" });
    el.click();
    return null;
  }

  async function execType(step) {
    const el = await waitFor(step, Number(step.timeoutMs) || 8000);
    if (!el) throw new Error("Элемент не найден: " + step.selector);
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) {
      el.textContent = (step.clear ? "" : el.textContent || "") + step.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const next = step.clear ? step.value : (el.value || "") + step.value;
      setNativeValue(el, next);
    }
    if (step.pressEnter) fireEnter(el);
    return null;
  }

  async function execWaitFor(step) {
    const el = await waitFor(step, Number(step.timeoutMs) || 15000);
    if (!el) throw new Error("Не дождались элемента: " + step.selector);
    return null;
  }

  function readValue(el, attr) {
    if (attr === "text") return (el.textContent || "").trim();
    if (attr === "value") return el.value != null ? el.value : "";
    if (attr === "html") return el.innerHTML;
    return el.getAttribute(attr) || "";
  }

  async function execExtract(step) {
    if (step.multiple) return queryAll(step).map((el) => readValue(el, step.attr));
    const el = await waitFor(step, Number(step.timeoutMs) || 8000);
    if (!el) throw new Error("Элемент не найден: " + step.selector);
    return readValue(el, step.attr);
  }

  function queryInRow(row, selectorType, selector) {
    if (!selector) return row;
    try {
      if (selectorType === "xpath") {
        return document.evaluate(selector, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      }
      return row.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  async function execExtractTable(step) {
    const rows = queryAll({ selectorType: step.rowSelectorType, selector: step.rowSelector });
    return rows.map((row) => {
      const obj = {};
      for (const col of step.columns || []) {
        const cellEl = queryInRow(row, col.selectorType, col.selector);
        obj[col.key || ""] = cellEl ? readValue(cellEl, col.attr) : "";
      }
      return obj;
    });
  }

  async function execKeypress(step) {
    const el = document.activeElement || document.body;
    const key = step.key || "Enter";
    const opts = { key, bubbles: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    return null;
  }

  async function execScroll(step) {
    if (step.mode === "toElement") {
      const el = getOne(step);
      if (el) el.scrollIntoView({ block: "center" });
    } else {
      window.scrollTo(0, document.body.scrollHeight);
    }
    return null;
  }

  async function execCheck(step) {
    return { exists: queryAll(step).length > 0 };
  }

  // customJs сюда не попадает - изолированный мир content-скрипта имеет свою
  // собственную CSP, запрещающую new Function()/eval независимо от страницы,
  // поэтому такие шаги background.js выполняет отдельно через
  // chrome.scripting.executeScript({world:"MAIN"}), минуя content.js целиком.

  async function handleExec(step) {
    switch (step.type) {
      case "click":
        return { ok: true, value: await execClick(step) };
      case "type":
        return { ok: true, value: await execType(step) };
      case "waitFor":
        return { ok: true, value: await execWaitFor(step) };
      case "extract":
        return { ok: true, value: await execExtract(step) };
      case "extractTable":
        return { ok: true, value: await execExtractTable(step) };
      case "keypress":
        return { ok: true, value: await execKeypress(step) };
      case "scroll":
        return { ok: true, value: await execScroll(step) };
      default:
        return { ok: false, error: "Неизвестный тип шага: " + step.type };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "exec") {
      handleExec(msg.step)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.action === "check") {
      execCheck(msg.step)
        .then(sendResponse)
        .catch(() => sendResponse({ exists: false }));
      return true;
    }
    if (msg.action === "startPicker") {
      startPicker();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "stopPicker") {
      stopPicker();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "startRecording") {
      startRecording();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "stopRecording") {
      stopRecording();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  // ---------------- выбор элемента мышью ("пипетка") ----------------
  let pickerActive = false;
  let overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2a6fdb;" +
      "background:rgba(42,111,219,0.15);border-radius:3px;";
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function onPickerMove(e) {
    const r = e.target.getBoundingClientRect();
    const ov = ensureOverlay();
    ov.style.display = "block";
    ov.style.left = r.left + "px";
    ov.style.top = r.top + "px";
    ov.style.width = r.width + "px";
    ov.style.height = r.height + "px";
  }

  function buildSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    for (const attr of ["data-testid", "data-test", "data-qa", "name"]) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) return `[${attr}="${v.replace(/"/g, '\\"')}"]`;
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      if (node.id) {
        parts.unshift(node.tagName.toLowerCase() + "#" + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        part += "." + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  function onPickerClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    stopPicker();
    chrome.runtime.sendMessage({
      action: "pickerResult",
      selector: buildSelector(el),
      text: (el.textContent || "").trim().slice(0, 80),
      frameUrl: window !== window.top ? location.href : "",
    });
  }

  function onPickerEsc(e) {
    if (e.key === "Escape") stopPicker();
  }

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    document.addEventListener("mousemove", onPickerMove, true);
    document.addEventListener("click", onPickerClick, true);
    document.addEventListener("keydown", onPickerEsc, true);
  }

  function stopPicker() {
    pickerActive = false;
    document.removeEventListener("mousemove", onPickerMove, true);
    document.removeEventListener("click", onPickerClick, true);
    document.removeEventListener("keydown", onPickerEsc, true);
    if (overlay) overlay.style.display = "none";
  }

  // ---------------- запись реальных действий ----------------
  let recording = false;

  function onRecordClick(e) {
    const el = e.target;
    if (!el || el === document.documentElement) return;
    chrome.runtime.sendMessage({
      action: "recordedEvent",
      kind: "click",
      selector: buildSelector(el),
      text: (el.textContent || "").trim().slice(0, 60),
      frameUrl: window !== window.top ? location.href : "",
    });
  }

  function onRecordChange(e) {
    const el = e.target;
    if (!el || !("value" in el)) return;
    chrome.runtime.sendMessage({
      action: "recordedEvent",
      kind: "type",
      selector: buildSelector(el),
      value: el.value,
      frameUrl: window !== window.top ? location.href : "",
    });
  }

  function startRecording() {
    if (recording) return;
    recording = true;
    document.addEventListener("click", onRecordClick, true);
    document.addEventListener("change", onRecordChange, true);
  }

  function stopRecording() {
    recording = false;
    document.removeEventListener("click", onRecordClick, true);
    document.removeEventListener("change", onRecordChange, true);
  }
})();
