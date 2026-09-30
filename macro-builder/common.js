// Общие хелперы, используемые background.js, popup.js и builder.js.
// content.js их не импортирует - он инжектится в чужие страницы как classic-скрипт
// и дублирует у себя только то немногое, что реально нужно (см. content.js).

export const STORAGE_KEY = "mb_macros";
// Накопленные MD-отчёты { имяФайла: { text, updatedAt } } и прогресс циклов { "макрос:шаг": { sig, done } }
export const REPORTS_KEY = "mb_reports";
export const PROGRESS_KEY = "mb_progress";

export function uid(prefix = "s") {
  return prefix + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

export async function loadMacros() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

export async function saveMacros(macros) {
  await chrome.storage.local.set({ [STORAGE_KEY]: macros });
}

export function newMacro(name = "Новый макрос") {
  return {
    id: uid("m"),
    name,
    updatedAt: Date.now(),
    openInNewTab: false,
    inputs: [],
    triggers: [],
    steps: [],
  };
}

// Подставляет ${имя} в строке значениями из vars. Используется для url/selector/value
// шагов и для строкового представления числовых полей (count и т.п.).
export function substitute(str, vars) {
  if (typeof str !== "string" || !vars) return str;
  return str.replace(/\$\{([a-zA-Z_]\w*)\}/g, (_, key) => {
    if (key in vars) return String(vars[key]);
    if (key in BUILTIN_VARS) return BUILTIN_VARS[key]();
    return "";
  });
}

const pad2 = (n) => String(n).padStart(2, "0");
// Встроенные переменные: ${_now} 2026-09-30 14:05:09, ${_date} 2026-09-30, ${_time} 14:05:09
const BUILTIN_VARS = {
  _date: () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  },
  _time: () => {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  },
  _now: () => `${BUILTIN_VARS._date()} ${BUILTIN_VARS._time()}`,
};

// ---------------- проверки условий ----------------

export const TEST_KINDS = {
  element: "Элемент есть на странице",
  elementText: "Текст элемента сравнить со значением",
  var: "Сравнить два значения / переменные",
};

export function defaultTest(kind) {
  const base = { kind, negate: false, waitMs: 0 };
  const sel = { selectorType: "css", selector: "", frameUrlIncludes: "", scopeSelector: "", scopeText: "", visibleOnly: true };
  if (kind === "element") return { ...base, ...sel };
  if (kind === "elementText") {
    return { ...base, ...sel, attr: "text", op: "contains", value: "", which: "any", ignoreCase: true, yo: true, collapseSpaces: true, stripPunct: false };
  }
  return { ...base, kind: "var", left: "", op: "equals", right: "", ignoreCase: true, yo: true, collapseSpaces: true, stripPunct: false };
}

// Общие для ЛЮБОГО шага поля политики повтора при ошибке - добавляются поверх
// специфичных для типа полей, а не как отдельный тип шага.
const RETRY_DEFAULTS = { retries: 0, retryDelayMs: 800, onError: "stop" };
export const NO_RETRY_STEP_TYPES = [
  "exportCsv", "loadExcel", "setVar", "appendReport", "closeTab", "loopContinue", "loopBreak", "stopMacro",
];
// Поля области поиска (искать внутри строки/контейнера с нужным текстом) - у всех шагов с селектором
const SCOPE = { scopeSelector: "", scopeText: "" };

export function defaultStep(type) {
  const id = uid();
  let step;
  switch (type) {
    case "navigate":
      step = { id, type, url: "https://" };
      break;
    case "click":
      step = { id, type, selectorType: "css", selector: "", frameUrlIncludes: "", ...SCOPE, index: 0, timeoutMs: 8000 };
      break;
    case "clearField":
      step = { id, type, selectorType: "css", selector: "", frameUrlIncludes: "", ...SCOPE, index: 0, timeoutMs: 8000 };
      break;
    case "hover":
      step = { id, type, selectorType: "css", selector: "", frameUrlIncludes: "", ...SCOPE, index: 0, timeoutMs: 8000 };
      break;
    case "type":
      step = {
        id,
        type,
        selectorType: "css",
        selector: "",
        frameUrlIncludes: "",
        ...SCOPE,
        index: 0,
        value: "",
        clear: true,
        pressEnter: false,
        timeoutMs: 8000,
      };
      break;
    case "wait":
      step = { id, type, ms: 1000 };
      break;
    case "waitFor":
      step = { id, type, selectorType: "css", selector: "", frameUrlIncludes: "", ...SCOPE, timeoutMs: 15000 };
      break;
    case "extract":
      step = {
        id,
        type,
        selectorType: "css",
        selector: "",
        frameUrlIncludes: "",
        ...SCOPE,
        index: 0,
        attr: "text",
        varName: "result",
        multiple: false,
      };
      break;
    case "extractTable":
      step = {
        id,
        type,
        rowSelectorType: "css",
        rowSelector: "",
        frameUrlIncludes: "",
        varName: "rows",
        columns: [{ key: "col1", selector: "", attr: "text" }],
      };
      break;
    case "exportCsv":
      step = { id, type, sourceVar: "rows", filename: "export.csv" };
      break;
    case "loadExcel":
      // values - снимок столбца на момент выбора файла: сам файл макрос при запуске
      // не читает (у расширения нет доступа к файловой системе), поэтому он работает
      // и при запуске по расписанию/URL.
      step = {
        id,
        type,
        varName: "list",
        fileName: "",
        sheet: "",
        hasHeader: true,
        colIndex: 0,
        colLabel: "",
        trim: true,
        skipEmpty: true,
        unique: false,
        truncated: false,
        values: [],
        // mode "rows": несколько столбцов -> список строк-объектов, поля доступны как ${varName}
        mode: "column",
        columns: [],
        rows: [],
        // lengthRules: пропускать записи по длине значения [{ col, op, n, count }], skipped - сколько пропущено
        lengthRules: [],
        skipped: 0,
      };
      break;
    case "condition":
      step = { id, type, logic: "all", tests: [defaultTest("element")], timeoutMs: 8000, then: [], else: [] };
      break;
    case "switchTab":
      // source "popup" - ждать вкладку, открытую самой страницей (после клика);
      // "href" - открыть ссылку найденного элемента средствами расширения (без блокировщика окон)
      step = {
        id, type, source: "popup", selectorType: "css", selector: "", frameUrlIncludes: "", ...SCOPE, index: 0, timeoutMs: 10000,
      };
      break;
    case "closeTab":
      step = { id, type };
      break;
    case "setVar":
      step = { id, type, varName: "status", value: "", mode: "set" };
      break;
    case "appendReport":
      step = {
        id, type, filename: "report.md", header: "# Отчёт — ${_now}\n", template: "", resetPerRun: true,
      };
      break;
    case "loopContinue":
    case "loopBreak":
    case "stopMacro":
      step = { id, type };
      break;
    case "loopCount":
      step = { id, type, count: "3", itemVar: "i", steps: [] };
      break;
    case "loopList":
      step = {
        id, type, sourceKey: "", itemVar: "item", steps: [],
        // limit - обработать не больше N строк (0 = все); resume - помнить прогресс и продолжать с места остановки;
        // onRowError "continue" - ошибка в строке не останавливает цикл, выполняются catchSteps и идём дальше
        limit: 0, resume: false, onRowError: "stop", catchSteps: [],
      };
      break;
    case "customJs":
      step = {
        id,
        type,
        code: "// vars - переменные макроса\n// helpers.$(sel) / helpers.$$(sel) / await helpers.sleep(ms)\nreturn null;",
        saveTo: "",
        frameUrlIncludes: "",
      };
      break;
    case "keypress":
      step = { id, type, key: "Enter" };
      break;
    case "scroll":
      step = { id, type, mode: "bottom", selectorType: "css", selector: "", frameUrlIncludes: "", ...SCOPE };
      break;
    default:
      step = { id, type };
  }
  // exportCsv и loadExcel не выполняются на странице и не имеют смысла повторять по
  // таймауту элемента - retry им не нужен, оставляем как есть.
  if (NO_RETRY_STEP_TYPES.includes(type)) return step;
  return { ...step, ...RETRY_DEFAULTS };
}

export const STEP_LABELS = {
  navigate: "Открыть страницу",
  click: "Клик",
  type: "Ввести текст",
  clearField: "Очистить поле",
  wait: "Пауза",
  waitFor: "Дождаться элемента",
  extract: "Считать значение со страницы",
  extractTable: "Считать таблицу со страницы",
  exportCsv: "Сохранить таблицу в CSV",
  loadExcel: "Данные из Excel/CSV",
  condition: "Если … то … иначе",
  loopCount: "Повторить N раз",
  loopList: "Для каждой записи",
  customJs: "Свой JS-код",
  keypress: "Нажать клавишу",
  scroll: "Прокрутить страницу",
  hover: "Навести курсор",
  switchTab: "Перейти в новую вкладку",
  closeTab: "Закрыть вкладку",
  setVar: "Задать переменную",
  appendReport: "Записать в MD-отчёт",
  loopContinue: "К следующей записи",
  loopBreak: "Выйти из цикла",
  stopMacro: "Завершить макрос",
};

export const STEP_GROUPS = [
  { label: "Навигация", types: ["navigate", "wait", "waitFor", "scroll", "switchTab", "closeTab"] },
  { label: "Взаимодействие", types: ["click", "hover", "type", "clearField", "keypress"] },
  { label: "Данные", types: ["loadExcel", "extract", "extractTable", "setVar", "appendReport", "exportCsv"] },
  { label: "Логика", types: ["condition", "loopCount", "loopList", "loopContinue", "loopBreak", "stopMacro"] },
  { label: "Код", types: ["customJs"] },
];

// Шаги, у которых есть смысл в поле "селектор + фрейм" (используется builder.js,
// чтобы не дублировать список типов в разметке).
export const SELECTOR_STEP_TYPES = ["click", "hover", "type", "clearField", "waitFor", "extract", "extractTable", "condition", "switchTab"];

export function newTrigger(type) {
  const id = uid("t");
  if (type === "interval") return { id, type: "interval", everyMinutes: 60, enabled: true };
  if (type === "daily") return { id, type: "daily", atTime: "09:00", enabled: true };
  if (type === "urlMatch") return { id, type: "urlMatch", pattern: "https://example.com/*", enabled: true };
  return { id, type, enabled: true };
}

export const TRIGGER_LABELS = {
  interval: "Через интервал",
  daily: "Каждый день в",
  urlMatch: "При открытии URL",
};

// Простой glob (только *) -> RegExp, используется и в background.js (для сравнения
// с реальным URL вкладки), и потенциально в UI для валидации.
export function patternToRegex(pattern) {
  const esc = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + esc + "$");
}
