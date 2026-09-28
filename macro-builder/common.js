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
    steps: [],
  };
}

// Подставляет ${имя} в строке значениями из vars. Используется для url/selector/value
// шагов и для строкового представления числовых полей (count и т.п.).
export function substitute(str, vars) {
  if (typeof str !== "string" || !vars) return str;
  return str.replace(/\$\{([a-zA-Z_]\w*)\}/g, (_, key) => (key in vars ? String(vars[key]) : ""));
}

export function defaultStep(type) {
  const id = uid();
  switch (type) {
    case "navigate":
      return { id, type, url: "https://" };
    case "click":
      return { id, type, selectorType: "css", selector: "", index: 0, timeoutMs: 8000 };
    case "type":
      return {
        id,
        type,
        selectorType: "css",
        selector: "",
        index: 0,
        value: "",
        clear: true,
        pressEnter: false,
        timeoutMs: 8000,
      };
    case "wait":
      return { id, type, ms: 1000 };
    case "waitFor":
      return { id, type, selectorType: "css", selector: "", timeoutMs: 15000 };
    case "extract":
      return { id, type, selectorType: "css", selector: "", index: 0, attr: "text", varName: "result", multiple: false };
    case "condition":
      return { id, type, selectorType: "css", selector: "", mode: "exists", timeoutMs: 3000, then: [], else: [] };
    case "loopCount":
      return { id, type, count: "3", itemVar: "i", steps: [] };
    case "loopList":
      return { id, type, sourceKey: "", itemVar: "item", steps: [] };
    case "customJs":
      return {
        id,
        type,
        code: "// vars - переменные макроса\n// helpers.$(sel) / helpers.$$(sel) / await helpers.sleep(ms)\nreturn null;",
        saveTo: "",
      };
    case "keypress":
      return { id, type, key: "Enter" };
    case "scroll":
      return { id, type, mode: "bottom", selectorType: "css", selector: "" };
    default:
      return { id, type };
  }
}

export const STEP_LABELS = {
  navigate: "Перейти по URL",
  click: "Клик по элементу",
  type: "Ввести текст",
  wait: "Пауза (мс)",
  waitFor: "Дождаться элемента",
  extract: "Извлечь данные",
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
  { label: "Данные", types: ["extract"] },
  { label: "Логика", types: ["condition", "loopCount", "loopList"] },
  { label: "Код", types: ["customJs"] },
];
