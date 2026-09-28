// Общие хелперы, используемые background.js, popup.js и builder.js.
// content.js их не импортирует - он инжектится в чужие страницы как classic-скрипт
// и дублирует у себя только то немногое, что реально нужно (см. content.js).

export const STORAGE_KEY = "mb_macros";

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
  return str.replace(/\$\{([a-zA-Z_]\w*)\}/g, (_, key) => (key in vars ? String(vars[key]) : ""));
}

// Общие для ЛЮБОГО шага поля политики повтора при ошибке - добавляются поверх
// специфичных для типа полей, а не как отдельный тип шага.
const RETRY_DEFAULTS = { retries: 0, retryDelayMs: 800, onError: "stop" };

export function defaultStep(type) {
  const id = uid();
  let step;
  switch (type) {
    case "navigate":
      step = { id, type, url: "https://" };
      break;
    case "click":
      step = { id, type, selectorType: "css", selector: "", frameUrlIncludes: "", index: 0, timeoutMs: 8000 };
      break;
    case "type":
      step = {
        id,
        type,
        selectorType: "css",
        selector: "",
        frameUrlIncludes: "",
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
      step = { id, type, selectorType: "css", selector: "", frameUrlIncludes: "", timeoutMs: 15000 };
      break;
    case "extract":
      step = {
        id,
        type,
        selectorType: "css",
        selector: "",
        frameUrlIncludes: "",
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
    case "condition":
      step = {
        id,
        type,
        selectorType: "css",
        selector: "",
        frameUrlIncludes: "",
        mode: "exists",
        timeoutMs: 3000,
        then: [],
        else: [],
      };
      break;
    case "loopCount":
      step = { id, type, count: "3", itemVar: "i", steps: [] };
      break;
    case "loopList":
      step = { id, type, sourceKey: "", itemVar: "item", steps: [] };
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
      step = { id, type, mode: "bottom", selectorType: "css", selector: "", frameUrlIncludes: "" };
      break;
    default:
      step = { id, type };
  }
  // exportCsv не выполняется на странице и не имеет смысла повторять по таймауту
  // элемента - retry ему не нужен, оставляем как есть.
  if (type === "exportCsv") return step;
  return { ...step, ...RETRY_DEFAULTS };
}

export const STEP_LABELS = {
  navigate: "Перейти по URL",
  click: "Клик по элементу",
  type: "Ввести текст",
  wait: "Пауза (мс)",
  waitFor: "Дождаться элемента",
  extract: "Извлечь данные",
  extractTable: "Извлечь таблицу",
  exportCsv: "Экспорт в CSV",
  condition: "Условие (элемент найден?)",
  loopCount: "Повторить N раз",
  loopList: "Для каждого значения из списка",
  customJs: "Свой JS-код",
  keypress: "Нажать клавишу",
  scroll: "Прокрутка страницы",
};

export const STEP_GROUPS = [
  { label: "Навигация", types: ["navigate", "wait", "waitFor", "scroll"] },
  { label: "Взаимодействие", types: ["click", "type", "keypress"] },
  { label: "Данные", types: ["extract", "extractTable", "exportCsv"] },
  { label: "Логика", types: ["condition", "loopCount", "loopList"] },
  { label: "Код", types: ["customJs"] },
];

// Шаги, у которых есть смысл в поле "селектор + фрейм" (используется builder.js,
// чтобы не дублировать список типов в разметке).
export const SELECTOR_STEP_TYPES = ["click", "type", "waitFor", "extract", "extractTable", "condition"];

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
