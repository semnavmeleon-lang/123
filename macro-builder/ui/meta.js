// Чистая логика интерфейса (без DOM): иконки и категории шагов, человекочитаемое описание шага
// для свёрнутой карточки, проверка заполненности и сбор переменных для подсказок.

import { STEP_LABELS } from "../common.js";
import { OP_LABELS, UNARY_OPS, migrateCondition, progressSummary } from "../logic.js";

export const CATEGORIES = {
  nav: { label: "Страница и вкладки", color: "var(--c-nav)" },
  act: { label: "Действия на странице", color: "var(--c-act)" },
  data: { label: "Данные и отчёты", color: "var(--c-data)" },
  logic: { label: "Условия и циклы", color: "var(--c-logic)" },
  code: { label: "Код", color: "var(--c-code)" },
};

// tip - подсказка при наведении (на странице не выводится); cat - раздел палитры
export const STEP_META = {
  navigate: { cat: "nav", tip: "Перейти по адресу в текущей вкладке" },
  wait: { cat: "nav", tip: "Подождать заданное время" },
  waitFor: { cat: "nav", tip: "Ждать, пока на странице появится элемент" },
  scroll: { cat: "nav", tip: "Прокрутить страницу вниз или к элементу" },
  switchTab: { cat: "nav", tip: "Продолжить в новой вкладке, которую открыла страница" },
  closeTab: { cat: "nav", tip: "Закрыть вкладку, открытую макросом, и вернуться в прежнюю" },
  click: { cat: "act", tip: "Нажать на элемент страницы" },
  hover: { cat: "act", tip: "Навести курсор (для меню, раскрывающихся по наведению)" },
  type: { cat: "act", tip: "Вписать текст в поле" },
  clearField: { cat: "act", tip: "Стереть весь текст в поле" },
  keypress: { cat: "act", tip: "Нажать клавишу (Enter, Tab…)" },
  loadExcel: { cat: "data", tip: "Загрузить столбец или таблицу из файла Excel/CSV" },
  extract: { cat: "data", tip: "Считать текст или значение элемента в переменную" },
  extractTable: { cat: "data", tip: "Считать строки таблицы страницы в переменную" },
  setVar: { cat: "data", tip: "Записать значение в переменную или увеличить счётчик" },
  appendReport: { cat: "data", tip: "Дописать блок в Markdown-отчёт" },
  exportCsv: { cat: "data", tip: "Сохранить считанную таблицу в CSV-файл" },
  condition: { cat: "logic", tip: "Выполнить одни шаги, если проверки прошли, и другие, если нет" },
  loopList: { cat: "logic", tip: "Повторить шаги для каждой строки таблицы или значения списка" },
  loopCount: { cat: "logic", tip: "Повторить шаги заданное число раз" },
  loopContinue: { cat: "logic", tip: "Пропустить остаток текущей записи и перейти к следующей" },
  loopBreak: { cat: "logic", tip: "Прекратить цикл" },
  stopMacro: { cat: "logic", tip: "Завершить весь макрос (не ошибка)" },
  customJs: { cat: "code", tip: "Выполнить свой JavaScript на странице" },
};

// Порядок в палитре: сначала самое частое
export const PALETTE = [
  { cat: "nav", types: ["navigate", "wait", "waitFor", "switchTab", "closeTab", "scroll"] },
  { cat: "act", types: ["click", "type", "clearField", "hover", "keypress"] },
  { cat: "data", types: ["loadExcel", "extract", "extractTable", "setVar", "appendReport", "exportCsv"] },
  { cat: "logic", types: ["condition", "loopList", "loopCount", "loopContinue", "loopBreak", "stopMacro"] },
  { cat: "code", types: ["customJs"] },
];

export const stepTitle = (type) => STEP_LABELS[type] || type;

export function truncate(s, n = 60) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n} мс`;
  const sec = n / 1000;
  return `${Number.isInteger(sec) ? sec : sec.toFixed(1).replace(".", ",")} с`;
}

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};
export const pluralRu = plural;

const OP_SHORT = {
  equals: "=", contains: "содержит", containsWords: "содержит слова", startsWith: "начинается с", regex: "~",
  numEquals: "=", gt: ">", gte: "≥", lt: "<", lte: "≤", lenEq: "длина =", lenNeq: "длина ≠", lenGt: "длина >", lenGte: "длина ≥",
  lenLt: "длина <", lenLte: "длина ≤",
};

function scopeText(step) {
  if (!step.scopeSelector && !step.scopeText) return "";
  return ` · в строке «${truncate(step.scopeText || step.scopeSelector, 24)}»`;
}

function describeTest(t) {
  if (t.kind === "var") {
    const right = UNARY_OPS.includes(t.op) ? "" : ` ${truncate(t.right, 24)}`;
    return `${truncate(t.left, 24) || "…"} ${t.negate ? "НЕ " : ""}${OP_SHORT[t.op] || OP_LABELS[t.op] || t.op}${right}${UNARY_OPS.includes(t.op) ? ` (${OP_LABELS[t.op]})` : ""}`;
  }
  const sel = truncate(t.selector, 28) || "…";
  if (t.kind === "element") return `${sel} ${t.negate ? "нет" : "есть"} на странице`;
  const right = UNARY_OPS.includes(t.op) ? OP_LABELS[t.op] : `${OP_SHORT[t.op] || t.op} ${truncate(t.value, 24)}`;
  return `текст ${sel} ${t.negate ? "НЕ " : ""}${right}`;
}

// Краткое описание для свёрнутой карточки: что именно делает шаг
export function describeStep(step) {
  switch (step.type) {
    case "navigate":
      return truncate(step.url, 70);
    case "click":
    case "hover":
    case "clearField":
    case "waitFor":
      return truncate(step.selector, 50) + scopeText(step);
    case "type":
      return `${truncate(step.selector, 30)} ← ${truncate(step.value, 30)}${step.pressEnter ? " ⏎" : ""}${scopeText(step)}`;
    case "wait":
      return formatDuration(step.ms);
    case "scroll":
      return step.mode === "toElement" ? `к ${truncate(step.selector, 40)}` : "в конец страницы";
    case "keypress":
      return step.key || "";
    case "extract":
      return `${truncate(step.selector, 36)} → ${step.varName || "…"}${step.multiple ? " (список)" : ""}${scopeText(step)}`;
    case "extractTable":
      return `${truncate(step.rowSelector, 36)} → ${step.varName || "…"}`;
    case "exportCsv":
      return `${step.sourceVar || "…"} → ${step.filename || "export.csv"}`;
    case "loadExcel": {
      const rows = step.mode === "rows";
      const data = rows ? step.rows : step.values;
      if (!data || !data.length) return step.skipped ? "всё отсеяно правилами пропуска" : "файл не выбран";
      const n = data.length;
      const head = rows ? (step.columns || []).map((c) => c.varName).join(", ") : step.colLabel || "столбец";
      return `${n} ${rows ? plural(n, "строка", "строки", "строк") : plural(n, "значение", "значения", "значений")} · ${truncate(head, 40)}${step.skipped ? ` · пропущено ${step.skipped}` : ""}`;
    }
    case "setVar":
      return `${step.varName || "…"} ${step.mode === "increment" ? "+=" : "="} ${truncate(step.value, 30) || (step.mode === "increment" ? "1" : "")}`.trim();
    case "appendReport":
      return `→ ${step.filename || "report.md"}`;
    case "condition": {
      migrateCondition(step);
      const joiner = step.logic === "any" ? " ИЛИ " : " И ";
      return step.tests.map(describeTest).join(joiner);
    }
    case "loopList": {
      const parts = [`по ${step.sourceKey || "…"}`];
      if (Number(step.limit) > 0) parts.push(`не больше ${step.limit}`);
      if (step.onRowError === "continue") parts.push("ошибки не останавливают");
      if (step.resume) parts.push("с продолжением");
      return parts.join(" · ");
    }
    case "loopCount":
      return `${step.count || "…"} раз`;
    case "switchTab":
      return step.source === "href" ? `по ссылке ${truncate(step.selector, 30)}` : "открытую страницей";
    case "customJs":
      return truncate(String(step.code || "").split("\n").find((l) => l.trim() && !l.trim().startsWith("//")) || "", 60);
    default:
      return "";
  }
}

// ---------------- проверка заполненности ----------------

const SELECTOR_STEPS = ["click", "hover", "type", "clearField", "waitFor", "extract"];

export function validateStep(step) {
  const out = [];
  const need = (cond, msg) => {
    if (!cond) out.push(msg);
  };
  if (SELECTOR_STEPS.includes(step.type)) need(step.selector, "Укажите элемент на странице");
  switch (step.type) {
    case "navigate":
      need(step.url && !/^https?:\/\/$/i.test(step.url.trim()), "Укажите адрес страницы");
      break;
    case "scroll":
      if (step.mode === "toElement") need(step.selector, "Укажите элемент на странице");
      break;
    case "extract":
      need(step.varName, "Укажите имя переменной");
      break;
    case "extractTable":
      need(step.rowSelector, "Укажите селектор строк");
      need(step.varName, "Укажите имя переменной");
      break;
    case "exportCsv":
      need(step.sourceVar, "Укажите переменную с таблицей");
      break;
    case "keypress":
      need(step.key, "Укажите клавишу");
      break;
    case "loadExcel": {
      const rows = step.mode === "rows";
      const data = rows ? step.rows : step.values;
      if (rows && !(step.columns && step.columns.length)) out.push("Отметьте хотя бы один столбец");
      else if (!data || !data.length) out.push(step.skipped ? "Все записи отсеяны правилами пропуска" : "Выберите файл Excel или CSV");
      if (rows) {
        const names = (step.columns || []).map((c) => c.varName);
        if (names.some((n) => !/^[A-Za-z_]\w*$/.test(n || "")) || new Set(names).size !== names.length) out.push("Имена переменных: латиница, цифры и _, без повторов");
      }
      need(step.varName, "Укажите имя переменной");
      break;
    }
    case "setVar":
      need(step.varName, "Укажите имя переменной");
      break;
    case "appendReport":
      need(String(step.template || "").trim(), "Введите, что записывать в отчёт");
      break;
    case "condition": {
      migrateCondition(step);
      if (!step.tests.length) out.push("Добавьте хотя бы одну проверку");
      step.tests.forEach((t, i) => {
        const n = step.tests.length > 1 ? ` (проверка ${i + 1})` : "";
        if (t.kind !== "var") need(t.selector, "Укажите элемент на странице" + n);
        if (t.kind === "elementText" && !UNARY_OPS.includes(t.op)) need(String(t.value || "").trim(), "Укажите, с чем сравнивать" + n);
        if (t.kind === "var") need(String(t.left || "").trim() || String(t.right || "").trim(), "Заполните значения для сравнения" + n);
      });
      break;
    }
    case "loopList":
      need(step.sourceKey, "Выберите, по чему повторять");
      need((step.steps || []).length, "Добавьте шаги внутрь цикла");
      break;
    case "loopCount":
      need(String(step.count ?? "").trim(), "Укажите число повторов");
      need((step.steps || []).length, "Добавьте шаги внутрь цикла");
      break;
    case "switchTab":
      if (step.source === "href") need(step.selector, "Укажите элемент со ссылкой");
      break;
    case "customJs":
      need(String(step.code || "").replace(/\/\/.*$/gm, "").replace(/return\s+null;?/g, "").trim(), "Введите код");
      break;
    default:
  }
  return out;
}

function walk(steps, fn, path = []) {
  (steps || []).forEach((s, i) => {
    fn(s, [...path, i + 1]);
    walk(s.steps, fn, [...path, i + 1]);
    walk(s.then, fn, [...path, i + 1]);
    walk(s.else, fn, [...path, i + 1]);
    walk(s.catchSteps, fn, [...path, i + 1]);
  });
}
export { walk as walkSteps };

// [{ stepId, path: "3.1", message }]
export function validateMacro(macro) {
  const out = [];
  walk(macro.steps, (s, path) => {
    for (const message of validateStep(s)) out.push({ stepId: s.id, path: path.join("."), message });
  });
  out.push(...scopeIssues(macro));
  return out;
}

// ---------------- где какие переменные доступны ----------------

const VAR_RE = /\$\{([a-zA-Z_]\w*)\}/g;
const BUILTIN_NAMES = ["_now", "_date", "_time"];

// Имена ${...}, которые шаг подставляет в свои поля (без вложенных шагов)
function usedNames(step) {
  const texts = [];
  const add = (v) => typeof v === "string" && texts.push(v);
  for (const k of ["url", "selector", "value", "rowSelector", "scopeSelector", "scopeText", "count", "filename", "template", "header"]) add(step[k]);
  if (step.type === "condition") {
    migrateCondition(step);
    for (const t of step.tests || []) for (const k of ["selector", "scopeSelector", "scopeText", "value", "left", "right"]) add(t[k]);
  }
  const names = new Set();
  for (const t of texts) for (const m of t.matchAll(VAR_RE)) names.add(m[1]);
  return [...names];
}

// Что шаг сам кладёт в переменные
function definedBy(step) {
  const out = [];
  if (["loadExcel", "extract", "extractTable", "setVar"].includes(step.type) && step.varName) out.push(step.varName);
  if (step.type === "customJs" && step.saveTo) out.push(step.saveTo);
  return out;
}

function definedInside(steps, acc = new Set()) {
  walk(steps, (s) => definedBy(s).forEach((n) => acc.add(n)));
  return acc;
}

// Предупреждения: ${переменная} используется там, где её ещё нет (например, столбец таблицы вне цикла
// «Для каждой записи»), и цикл по списку, которого нет до него. Только то, в чём можно быть уверенным.
export function scopeIssues(macro) {
  const out = [];
  const all = [];
  walk(macro && macro.steps, (s) => all.push(s));
  const columnOwner = new Map(); // имя столбца -> имя переменной таблицы
  for (const s of all) if (s.type === "loadExcel" && s.mode === "rows") (s.columns || []).forEach((c) => c.varName && columnOwner.set(c.varName, s.varName));

  const base = new Set([...BUILTIN_NAMES]);
  for (const i of (macro && macro.inputs) || []) if (i.key) base.add(i.key);

  const visit = (steps, defined, pathPrefix, extra = {}) => {
    (steps || []).forEach((st, idx) => {
      const path = [...pathPrefix, idx + 1].join(".");
      const missing = extra.open ? [] : usedNames(st).filter((n) => !defined.has(n));
      if (missing.length) {
        const n = missing[0];
        const message = columnOwner.has(n)
          ? `Значение \${${n}} - столбец таблицы, он доступен только внутри шага «Для каждой записи»: нажмите «В цикл» вверху панели, и этот шаг вместе с шагами ниже окажется в цикле`
          : `Переменная \${${n}} здесь ещё не задана: она должна получить значение в шаге выше`;
        out.push({ stepId: st.id, path, message, fix: columnOwner.has(n) ? "wrap" : "" });
      }
      if (st.type === "loopList" && st.sourceKey && !defined.has(st.sourceKey)) {
        out.push({ stepId: st.id, path, message: `Список «${st.sourceKey}» не найден до этого шага: шаг «Данные из Excel/CSV» с таким именем должен стоять выше цикла` });
      }
      if (st.type === "loopList" || st.type === "loopCount") {
        const inner = new Set(defined);
        definedInside(st.steps).forEach((n) => inner.add(n)); // значения переходят из прохода в проход
        inner.add(st.itemVar || (st.type === "loopList" ? "item" : "i"));
        let open = !!extra.open;
        if (st.type === "loopList") {
          inner.add("_index");
          inner.add("_total");
          const src = all.find((x) => x.type === "loadExcel" && x.varName === st.sourceKey);
          const tbl = all.find((x) => x.type === "extractTable" && x.varName === st.sourceKey);
          if (src && src.mode === "rows") {
            (src.columns || []).forEach((c) => c.varName && inner.add(c.varName));
            inner.add("_row");
          } else if (tbl) {
            (tbl.columns || []).forEach((c) => c.key && inner.add(c.key));
          } else if (!src) {
            open = true; // источник неизвестен (параметр запуска и т. п.) - поля записи проверить нельзя
          }
        }
        visit(st.steps, inner, [...pathPrefix, idx + 1], { open });
        if (st.type === "loopList") visit(st.catchSteps, new Set([...inner, "_error"]), [...pathPrefix, idx + 1], { open });
      } else {
        visit(st.then, defined, [...pathPrefix, idx + 1], extra);
        visit(st.else, defined, [...pathPrefix, idx + 1], extra);
      }
      definedBy(st).forEach((n) => defined.add(n));
      definedInside(st.then).forEach((n) => defined.add(n));
      definedInside(st.else).forEach((n) => defined.add(n));
    });
  };
  visit(macro && macro.steps, base, []);
  return out;
}

// Значения-образцы для «Проверить шаг» и «Показать на странице»: как если бы шаг выполнялся на первой записи
// загруженной таблицы (столбцы, ${_row}, текущая запись цикла), плюс значения параметров запуска по умолчанию
export function buildSampleVars(macro) {
  const vars = {};
  for (const i of (macro && macro.inputs) || []) if (i.key) vars[i.key] = i.default || "";
  const all = [];
  walk(macro && macro.steps, (s) => all.push(s));
  const itemNames = (listName) => {
    const names = all.filter((s) => s.type === "loopList" && s.sourceKey === listName).map((s) => s.itemVar || "item");
    return names.length ? names : ["item"];
  };
  let first = null;
  for (const s of all) {
    if (s.type !== "loadExcel") continue;
    if (s.mode === "rows") {
      if (s.rows && s.rows[0]) {
        Object.assign(vars, s.rows[0]);
        first = first || { row: s.rows[0], total: s.rows.length };
      }
    } else if (s.values && s.values.length) {
      for (const n of itemNames(s.varName)) vars[n] = s.values[0];
      first = first || { total: s.values.length };
    }
  }
  if (first) {
    vars._index = 1;
    vars._total = first.total;
  }
  return vars;
}

// «fio = Иванов И. И.; polis = 2547…» - что подставилось при проверке шага (пусто, если таблицы нет)
export function describeSampleVars(macro) {
  const vars = buildSampleVars(macro);
  const parts = [];
  walk(macro && macro.steps, (s) => {
    if (s.type !== "loadExcel") return;
    if (s.mode === "rows" && s.rows && s.rows[0]) (s.columns || []).forEach((c) => parts.push(`${c.varName} = «${truncate(vars[c.varName], 30)}»`));
    else if (s.values && s.values.length) parts.push(`${s.varName} (первое значение) = «${truncate(s.values[0], 30)}»`);
  });
  return parts.join("; ");
}

// ---------------- переменные для подсказок ----------------

// all - все имена, которые можно подставить как ${имя}; lists - те, что годятся для «Для каждой записи»
export function collectVars(macro) {
  const all = new Set(["_row", "_index", "_total", "_error", "_now", "_date", "_time"]);
  const lists = new Set();
  for (const i of (macro && macro.inputs) || []) {
    if (!i.key) continue;
    all.add(i.key);
    if (i.multiline) lists.add(i.key);
  }
  walk(macro && macro.steps, (st) => {
    if (st.type === "loadExcel") {
      if (st.varName) lists.add(st.varName);
      if (st.mode === "rows") (st.columns || []).forEach((c) => c.varName && all.add(c.varName));
    }
    if (st.type === "extract" && st.varName) {
      all.add(st.varName);
      if (st.multiple) lists.add(st.varName);
    }
    if (st.type === "extractTable" && st.varName) lists.add(st.varName);
    if (st.type === "setVar" && st.varName) all.add(st.varName);
    if (st.type === "customJs" && st.saveTo) all.add(st.saveTo);
    if ((st.type === "loopList" || st.type === "loopCount") && st.itemVar) all.add(st.itemVar);
  });
  lists.forEach((n) => all.add(n));
  return { all: [...all], lists: [...lists] };
}

// Источники значений для полей «Что ввести», «Содержит текст», «Значение»: столбцы загруженной таблицы,
// текущая запись цикла, остальные переменные и служебные значения. Каждый элемент - { value: "${имя}", label }.
export function collectValueSources(macro) {
  const seen = new Set();
  const groups = [];
  const add = (label, items) => {
    if (items.length) groups.push({ label, items });
  };
  const item = (name, label) => {
    seen.add(name);
    return { value: "${" + name + "}", label };
  };

  const columns = [];
  walk(macro && macro.steps, (st) => {
    if (st.type !== "loadExcel" || st.mode !== "rows") return;
    for (const c of st.columns || []) {
      if (c.varName && !seen.has(c.varName)) columns.push(item(c.varName, c.header ? `${c.header}  (${c.varName})` : c.varName));
    }
  });
  add("Столбцы таблицы", columns);

  const loops = [];
  // у цикла по строкам таблицы «текущая запись» - целая строка, а не текст: вместо неё выбирают столбцы
  const tableLists = new Set();
  walk(macro && macro.steps, (st) => {
    if (st.type === "loadExcel" && st.mode === "rows" && st.varName) tableLists.add(st.varName);
  });
  walk(macro && macro.steps, (st) => {
    if (st.type === "loopList" && tableLists.has(st.sourceKey)) return;
    if ((st.type === "loopList" || st.type === "loopCount") && st.itemVar && !seen.has(st.itemVar)) {
      loops.push(item(st.itemVar, st.type === "loopList" ? `Текущая запись цикла  (${st.itemVar})` : `Номер повтора  (${st.itemVar})`));
    }
  });
  add("Цикл", loops);

  const others = [];
  for (const i of (macro && macro.inputs) || []) if (i.key && !seen.has(i.key)) others.push(item(i.key, `Параметр запуска  (${i.key})`));
  walk(macro && macro.steps, (st) => {
    const name = st.type === "customJs" ? st.saveTo : ["extract", "setVar"].includes(st.type) ? st.varName : "";
    if (name && !seen.has(name)) others.push(item(name, `Значение со страницы  (${name})`));
  });
  add("Другие переменные", others);

  add("Служебные", [
    item("_row", "Номер строки Excel  (_row)"),
    item("_index", "Номер записи в цикле  (_index)"),
    item("_total", "Всего записей  (_total)"),
    item("_error", "Текст ошибки  (_error)"),
    item("_date", "Сегодняшняя дата  (_date)"),
    item("_time", "Текущее время  (_time)"),
    item("_now", "Дата и время  (_now)"),
  ]);
  return groups;
}

// ---------------- прогресс по записям ----------------

// Циклы с сохранением прогресса: { step, list }; list - записи из шага «Данные из Excel/CSV», если источник цикла известен
export function resumeLoops(macro) {
  const all = [];
  walk(macro && macro.steps, (s) => all.push(s));
  return all
    .filter((s) => s.type === "loopList" && s.resume)
    .map((step) => {
      const src = all.find((x) => x.type === "loadExcel" && x.varName === step.sourceKey);
      const list = src ? (src.mode === "rows" ? src.rows : src.values) : null;
      return { step, list: Array.isArray(list) ? list : null };
    });
}

// Сводки сохранённого прогресса макроса, в которых есть что продолжать: [{ step, sum }]
export function resumableProgress(macro, allProgress, macroId) {
  const out = [];
  for (const { step, list } of resumeLoops(macro)) {
    const sum = progressSummary((allProgress || {})[`${macroId || macro.id}:${step.id}`], list);
    if (sum && sum.done > 0 && (!sum.total || sum.done < sum.total)) out.push({ step, sum });
  }
  return out;
}

const fmtWhen = (at) => (at ? new Date(at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");

// Текст статуса прогресса для панели цикла: { kind: "none" | "ok" | "warn", text }
export function describeProgress(sum) {
  if (!sum) return { kind: "none", text: "Сохранённого прогресса нет: запуск начнётся с первой записи" };
  if (!sum.done) return { kind: "none", text: "Сохранённый прогресс не относится к этой таблице (записей не найдено): запуск начнётся с первой записи" };
  if (sum.total && sum.done >= sum.total) return { kind: "warn", text: `Все записи (${sum.total}) уже обработаны: следующий запуск пройдёт таблицу с начала` };
  const parts = [`Обработано ${sum.done} из ${sum.total || "?"}`, `следующая запись - ${sum.next}`];
  if (sum.foreign) parts.push(`${sum.foreign} ранее обработанных в таблице не найдено`);
  const when = fmtWhen(sum.at);
  if (when) parts.push(`сохранено ${when}`);
  return { kind: sum.foreign ? "warn" : "ok", text: parts.join(" · ") };
}

// Помещает шаги arr[idx..] (этот и все ниже) в один цикл `loop`. Цикл по тому же списку внутри диапазона не вкладывается
// в новый, а раскрывается: его шаги встают на место, а настройки (ошибки, лимит, прогресс) переходят новому циклу.
export function wrapRangeInLoop(arr, idx, loop) {
  const range = arr.splice(idx);
  const inner = range.find((s) => s.type === "loopList" && s.sourceKey);
  if (inner) loop.sourceKey = inner.sourceKey;
  const steps = [];
  let adopted = false;
  for (const st of range) {
    if (st.type === "loopList" && st.sourceKey === loop.sourceKey) {
      if (!adopted) {
        for (const k of ["itemVar", "limit", "resume", "onRowError", "catchSteps"]) if (st[k] !== undefined) loop[k] = st[k];
        adopted = true;
      }
      steps.push(...(st.steps || []));
    } else {
      steps.push(st);
    }
  }
  loop.steps = steps;
  arr.push(loop);
  return loop;
}
