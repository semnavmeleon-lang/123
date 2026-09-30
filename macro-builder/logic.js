// Чистая логика без DOM и chrome.*: сравнение текста, условия из нескольких проверок,
// подпись списка для «продолжить с места остановки», имена переменных из заголовков.
// Вынесено отдельно, чтобы покрыть тестами под Node (см. tests/logic.test.mjs).

import { substitute, defaultTest, TEST_KINDS, uid } from "./common.js";

export { defaultTest, TEST_KINDS };

// ---------------- нормализация и сравнение текста ----------------

export const DEFAULT_NORM = { ignoreCase: true, collapseSpaces: true, yo: true, stripPunct: false };

export function normalizeText(s, opts) {
  const o = { ...DEFAULT_NORM, ...(opts || {}) };
  let t = String(s ?? "");
  if (o.yo) t = t.replace(/ё/g, "е").replace(/Ё/g, "Е");
  if (o.ignoreCase) t = t.toLowerCase();
  if (o.stripPunct) t = t.replace(/[^\p{L}\p{N}\s]/gu, " ");
  if (o.collapseSpaces) t = t.replace(/\s+/g, " ");
  return t.trim();
}

// "1 234,50 ₽" -> 1234.5, нет числа -> NaN
export function parseNumber(s) {
  const t = String(s ?? "").replace(/[\s ]/g, "").replace(",", ".");
  const m = t.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

function words(s) {
  return normalizeText(s, { stripPunct: true }).split(" ").filter(Boolean);
}

// Все слова из expected есть в actual, порядок не важен. Слово из одной буквы считается
// инициалом: «Ю» совпадает с «Юрий» и наоборот («Тишин Ю.Р.» ~ «Тишин Юрий Романович»).
function containsWords(actual, expected) {
  const need = words(expected);
  if (!need.length) return false;
  const have = words(actual);
  return need.every((e) =>
    have.some((a) => a === e || (a.length === 1 && e.startsWith(a)) || (e.length === 1 && a.startsWith(e)))
  );
}

export const OP_LABELS = {
  equals: "равно",
  contains: "содержит",
  containsWords: "содержит все слова",
  startsWith: "начинается с",
  regex: "подходит под регулярное выражение",
  empty: "пусто",
  notEmpty: "не пусто",
  lenEq: "длина (символов) равна",
  lenNeq: "длина (символов) НЕ равна",
  lenGt: "длина больше",
  lenGte: "длина больше или равна",
  lenLt: "длина меньше",
  lenLte: "длина меньше или равна",
  numEquals: "= (число)",
  gt: "> (число)",
  gte: "≥ (число)",
  lt: "< (число)",
  lte: "≤ (число)",
};
// Подсказки к операциям (показываются только при наведении)
export const OP_TIPS = {
  containsWords: "Порядок слов не важен; инициал «Ю.» совпадает с «Юрий». Подходит для сравнения ФИО.",
  contains: "Пустое значение никогда не считается «содержащимся» - строка без данных не пройдёт проверку.",
  regex: "Регулярное выражение без учёта регистра, например \\d{5}CFI\\d+",
};
// Операции, которым не нужно значение справа
export const UNARY_OPS = ["empty", "notEmpty"];

// Пустое ожидаемое значение не «содержится» ни в чём: иначе строка с незаполненным ФИО
// сошлась бы с любым результатом поиска и молча прошла проверку.
export function compareText(op, actual, expected, norm) {
  const na = normalizeText(actual, norm);
  const ne = normalizeText(expected, norm);
  switch (op) {
    case "equals":
      return na === ne;
    case "contains":
      return ne !== "" && na.includes(ne);
    case "startsWith":
      return ne !== "" && na.startsWith(ne);
    case "containsWords":
      return containsWords(actual, expected);
    case "regex": {
      let re;
      try {
        re = new RegExp(String(expected ?? ""), (norm && norm.ignoreCase === false) ? "" : "i");
      } catch (e) {
        throw new Error("Некорректное регулярное выражение: " + expected);
      }
      return re.test(String(actual ?? ""));
    }
    case "lenEq":
    case "lenNeq":
    case "lenGt":
    case "lenGte":
    case "lenLt":
    case "lenLte": {
      const n = Number(String(expected ?? "").trim());
      if (String(expected ?? "").trim() === "" || !Number.isFinite(n)) return false;
      const len = [...String(actual ?? "").trim()].length;
      if (op === "lenEq") return len === n;
      if (op === "lenNeq") return len !== n;
      if (op === "lenGt") return len > n;
      if (op === "lenGte") return len >= n;
      if (op === "lenLt") return len < n;
      return len <= n;
    }
    case "empty":
      return na === "";
    case "notEmpty":
      return na !== "";
    case "numEquals":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = parseNumber(actual);
      const b = parseNumber(expected);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (op === "numEquals") return a === b;
      if (op === "gt") return a > b;
      if (op === "gte") return a >= b;
      if (op === "lt") return a < b;
      return a <= b;
    }
    default:
      throw new Error("Неизвестная операция сравнения: " + op);
  }
}

// ---------------- условия ----------------

// Старые макросы хранили одиночную проверку "элемент найден / не найден" прямо в шаге
// (selector, mode). Приводим к новой форме - список проверок + логика И/ИЛИ.
export function migrateCondition(step) {
  if (!Array.isArray(step.tests)) {
    step.tests = [
      {
        ...defaultTest("element"),
        selectorType: step.selectorType || "css",
        selector: step.selector || "",
        frameUrlIncludes: step.frameUrlIncludes || "",
        negate: step.mode === "notExists",
        waitMs: 0,
        visibleOnly: false, // как раньше: считались и скрытые элементы
      },
    ];
  }
  if (step.logic !== "any") step.logic = "all";
  return step;
}

function normOf(t) {
  return { ignoreCase: t.ignoreCase !== false, yo: t.yo !== false, collapseSpaces: t.collapseSpaces !== false, stripPunct: !!t.stripPunct };
}

function short(s, n = 60) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function resolveTest(t, vars) {
  const r = { ...t };
  for (const k of ["selector", "scopeSelector", "scopeText", "value", "left", "right"]) {
    if (typeof r[k] === "string") r[k] = substitute(r[k], vars);
  }
  return r;
}

async function evalOnce(t, deps) {
  if (t.kind === "var") {
    const ok = compareText(t.op, t.left, t.right, normOf(t));
    return { ok, info: `«${short(t.left)}» ${OP_LABELS[t.op] || t.op}${UNARY_OPS.includes(t.op) ? "" : ` «${short(t.right)}»`}` };
  }
  if (!t.selector) throw new Error("В проверке не указан селектор");
  if (t.kind === "element") {
    const res = await deps.probe(t, false);
    const count = (res && res.count) || 0;
    return { ok: count > 0, info: `найдено элементов: ${count}` };
  }
  // elementText
  const res = await deps.probe(t, true);
  const texts = (res && res.texts) || [];
  const norm = normOf(t);
  const hit = (x) => compareText(t.op, x, t.value, norm);
  let ok = false;
  if (t.which === "first") ok = texts.length > 0 && hit(texts[0]);
  else if (t.which === "all") ok = texts.length > 0 && texts.every(hit);
  else ok = texts.some(hit);
  const shown = texts.slice(0, 4).map((x) => `«${short(x)}»`).join(" | ");
  const opTxt = `${OP_LABELS[t.op] || t.op}${UNARY_OPS.includes(t.op) ? "" : ` «${short(t.value)}»`}`;
  return { ok, info: `элементов: ${texts.length}${shown ? `; тексты: ${shown}` : ""}; условие: ${opTxt}` };
}

// deps: { probe(test, wantTexts) -> Promise<{count, texts}>, sleep(ms), now(), cancelled() }
// Возвращает { result, log }. "all" - И (останавливается на первой ложной проверке),
// "any" - ИЛИ (на первой истинной). У проверки с waitMs>0 результат опрашивается до тех пор,
// пока не станет истинным (после «НЕ»), но не дольше waitMs.
export async function evaluateCondition(step, vars, deps) {
  migrateCondition(step);
  if (!step.tests.length) throw new Error("В условии нет ни одной проверки");
  const log = [];
  const isAny = step.logic === "any";
  let result = !isAny;
  for (const raw of step.tests) {
    const t = resolveTest(raw, vars);
    const deadline = deps.now() + (Number(t.waitMs) || 0);
    let final;
    let info;
    for (;;) {
      const out = await evalOnce(t, deps);
      final = t.negate ? !out.ok : out.ok;
      info = out.info;
      if (final || deps.now() >= deadline || (deps.cancelled && deps.cancelled())) break;
      await deps.sleep(300);
    }
    log.push(`${final ? "✔" : "✘"} ${t.negate ? "НЕ: " : ""}${TEST_KINDS[t.kind] || t.kind}: ${info}`);
    if (isAny && final) {
      result = true;
      break;
    }
    if (!isAny && !final) {
      result = false;
      break;
    }
  }
  return { result, log };
}

// ---------------- прогресс цикла ----------------

// Подпись списка: если таблицу заменили, сохранённый прогресс к ней уже не относится.
export function listSignature(list) {
  const s = JSON.stringify(list);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${list.length}:${h.toString(16)}`;
}

// ---------------- имена переменных из заголовков таблицы ----------------

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

// «ФИО» -> fio, «Номер полиса» -> nomer_polisa; нечитаемое -> col{N}. used - уже занятые имена.
export function suggestVarName(header, index, used = []) {
  const taken = new Set(used);
  let base = String(header || "")
    .toLowerCase()
    .split("")
    .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
    .join("")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base || /^\d/.test(base)) base = "col" + (index + 1) + (base ? "_" + base : "");
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  return name;
}

// ---------------- MD-отчёт ----------------

// Имя файла внутри папки «Загрузки»: без абсолютных путей, «..» и запрещённых символов.
export function sanitizeReportName(name) {
  let n = String(name || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  if (!n) n = "report.md";
  if (!/\.[A-Za-z0-9]{1,5}$/.test(n)) n += ".md";
  return n;
}

// Дописывает блок в конец буфера, гарантируя перевод строки между блоками.
export function appendBlock(buffer, block) {
  const b = String(block ?? "");
  const nb = b.endsWith("\n") ? b : b + "\n";
  if (!buffer) return nb;
  return buffer + (buffer.endsWith("\n") ? "" : "\n") + nb;
}

export function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// data:-ссылка для chrome.downloads ограничена ~2 МБ, поэтому длинный отчёт режется по строкам
// на части не больше maxBytes (в UTF-8).
export function splitReport(text, maxBytes = 1400000) {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return [text];
  const parts = [];
  let cur = "";
  let curBytes = 0;
  // строки вместе с их переводом строки, чтобы склейка частей давала ровно исходный текст
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const lb = enc.encode(line).length;
    if (cur && curBytes + lb > maxBytes) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += line;
    curBytes += lb;
  }
  if (cur) parts.push(cur);
  return parts;
}

// report.md + (2 из 3) -> report-2.md
export function partFileName(name, index, total) {
  if (total <= 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${index + 1}${name.slice(dot)}` : `${name}-${index + 1}`;
}

// ---------------- конфиг: сохранение и загрузка всех макросов ----------------

export const CONFIG_FORMAT = "macro-builder-config";

function walkSteps(steps, fn) {
  for (const s of steps || []) {
    fn(s);
    walkSteps(s.steps, fn);
    walkSteps(s.then, fn);
    walkSteps(s.else, fn);
    walkSteps(s.catchSteps, fn);
  }
}

const hasTableData = (st) => (st.values && st.values.length) || (st.rows && st.rows.length);

// Значения таблицы внутри шагов «Загрузить данные из Excel/CSV» - это выгрузка с персональными данными
// клиентов. В конфиг по умолчанию они не попадают: остаются настройки (лист, столбцы, имена переменных).
export function stripTableData(macro) {
  const copy = JSON.parse(JSON.stringify(macro));
  walkSteps(copy.steps, (st) => {
    if (st.type === "loadExcel") {
      st.values = [];
      st.rows = [];
      st.truncated = false;
    }
  });
  return copy;
}

export function buildConfig(macros, { includeData = false } = {}) {
  return {
    format: CONFIG_FORMAT,
    version: 2,
    exportedAt: new Date().toISOString(),
    includesTableData: !!includeData,
    macros: macros.map((m) => (includeData ? JSON.parse(JSON.stringify(m)) : stripTableData(m))),
  };
}

function normalizeMacro(m) {
  if (!m || typeof m !== "object" || !Array.isArray(m.steps || [])) throw new Error("это не макрос");
  const out = { ...m };
  out.name = out.name || "Без имени";
  out.inputs = Array.isArray(out.inputs) ? out.inputs : [];
  out.triggers = Array.isArray(out.triggers) ? out.triggers : [];
  out.steps = Array.isArray(out.steps) ? out.steps : [];
  return out;
}

// Понимает и конфиг целиком ({format, macros}), и старый экспорт одного макроса ([макрос] или макрос).
export function parseImport(data) {
  if (data && !Array.isArray(data) && data.format === CONFIG_FORMAT) {
    if (!Array.isArray(data.macros)) throw new Error("в конфиге нет списка макросов");
    return { kind: "config", macros: data.macros.map(normalizeMacro) };
  }
  const list = Array.isArray(data) ? data : [data];
  if (!list.length) throw new Error("в файле нет макросов");
  return { kind: "macros", macros: list.map(normalizeMacro) };
}

// Конфиг загружается «по id»: макрос с тем же id заменяется, остальные добавляются. Если в файле
// данных таблицы нет (экспорт без них), а в браузере они уже есть - сохраняем имеющиеся.
export function mergeConfig(existing, imported) {
  const result = existing.map((m) => m);
  let added = 0;
  let replaced = 0;
  for (const im of imported) {
    const m = { ...im, id: im.id || uid("m") };
    const idx = result.findIndex((x) => x.id === m.id);
    if (idx === -1) {
      result.push(m);
      added++;
      continue;
    }
    const old = {};
    walkSteps(result[idx].steps, (st) => {
      if (st.type === "loadExcel" && hasTableData(st)) old[st.id] = st;
    });
    walkSteps(m.steps, (st) => {
      if (st.type === "loadExcel" && !hasTableData(st) && old[st.id]) {
        const o = old[st.id];
        st.values = o.values || [];
        st.rows = o.rows || [];
        st.truncated = !!o.truncated;
        st.fileName = st.fileName || o.fileName;
      }
    });
    result[idx] = m;
    replaced++;
  }
  return { macros: result, added, replaced };
}

// Импорт «одного макроса» (старый способ): всегда как копии с новыми id, чтобы не затереть существующие.
export function importAsCopies(imported) {
  return imported.map((m) => ({ ...m, id: uid("m") }));
}
