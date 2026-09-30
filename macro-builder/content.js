// Content script: инжектится декларативно на КАЖДУЮ страницу (manifest.json).
// Ничего не импортирует (classic script) - выполняет ровно один шаг за раз
// по команде от background.js, плюс режимы "выбрать элемент" и "запись действий"
// для конструктора. Никакой оркестрации (циклы/условия/переменные) здесь нет -
// это всё в background.js, чтобы пережить перезагрузку страницы между шагами.

(function () {
  if (window.__mbContentLoaded) return;
  window.__mbContentLoaded = true;

  // Дублирует нормализацию из logic.js (content.js - classic-скрипт и не может импортировать модули).
  function norm(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  // ---------------- поля ввода ----------------
  // Сайты оборачивают <input> в «красивые» контейнеры (подпись, рамка, placeholder-надпись). Клик по такой
  // обёртке выбирает не поле, и писать в неё нельзя - поэтому настоящее поле определяется отдельно.
  const NON_TEXT_INPUTS = ["checkbox", "radio", "button", "submit", "reset", "file", "hidden", "image", "range", "color"];

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return !NON_TEXT_INPUTS.includes((el.type || "text").toLowerCase());
    return isEditableRoot(el);
  }

  function isEditableRoot(el) {
    if (!el.isContentEditable) return false;
    const parent = el.parentElement;
    return !(parent && parent.isContentEditable);
  }

  function visibleFields(root) {
    const out = [];
    for (const el of root.querySelectorAll("input, textarea, [contenteditable]")) {
      if (isTextField(el) && isVisible(el)) out.push(el);
    }
    return out;
  }

  // Ближайшее к точке поле из списка (сначала то, что содержит точку)
  function nearestField(list, point) {
    if (!point) return list[0];
    let best = list[0];
    let bestD = Infinity;
    for (const f of list) {
      const r = f.getBoundingClientRect();
      if (point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom) return f;
      const dx = Math.max(r.left - point.x, 0, point.x - r.right);
      const dy = Math.max(r.top - point.y, 0, point.y - r.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  // Настоящее поле ввода для найденного/нажатого элемента или null: сам элемент; редактируемая область;
  // поле, связанное с <label>; единственное поле внутри; единственное поле в ближайшем объемлющем блоке.
  // Если полей несколько и непонятно, какое нужно, null (лучше ошибка, чем запись не в то поле).
  function resolveInputElement(el, point) {
    if (!el || el.nodeType !== 1) return null;
    if (isTextField(el)) return el;
    if (el.isContentEditable) {
      let root = el;
      while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      return root;
    }
    if (el.tagName === "LABEL" && el.control && isTextField(el.control)) return el.control;
    const inside = visibleFields(el);
    if (inside.length === 1) return inside[0];
    if (inside.length > 1) return point ? nearestField(inside, point) : null;
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const fields = visibleFields(node);
      if (fields.length === 1) return fields[0];
      if (fields.length > 1) return null;
    }
    return null;
  }

  // CSS-поиск с заходом в открытые shadow DOM (веб-компоненты): только если в обычном DOM ничего не нашлось
  function deepQueryAll(root, selector) {
    const out = [];
    const visit = (r) => {
      try {
        out.push(...r.querySelectorAll(selector));
      } catch (e) {
        return;
      }
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  }

  // Поиск элементов selector внутри root (document или контейнер-строка).
  // xpath внутри контейнера - относительный (начинайте с ".//").
  function queryWithin(root, selectorType, selector) {
    if (selectorType === "text") {
      const all = Array.from(root === document ? document.querySelectorAll("body *") : root.querySelectorAll("*"));
      const needle = norm(selector);
      return all.filter((el) => el.children.length === 0 && norm(el.textContent).includes(needle));
    }
    if (selectorType === "xpath") {
      try {
        const result = document.evaluate(selector, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const arr = [];
        for (let i = 0; i < result.snapshotLength; i++) arr.push(result.snapshotItem(i));
        return arr;
      } catch (e) {
        return [];
      }
    }
    try {
      const found = Array.from(root.querySelectorAll(selector));
      return found.length ? found : deepQueryAll(root, selector);
    } catch (e) {
      return [];
    }
  }

  // Область поиска: контейнеры по CSS (scopeSelector, напр. "tr" или ".result-row"), из которых
  // остаются только те, чей текст содержит scopeText. Так «три точки» ищутся именно в строке
  // с нужным ФИО, а не первые на странице.
  function scopeContainers(step) {
    let list;
    try {
      list = Array.from(document.querySelectorAll(step.scopeSelector));
    } catch (e) {
      return [];
    }
    const needle = norm(step.scopeText);
    return needle ? list.filter((el) => norm(el.textContent).includes(needle)) : list;
  }

  function queryAll(step) {
    const { selectorType, selector } = step;
    if (step.scopeSelector) {
      const containers = scopeContainers(step);
      if (!selector) return containers; // без селектора - сами найденные строки
      const out = [];
      const seen = new Set();
      for (const c of containers) {
        for (const el of queryWithin(c, selectorType, selector)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      }
      return out;
    }
    if (!selector) return [];
    return queryWithin(document, selectorType, selector);
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
    // Часть меню («три точки») открывается по pointerdown/mousedown, а не по click -
    // шлём всю последовательность, как при настоящем нажатии мыши.
    const r = el.getBoundingClientRect();
    const pos = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const t of ["pointerover", "mouseover", "pointerdown", "mousedown"]) {
      el.dispatchEvent(t.startsWith("pointer") ? new PointerEvent(t, { ...pos, pointerType: "mouse" }) : new MouseEvent(t, pos));
    }
    for (const t of ["pointerup", "mouseup"]) {
      el.dispatchEvent(t.startsWith("pointer") ? new PointerEvent(t, { ...pos, pointerType: "mouse" }) : new MouseEvent(t, pos));
    }
    el.click();
    return null;
  }

  async function execHover(step) {
    const el = await waitFor(step, Number(step.timeoutMs) || 8000);
    if (!el) throw new Error("Элемент не найден: " + step.selector);
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const pos = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
      el.dispatchEvent(t.startsWith("pointer") ? new PointerEvent(t, { ...pos, pointerType: "mouse" }) : new MouseEvent(t, pos));
    }
    return null;
  }

  // Находит поле для шагов «Ввести текст» / «Очистить поле»: если селектор указывает на обёртку,
  // берётся поле внутри неё; если поля нет вообще - понятная ошибка с названием найденного элемента.
  async function findInputField(step) {
    const found = await waitFor(step, Number(step.timeoutMs) || 8000);
    if (!found) throw new Error("Элемент не найден: " + step.selector);
    const field = resolveInputElement(found);
    if (!field) {
      throw new Error(
        `Найденный элемент (${describeElement(found)}) не является полем ввода, и однозначного поля рядом нет. ` +
          "Выберите само поле ввода: кнопкой «Указать на странице» на шаге."
      );
    }
    return field;
  }

  async function execType(step) {
    const el = await findInputField(step);
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
      el.textContent = (step.clear ? "" : el.textContent || "") + step.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const next = step.clear ? step.value : (el.value || "") + step.value;
      setNativeValue(el, next);
    }
    if (step.pressEnter) fireEnter(el);
    // Angular/PrimeNG проверяют и фиксируют значение при потере фокуса
    if (step.blur) el.blur();
    return null;
  }

  // Стирает текст в поле ввода / textarea / contenteditable; фреймворки (React, Vue) получают input и change
  async function execClear(step) {
    const el = await findInputField(step);
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
      el.textContent = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      setNativeValue(el, "");
    }
    return null;
  }

  async function execWaitFor(step) {
    const el = await waitFor(step, Number(step.timeoutMs) || 15000);
    if (!el) throw new Error("Не дождались элемента: " + step.selector);
    return null;
  }

  // Видимый текст элемента. textContent склеивает слова из соседних элементов без пробела
  // (<span>Иванов</span><span>Иван</span> -> «ИвановИван»), а по такому тексту не сравнить ФИО по словам.
  // Поэтому между текстом из разных узлов вставляется пробел, если его там нет, а пробелы схлопываются.
  const TEXT_SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  function elementText(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && TEXT_SKIP.has(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let out = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue;
      if (!t) continue;
      if (out && !/\s$/.test(out) && !/^\s/.test(t)) out += " ";
      out += t;
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function readValue(el, attr) {
    if (attr === "text") return elementText(el);
    if (attr === "value") return el.value != null ? el.value : "";
    if (attr === "html") return el.innerHTML;
    if (attr === "hrefAbs") return el.href || "";
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

  // count - сколько элементов нашлось; texts - их тексты/значения (для проверок «текст элемента
  // сравнить со значением»), само сравнение делает background.js (logic.js).
  async function execCheck(step) {
    let list = queryAll(step);
    if (step.visibleOnly) list = list.filter(isVisible);
    const res = { exists: list.length > 0, count: list.length };
    if (step.wantTexts) res.texts = list.slice(0, 200).map((el) => readValue(el, step.attr || "text").slice(0, 2000));
    return res;
  }

  // customJs сюда не попадает - изолированный мир content-скрипта имеет свою
  // собственную CSP, запрещающую new Function()/eval независимо от страницы,
  // поэтому такие шаги background.js выполняет отдельно через
  // chrome.scripting.executeScript({world:"MAIN"}), минуя content.js целиком.

  async function handleExec(step) {
    switch (step.type) {
      case "click":
        return { ok: true, value: await execClick(step) };
      case "hover":
        return { ok: true, value: await execHover(step) };
      case "type":
        return { ok: true, value: await execType(step) };
      case "clearField":
        return { ok: true, value: await execClear(step) };
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
    if (msg.action === "highlight") {
      const list = queryAll(msg.step);
      // для шагов ввода: настоящее поле под найденным элементом; не-поля помечаются в подписи
      const fields = msg.inputOnly ? list.map((el) => resolveInputElement(el)) : [];
      const marks = msg.inputOnly ? list.map((el, i) => (fields[i] ? (fields[i] === el ? "" : "поле ввода внутри") : "НЕ ПОЛЕ ВВОДА")) : [];
      if (list.length) {
        list[0].scrollIntoView({ block: "center", inline: "nearest" });
        showHighlights(msg.inputOnly ? list.map((el, i) => fields[i] || el) : list, 7000, marks);
      } else {
        clearHighlights();
      }
      const good = fields.filter(Boolean).length;
      showBanner(
        !list.length
          ? "Элемент не найден"
          : msg.inputOnly
            ? `Найдено элементов: ${list.length}, полей ввода: ${good}. Esc - убрать подсветку`
            : `Найдено элементов: ${list.length}. Esc - убрать подсветку`
      );
      sendResponse({ ok: true, count: list.length, fields: good });
      return true;
    }
    if (msg.action === "clearHighlight") {
      clearHighlights();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "startPicker") {
      startPicker(msg.inputOnly);
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

  // ---------------- подсветка элементов ----------------
  // Красная рамка с сильным свечением и подписью с названием элемента: tag#id.class "текст".
  // Одна подсветка используется и в режиме выбора мышью, и в «Показать на странице».
  const HL_RED = "#ff1a1a";
  const HL_BOX_CSS =
    "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;" +
    `border:3px solid ${HL_RED};background:rgba(255,26,26,0.16);` +
    "box-shadow:0 0 0 2px #fff,0 0 18px 5px rgba(255,26,26,0.8);";
  const HL_LABEL_CSS =
    `position:absolute;left:-3px;bottom:100%;margin-bottom:5px;background:${HL_RED};color:#fff;` +
    "font:bold 12px/1.35 ui-monospace,Menlo,Consolas,monospace;padding:2px 7px;white-space:nowrap;" +
    "max-width:70vw;overflow:hidden;text-overflow:ellipsis;box-shadow:0 0 0 2px #fff;";

  // Название элемента: тег, id, до двух классов, имя поля и короткий текст
  function describeElement(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = Array.from(el.classList || []).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    const name = el.getAttribute && el.getAttribute("name");
    if (name) s += `[name=${name}]`;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) s += ` "${text.length > 32 ? text.slice(0, 31) + "…" : text}"`;
    return s.length > 90 ? s.slice(0, 89) + "…" : s;
  }

  function makeHighlightBox(labelText) {
    const box = document.createElement("div");
    box.className = "__mb-hl";
    box.style.cssText = HL_BOX_CSS;
    const label = document.createElement("div");
    label.className = "__mb-hl-label";
    label.style.cssText = HL_LABEL_CSS;
    label.textContent = labelText;
    box.appendChild(label);
    return box;
  }

  function placeHighlightBox(box, el) {
    const r = el.getBoundingClientRect();
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = Math.max(r.width, 4) + "px";
    box.style.height = Math.max(r.height, 4) + "px";
    const label = box.firstChild;
    // у верхнего края экрана подпись переносится под рамку
    const nearTop = r.top < 26;
    label.style.bottom = nearTop ? "auto" : "100%";
    label.style.top = nearTop ? "100%" : "auto";
    label.style.marginBottom = nearTop ? "0" : "5px";
    label.style.marginTop = nearTop ? "5px" : "0";
  }

  const hl = { items: [], timer: 0, raf: 0, banner: null, bannerTimer: 0 };

  function repositionHighlights() {
    cancelAnimationFrame(hl.raf);
    hl.raf = requestAnimationFrame(() => hl.items.forEach(({ box, el }) => placeHighlightBox(box, el)));
  }

  // Красная плашка в углу страницы: сколько элементов нашлось
  function showBanner(text) {
    if (hl.banner) hl.banner.remove();
    const b = document.createElement("div");
    b.className = "__mb-hl-banner";
    b.style.cssText = `position:fixed;top:10px;right:10px;z-index:2147483647;background:${HL_RED};color:#fff;font:bold 14px/1.3 system-ui,Arial,sans-serif;padding:8px 14px;box-shadow:0 0 0 2px #fff,0 0 14px 3px rgba(255,26,26,0.6);pointer-events:none;`;
    b.textContent = text;
    document.documentElement.appendChild(b);
    hl.banner = b;
    clearTimeout(hl.bannerTimer);
    hl.bannerTimer = setTimeout(() => b.remove(), 7000);
  }

  function clearHighlights() {
    if (hl.banner) hl.banner.remove();
    hl.banner = null;
    hl.items.forEach(({ box }) => box.remove());
    hl.items = [];
    clearTimeout(hl.timer);
    window.removeEventListener("scroll", repositionHighlights, true);
    window.removeEventListener("resize", repositionHighlights);
  }

  // Подсвечивает элементы (номер + название), снимается через ttl мс или по Escape
  function showHighlights(elements, ttl, marks) {
    clearHighlights();
    elements.slice(0, 40).forEach((el, i) => {
      const mark = marks && marks[i] ? `   [${marks[i]}]` : "";
      const box = makeHighlightBox((elements.length > 1 ? `${i + 1}. ${describeElement(el)}` : describeElement(el)) + mark);
      document.documentElement.appendChild(box);
      placeHighlightBox(box, el);
      hl.items.push({ box, el });
    });
    window.addEventListener("scroll", repositionHighlights, true);
    window.addEventListener("resize", repositionHighlights);
    hl.timer = setTimeout(clearHighlights, ttl || 7000);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && hl.items.length) clearHighlights();
  }, true);

  // ---------------- выбор элемента мышью ("пипетка") ----------------
  let pickerActive = false;
  let overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = makeHighlightBox("");
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  let pickerInputOnly = false;
  let pickerTarget = null;

  // Что выбрано под курсором: в режиме «поле ввода» - настоящее поле (даже если курсор над обёрткой,
  // подписью или placeholder-надписью), иначе - сам элемент под курсором
  function pickerResolve(e) {
    const raw = (e.composedPath && e.composedPath()[0]) || e.target;
    if (!raw || raw.nodeType !== 1) return { raw: null, target: null };
    if (!pickerInputOnly) return { raw, target: raw };
    return { raw, target: resolveInputElement(raw, { x: e.clientX, y: e.clientY }) };
  }

  function onPickerMove(e) {
    const ov = ensureOverlay();
    const { raw, target } = pickerResolve(e);
    pickerTarget = target;
    if (!raw) return;
    ov.style.display = "block";
    if (pickerInputOnly && !target) {
      ov.firstChild.textContent = "Здесь нет поля ввода: " + describeElement(raw);
      placeHighlightBox(ov, raw);
      return;
    }
    ov.firstChild.textContent = describeElement(target) + (pickerInputOnly && target !== raw ? "   (поле ввода)" : "");
    placeHighlightBox(ov, target);
  }

  // ---------------- построение устойчивого селектора ----------------
  // Angular/PrimeNG/formly создают классы и идентификаторы, которые меняются от загрузки к загрузке и от
  // состояния поля (ng-tns-c196-13, ng-touched, p-focus, formly_46_...). В селектор они не попадают.

  function stableClass(c) {
    if (/^_?ng-/i.test(c) || /^ember\d+/i.test(c) || /^(css|sc|jss|svelte)-[\w-]{4,}$/i.test(c)) return false;
    if (/\d{3,}/.test(c) || /^[a-z]{1,3}-[0-9a-f]{6,}$/i.test(c)) return false;
    // классы состояния: focus, filled, disabled, invalid, open...
    return !/(^|[-_])(active|focus|focused|hover|open|opened|selected|checked|disabled|invalid|valid|dirty|touched|pristine|untouched|filled|expanded|collapsed|loading|highlight|highlighted|error)($|[-_])/i.test(c);
  }

  // Идентификатор: { auto } - целиком сгенерирован (mat-input-12, pn_id_7); { prefix, suffix } - счётчик внутри
  // осмысленного имени formly_46_input_contractNumber_0; { stable } - обычный
  function analyzeId(id) {
    if (/^(mat-[\w-]*?|pn_id_|ember|react-select-|radix-|headlessui-[\w-]*?|ui-id-|rc_select_|:r)\d+:?$/i.test(id)) return { auto: true };
    if (/^[0-9a-f]{8,}$/i.test(id) || /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return { auto: true };
    const m = id.match(/^(formly_)(\d+)(_.+)$/);
    if (m) return { prefix: m[1], suffix: m[3] };
    if (/\d{3,}/.test(id)) return { auto: true };
    return { stable: true };
  }

  function uniqueIn(root, sel) {
    try {
      return root.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  // Однозначный «якорь» по id: #id либо tag[id^="formly_"][id$="_..."]; null, если id непригоден или не уникален
  function idAnchor(node, root) {
    if (!node.id) return null;
    const a = analyzeId(node.id);
    if (a.auto) return null;
    if (a.prefix) {
      const sel = `${node.tagName.toLowerCase()}[id^="${a.prefix}"][id$="${a.suffix}"]`;
      return uniqueIn(root, sel) ? sel : null;
    }
    const sel = "#" + CSS.escape(node.id);
    return uniqueIn(root, sel) ? sel : null;
  }

  // Звено пути: тег + устойчивые классы (до двух) + порядковый номер среди одноимённых соседей, если без него не различить
  function pathPart(node) {
    const tag = node.tagName.toLowerCase();
    let part = tag;
    const classes = Array.from(node.classList || []).filter(stableClass).slice(0, 2);
    if (classes.length) part += "." + classes.map((c) => CSS.escape(c)).join(".");
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      const alike = same.filter((c) => {
        try {
          return c.matches(part);
        } catch (e) {
          return true;
        }
      });
      if (alike.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    return part;
  }

  function buildSelector(el) {
    const rootNode = el.getRootNode && el.getRootNode();
    const root = rootNode instanceof ShadowRoot ? rootNode : document;
    const tag = el.tagName.toLowerCase();
    const direct = idAnchor(el, root);
    if (direct) return direct;
    // стабильные атрибуты - но только если они однозначно указывают на элемент
    for (const attr of ["data-testid", "data-test", "data-qa", "name", "formcontrolname", "aria-label", "placeholder"]) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (!v) continue;
      const sel = `${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`;
      if (uniqueIn(root, sel)) return sel;
    }
    // путь от элемента вверх: останавливаемся, как только селектор стал однозначным или встретился надёжный id
    const chain = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth++) {
      const anchor = node !== el ? idAnchor(node, root) : null;
      chain.unshift(anchor || pathPart(node));
      const sel = chain.join(" > ");
      if (anchor || uniqueIn(root, sel)) return sel;
      node = node.parentElement;
    }
    return chain.join(" > ");
  }

  function onPickerClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const { raw, target } = pickerResolve(e);
    if (pickerInputOnly && !target) {
      // это не поле ввода: выбор не завершаем, даём кликнуть ещё раз
      showBanner("Здесь нет поля ввода. Кликните по самому полю (Esc - отмена)");
      return;
    }
    const el = target || raw;
    stopPicker();
    chrome.runtime.sendMessage({
      action: "pickerResult",
      selector: buildSelector(el),
      text: (el.textContent || "").trim().slice(0, 80),
      frameUrl: window !== window.top ? location.href : "",
      resolvedField: pickerInputOnly && el !== raw,
    });
  }

  function onPickerEsc(e) {
    if (e.key === "Escape") stopPicker();
  }

  function startPicker(inputOnly) {
    pickerInputOnly = !!inputOnly;
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
