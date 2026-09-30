// Небольшие DOM-хелперы для интерфейса: создание элементов, поля форм, модальные окна,
// всплывающие меню и уведомления. Без зависимостей; постоянных подсказок под полями нет -
// пояснения даются через title (tooltip).

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

// ---------------- поля форм ----------------

// Подпись над полем. tip - подсказка при наведении (не выводится текстом на странице).
export function field(label, control, { tip, wide, grow } = {}) {
  // подпись есть всегда (пустая - для выравнивания элементов без подписи в форме «подпись слева, поле справа»)
  return h("label", { class: "field" + (wide ? " wide" : "") + (grow ? " grow" : ""), title: tip }, h("span", { class: "field-label" }, label || ""), control);
}

export function textInput({ value = "", placeholder = "", onInput, mono, type = "text", tip, list, min, step } = {}) {
  const el = h("input", { type, placeholder, class: mono ? "mono" : "", title: tip, list, min, step });
  el.value = value == null ? "" : value;
  if (onInput) el.addEventListener("input", () => onInput(el.value));
  return el;
}

export function textArea({ value = "", placeholder = "", rows = 4, onInput, mono } = {}) {
  const el = h("textarea", { rows, placeholder, class: mono ? "mono" : "" });
  el.value = value || "";
  if (onInput) el.addEventListener("input", () => onInput(el.value));
  return el;
}

export function selectInput(options, value, onChange, { tip } = {}) {
  const el = h("select", { title: tip });
  for (const [v, l] of options) {
    const o = h("option", { value: v }, l);
    if (String(v) === String(value)) o.selected = true;
    el.append(o);
  }
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

export function checkbox(label, checked, onChange, { tip } = {}) {
  const input = h("input", { type: "checkbox" });
  input.checked = !!checked;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "check", title: tip }, input, h("span", {}, label));
}

// Переключатель из 2-3 вариантов в одну строку (вместо выпадающего списка)
export function segmented(options, value, onChange) {
  const wrap = h("div", { class: "segmented", role: "group" });
  for (const [v, l] of options) {
    const b = h("button", { type: "button", class: "seg" + (String(v) === String(value) ? " on" : ""), "aria-pressed": String(v) === String(value) }, l);
    b.addEventListener("click", () => {
      if (String(v) === String(value)) return;
      onChange(v);
    });
    wrap.append(b);
  }
  return wrap;
}

export function button(label, { kind = "default", onClick, tip, type = "button", disabled } = {}) {
  const b = h("button", { type, class: "btn " + kind.split(" ").map((k) => "btn-" + k).join(" "), title: tip, disabled }, label);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

// Маленькая кнопка с одним знаком (например, «×» для удаления строки)
export function iconButton(text, tip, onClick) {
  const b = h("button", { type: "button", class: "icon-btn", title: tip, "aria-label": tip }, text);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

// Сворачиваемый блок «Дополнительно»
export function disclosure(title, content, { open = false, badge } = {}) {
  const d = h("details", { class: "disclosure" }, h("summary", {}, h("span", {}, title), badge ? h("span", { class: "badge" }, badge) : null), h("div", { class: "disclosure-body" }, content));
  if (open) d.open = true;
  return d;
}

// ---------------- всплывающие окна ----------------

let openPopoverClose = null;

// Меню под элементом-якорем. Закрывается по клику снаружи и по Esc.
export function popover(anchor, content, { align = "left", cls = "" } = {}) {
  if (openPopoverClose) openPopoverClose();
  const pop = h("div", { class: "popover " + cls, role: "dialog" }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const place = () => {
    pop.style.maxHeight = "";
    const pr = pop.getBoundingClientRect();
    let left = align === "right" ? r.right - pr.width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
    // под якорем, если помещается; иначе над ним; иначе там, где места больше, с прокруткой внутри
    const below = window.innerHeight - r.bottom - 14;
    const above = r.top - 14;
    let top;
    if (pr.height <= below) top = r.bottom + 6;
    else if (pr.height <= above) top = r.top - pr.height - 6;
    else if (below >= above) {
      top = r.bottom + 6;
      pop.style.maxHeight = Math.max(160, below) + "px";
      pop.style.overflow = "auto";
    } else {
      pop.style.maxHeight = Math.max(160, above) + "px";
      pop.style.overflow = "auto";
      top = r.top - Math.min(pr.height, above) - 6;
    }
    pop.style.left = left + "px";
    pop.style.top = Math.max(8, top) + "px";
  };
  place();
  const close = () => {
    pop.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    if (openPopoverClose === close) openPopoverClose = null;
  };
  const onDown = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  openPopoverClose = close;
  return { close, el: pop, place };
}

// Список пунктов меню: [{ label, icon, onClick, danger, disabled }] или "-" для разделителя
export function menuList(items, close) {
  const list = h("div", { class: "menu-list" });
  for (const it of items) {
    if (it === "-") {
      list.append(h("div", { class: "menu-sep" }));
      continue;
    }
    const b = h("button", { type: "button", class: "menu-item" + (it.danger ? " danger" : ""), disabled: it.disabled }, it.icon ? h("span", { class: "menu-icon" }, it.icon) : null, h("span", {}, it.label));
    b.addEventListener("click", () => {
      close();
      it.onClick();
    });
    list.append(b);
  }
  return list;
}

export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
  const overlay = h("div", { class: "overlay" });
  const box = h("div", { class: "modal" + (wide ? " modal-wide" : ""), role: "dialog", "aria-modal": "true" });
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey, true);
  box.append(
    h("div", { class: "modal-head" }, h("h2", {}, title), iconButton("×", "Закрыть", close)),
    h("div", { class: "modal-body" }, body),
    actions.length ? h("div", { class: "modal-foot" }, actions) : null
  );
  overlay.append(box);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
  const first = box.querySelector("input, textarea, select");
  if (first) first.focus();
  return { close, el: box };
}

export function confirmDialog(message, { okText = "ОК", danger = false, title = "Подтверждение" } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title,
      body: h("p", { class: "plain" }, message),
      actions: [button("Отмена", { onClick: () => finish(false) }), button(okText, { kind: danger ? "solid-danger" : "primary", onClick: () => finish(true) })],
      onClose: () => finish(false),
    });
  });
}

let toastHost = null;
export function toast(message, kind = "info", ms = 3500) {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const t = h("div", { class: "toast toast-" + kind }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

// Скачивание текста как файла (blob:, без chrome.downloads - вызывается со страницы конструктора)
export function downloadText(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h("a", { href: url, download: name.split("/").pop() });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function insertAtCaret(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + text.length;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
