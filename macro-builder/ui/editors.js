// Редакторы шагов. У каждого шага «Основное» - только то, что нужно почти всегда;
// редкие настройки (номер совпадения, таймауты, iframe, повторы) спрятаны в «Дополнительно».
// Пояснения даются подсказками при наведении, а не текстом под полями.

import { h, field, textInput, textArea, selectInput, checkbox, segmented, disclosure, button, iconButton, popover, menuList } from "./dom.js";
import { defaultTest } from "../common.js";
import { OP_LABELS, OP_TIPS, UNARY_OPS, migrateCondition } from "../logic.js";
import { dataStepBody } from "./data-step.js";

const NO_BODY = ["closeTab", "loopContinue", "loopBreak", "stopMacro"];
export const hasBody = (step) => !NO_BODY.includes(step.type);

// Вложенные списки шагов контейнеров - показываются всегда (структура макроса), даже когда настройки свёрнуты
export function branchesOf(step) {
  if (step.type === "condition") {
    step.then = step.then || [];
    step.else = step.else || [];
    return [{ kind: "then", label: "Тогда", arr: step.then }, { kind: "else", label: "Иначе", arr: step.else }];
  }
  if (step.type === "loopList" || step.type === "loopCount") {
    step.steps = step.steps || [];
    const out = [{ kind: "each", label: step.type === "loopList" ? "Для каждой записи" : "Повторять", arr: step.steps }];
    if (step.type === "loopList" && step.onRowError === "continue") {
      step.catchSteps = step.catchSteps || [];
      out.push({ kind: "catch", label: "При ошибке в записи", arr: step.catchSteps });
    }
    return out;
  }
  return [];
}

// Повтор при ошибке имеет смысл только для шагов, работающих со страницей
const RETRY_TYPES = ["navigate", "click", "hover", "type", "waitFor", "extract", "extractTable", "scroll", "keypress", "customJs", "switchTab"];
// Шаги, у которых есть текстовые поля с ${переменными}
const CHIP_TYPES = ["navigate", "click", "hover", "type", "waitFor", "extract", "setVar", "appendReport", "condition", "switchTab", "loopCount"];

const SEL_KEYS = { sel: "selector", type: "selectorType", frame: "frameUrlIncludes" };
const REFS = new WeakMap(); // цель (шаг или проверка) -> ссылки на поля селектора для «пипетки»

// ---------- общие блоки ----------

function bind(target, key, api, opts = {}) {
  return textInput({ value: target[key], onInput: (v) => { target[key] = v; api.save(); }, ...opts });
}

// Поле в секундах, хранится в миллисекундах
function secInput(target, key, api) {
  const raw = target[key];
  return textInput({
    type: "number",
    min: 0,
    step: 0.5,
    value: raw === undefined || raw === "" ? "" : (Number(raw) || 0) / 1000,
    onInput: (v) => {
      const n = parseFloat(v);
      target[key] = Number.isFinite(n) ? Math.round(n * 1000) : 0;
      api.save();
    },
  });
}

function pickControl(target, api, keys = SEL_KEYS, compact = false) {
  const refs = { keys, input: null, type: null, frame: null };
  refs.type = selectInput(
    [["css", "Селектор"], ["text", "Текст"], ["xpath", "XPath"]],
    target[keys.type] || "css",
    (v) => { target[keys.type] = v; api.save(); },
    { tip: "Как искать элемент: по CSS-селектору, по видимому тексту или по XPath" }
  );
  refs.input = textInput({ value: target[keys.sel], mono: true, placeholder: "например  #search  или  Искать", onInput: (v) => { target[keys.sel] = v; api.save(); } });
  REFS.set(target, refs);
  return h(
    "div",
    { class: "pick" + (compact ? " compact" : ""), "data-role": "pick" },
    refs.type,
    refs.input,
    button("Выбрать на странице", { icon: "🎯", tip: "Нажмите и кликните нужный элемент на рабочей вкладке", onClick: () => api.pick(target, refs) })
  );
}

const pickRow = (target, api, label = "Элемент на странице", keys) => field(label, pickControl(target, api, keys), { wide: true });

function scopeBlock(target, api) {
  const on = !!(target.scopeSelector || target.scopeText);
  const box = h("div", { class: "stack", style: { gap: "8px" } });
  box.append(
    field(
      "Где искать",
      segmented([["page", "На всей странице"], ["row", "Внутри строки или блока"]], on ? "row" : "page", (v) => {
        if (v === "page") {
          target.scopeSelector = "";
          target.scopeText = "";
        } else {
          target.scopeSelector = target.scopeSelector || "tr";
        }
        api.save();
        api.rerender();
      }),
      { wide: true }
    )
  );
  if (on) {
    box.append(
      h(
        "div",
        { class: "scope-box" },
        field("Блок (CSS строки)", bind(target, "scopeSelector", api, { mono: true, placeholder: "tr" }), { tip: "CSS-селектор строки или карточки, например tr или .result-row" }),
        field("Содержит текст", bind(target, "scopeText", api, { mono: true, placeholder: "${fio}" }), { tip: "Элемент ищется только внутри блока, в тексте которого есть это значение" })
      )
    );
  }
  return box;
}

function frameField(target, api, keys = SEL_KEYS) {
  const input = textInput({ value: target[keys.frame], placeholder: "часть адреса iframe, например checkout", onInput: (v) => { target[keys.frame] = v; api.save(); } });
  const refs = REFS.get(target);
  if (refs) refs.frame = input;
  return field("Искать во фрейме (iframe)", input, { tip: "Пусто — основная страница" });
}

function retryBlock(step, api) {
  return h(
    "div",
    { class: "grid2" },
    field("Повторить при ошибке, раз", textInput({ type: "number", min: 0, value: step.retries ?? 0, onInput: (v) => { step.retries = v; api.save(); } })),
    field("Пауза между попытками, сек", secInput(step, "retryDelayMs", api)),
    field(
      "Если не получилось",
      segmented([["stop", "Остановить макрос"], ["skip", "Пропустить шаг"]], step.onError || "stop", (v) => {
        step.onError = v;
        api.save();
        api.rerender();
      }),
      { wide: true }
    )
  );
}

function advanced(step, api, ...extra) {
  const items = extra.filter(Boolean);
  if (RETRY_TYPES.includes(step.type)) items.push(retryBlock(step, api));
  return items.length ? disclosure("Дополнительно", items) : null;
}

function selectorAdvanced(step, api, { index = true, timeout = true } = {}) {
  return [
    index || timeout
      ? h(
          "div",
          { class: "grid2" },
          index ? field("Какое по счёту совпадение", bind(step, "index", api, { type: "number", min: 0 }), { tip: "0 — первое найденное" }) : null,
          timeout ? field("Ждать элемент не дольше, сек", secInput(step, "timeoutMs", api)) : null
        )
      : null,
    frameField(step, api),
  ];
}

export function varChips(api) {
  const box = h("div", { class: "chips", "data-role": "chips" }, h("span", { class: "lbl" }, "Вставить:"));
  // сначала переменные макроса, потом встроенные (_row, _now…) приглушённо
  const names = api.vars().all;
  for (const name of [...names.filter((n) => !n.startsWith("_")), ...names.filter((n) => n.startsWith("_"))]) {
    const c = h("button", { type: "button", class: "chip" + (name.startsWith("_") ? " builtin" : ""), title: "Вставить в выбранное поле" }, "${" + name + "}");
    c.addEventListener("mousedown", (e) => e.preventDefault()); // не отнимать фокус у поля
    c.addEventListener("click", () => api.insertVar(name));
    box.append(c);
  }
  return box;
}

// ---------- условия ----------

const KIND_LABELS = { element: "Элемент на странице", elementText: "Текст элемента", var: "Два значения" };

function normBlock(t, api) {
  const on = (key, dflt = true) => (t[key] === undefined ? dflt : !!t[key]);
  return h(
    "div",
    { class: "row wrap" },
    checkbox("не различать регистр", on("ignoreCase"), (v) => { t.ignoreCase = v; api.save(); }),
    checkbox("е = ё", on("yo"), (v) => { t.yo = v; api.save(); }),
    checkbox("схлопывать пробелы", on("collapseSpaces"), (v) => { t.collapseSpaces = v; api.save(); }),
    checkbox("игнорировать знаки препинания", on("stripPunct", false), (v) => { t.stripPunct = v; api.save(); })
  );
}

function opSelect(t, api) {
  return selectInput(Object.entries(OP_LABELS), t.op, (v) => { t.op = v; api.save(); api.rerender(); }, { tip: OP_TIPS[t.op] });
}

function testRow(step, t, i, api) {
  const row = h("div", { class: "test-row", "data-role": "test" });
  const kindSel = selectInput(Object.entries(KIND_LABELS), t.kind, (v) => {
    step.tests[i] = defaultTest(v);
    api.save();
    api.rerender();
  });
  const remove = iconButton("✕", "Удалить проверку", () => {
    step.tests.splice(i, 1);
    api.save();
    api.rerender();
  }, { danger: true });

  if (t.kind === "var") {
    row.append(
      h(
        "div",
        { class: "test-line" },
        kindSel,
        checkbox("НЕ", t.negate, (v) => { t.negate = v; api.save(); }, { tip: "Инвертировать проверку" }),
        h("div", { class: "grow" }, bind(t, "left", api, { mono: true, placeholder: "${found}" })),
        opSelect(t, api),
        UNARY_OPS.includes(t.op) ? null : h("div", { class: "grow" }, bind(t, "right", api, { mono: true, placeholder: "${fio}" })),
        remove
      ),
      disclosure("Дополнительно", [normBlock(t, api), field("Ждать выполнения, сек", secInput(t, "waitMs", api), { tip: "0 — проверить один раз" })])
    );
    return row;
  }

  if (t.kind === "element") {
    row.append(
      h(
        "div",
        { class: "test-line" },
        kindSel,
        h("div", { class: "grow" }, pickControl(t, api, SEL_KEYS, true)),
        selectInput([["no", "есть"], ["yes", "нет"]], t.negate ? "yes" : "no", (v) => { t.negate = v === "yes"; api.save(); }),
        remove
      )
    );
  } else {
    row.append(
      h("div", { class: "test-line" }, kindSel, h("div", { class: "grow" }, pickControl(t, api, SEL_KEYS, true)), remove),
      h(
        "div",
        { class: "test-line" },
        checkbox("НЕ", t.negate, (v) => { t.negate = v; api.save(); }, { tip: "Инвертировать проверку" }),
        opSelect(t, api),
        UNARY_OPS.includes(t.op) ? null : h("div", { class: "grow" }, bind(t, "value", api, { mono: true, placeholder: "${fio}" }))
      )
    );
  }

  const extra = [scopeBlock(t, api)];
  if (t.kind === "elementText") {
    extra.push(
      h(
        "div",
        { class: "grid2" },
        field("Что читать у элемента", selectInput([["text", "Текст"], ["value", "Значение поля"], ["href", "Ссылка (href)"]], t.attr || "text", (v) => { t.attr = v; api.save(); })),
        field("Какие из найденных проверять", selectInput([["any", "Хотя бы один"], ["first", "Первый"], ["all", "Все"]], t.which || "any", (v) => { t.which = v; api.save(); }))
      ),
      normBlock(t, api)
    );
  }
  extra.push(
    h(
      "div",
      { class: "grid2" },
      field("Ждать выполнения, сек", secInput(t, "waitMs", api), { tip: "0 — проверить один раз" }),
      frameField(t, api)
    ),
    checkbox("Учитывать только видимые элементы", t.visibleOnly !== false, (v) => { t.visibleOnly = v; api.save(); })
  );
  row.append(disclosure("Дополнительно", extra));
  return row;
}

function conditionBody(step, api) {
  migrateCondition(step);
  const body = [];
  body.push(
    h(
      "div",
      { class: "cond-head" },
      h("span", { class: "field-label" }, "Тогда, если"),
      selectInput([["all", "верны все условия"], ["any", "верно хотя бы одно"]], step.logic, (v) => { step.logic = v; api.save(); api.rerender(); })
    )
  );
  const tests = h("div", { class: "tests" });
  step.tests.forEach((t, i) => {
    if (i > 0) tests.append(h("div", { class: "test-and" }, step.logic === "any" ? "ИЛИ" : "И"));
    tests.append(testRow(step, t, i, api));
  });
  body.push(tests);
  const addBtn = button("Добавить условие", { kind: "ghost", icon: "＋", onClick: () => {
    const pop = popover(addBtn, menuList(Object.entries(KIND_LABELS).map(([k, l]) => ({ label: l, onClick: () => { step.tests.push(defaultTest(k)); api.save(); api.rerender(); } })), () => pop.close()));
  } });
  body.push(addBtn);
  return body;
}

// ---------- прочие шаги ----------

function loopListBody(step, api) {
  const body = [
    field("Повторять для каждой записи из", textInput({ value: step.sourceKey, mono: true, list: "dl-lists", placeholder: "rows", onInput: (v) => { step.sourceKey = v.trim(); api.save(); } }), { wide: true, tip: "Таблица или список: из шага «Данные из Excel/CSV», параметра запуска и т. д." }),
    field(
      "Если в записи ошибка",
      segmented([["stop", "Остановить макрос"], ["continue", "Пропустить запись и продолжить"]], step.onRowError || "stop", (v) => {
        step.onRowError = v;
        api.save();
        api.rerender();
      }),
      { wide: true }
    ),
  ];
  const resetBtn = step.resume ? button("Сбросить прогресс", { kind: "ghost", onClick: async () => { await api.resetProgress(step); api.toast("Прогресс сброшен", "ok"); } }) : null;
  body.push(
    advanced(
      step,
      api,
      h(
        "div",
        { class: "grid2" },
        field("Обработать не больше записей", bind(step, "limit", api, { type: "number", min: 0 }), { tip: "0 — все. Удобно для пробного прогона" }),
        field("Имя переменной записи", bind(step, "itemVar", api, { mono: true, placeholder: "item" }))
      ),
      h("div", { class: "row wrap" }, checkbox("Продолжать с места остановки при следующем запуске", step.resume, (v) => { step.resume = v; api.save(); api.rerender(); }, { tip: "Если запуск прервали, следующий начнётся с необработанной записи" }), resetBtn)
    )
  );
  return body;
}

function extractTableBody(step, api) {
  step.columns = step.columns && step.columns.length ? step.columns : [{ key: "col1", selector: "", attr: "text" }];
  const cols = h("div", { class: "stack", style: { gap: "6px" } });
  step.columns.forEach((col, i) => {
    cols.append(
      h(
        "div",
        { class: "row" },
        h("div", { class: "grow" }, textInput({ value: col.key, placeholder: "имя колонки", mono: true, onInput: (v) => { col.key = v.trim(); api.save(); } })),
        h("div", { class: "grow" }, textInput({ value: col.selector, placeholder: "селектор внутри строки (пусто — вся строка)", mono: true, onInput: (v) => { col.selector = v; api.save(); } })),
        selectInput([["text", "Текст"], ["value", "Значение"], ["html", "HTML"], ["href", "href"], ["src", "src"]], col.attr || "text", (v) => { col.attr = v; api.save(); }),
        iconButton("✕", "Удалить колонку", () => { step.columns.splice(i, 1); api.save(); api.rerender(); }, { danger: true })
      )
    );
  });
  cols.append(button("Добавить колонку", { kind: "ghost", icon: "＋", onClick: () => { step.columns.push({ key: "col" + (step.columns.length + 1), selector: "", attr: "text" }); api.save(); api.rerender(); } }));
  return [
    pickRow(step, api, "Строки таблицы на странице", { sel: "rowSelector", type: "rowSelectorType", frame: "frameUrlIncludes" }),
    field("Колонки", cols, { wide: true }),
    field("Сохранить в переменную", bind(step, "varName", api, { mono: true, placeholder: "rows" })),
    advanced(step, api, frameField(step, api)),
  ];
}

const KEYS = [["Enter", "Enter"], ["Tab", "Tab"], ["Escape", "Esc"], ["ArrowDown", "↓"], ["ArrowUp", "↑"], [" ", "Пробел"]];

// Возвращает массив узлов для тела карточки шага
export function stepBody(step, api) {
  let parts = [];
  switch (step.type) {
    case "navigate":
      parts = [field("Адрес страницы", bind(step, "url", api, { placeholder: "https://…", mono: true }), { wide: true }), advanced(step, api)];
      break;
    case "click":
    case "hover":
      parts = [pickRow(step, api), scopeBlock(step, api), advanced(step, api, ...selectorAdvanced(step, api))];
      break;
    case "type":
      parts = [
        pickRow(step, api),
        scopeBlock(step, api),
        field("Что ввести", bind(step, "value", api, { mono: true, placeholder: "${fio}" }), { wide: true }),
        h("div", { class: "row wrap" }, checkbox("Очистить поле перед вводом", step.clear, (v) => { step.clear = v; api.save(); }), checkbox("Нажать Enter после ввода", step.pressEnter, (v) => { step.pressEnter = v; api.save(); })),
        advanced(step, api, ...selectorAdvanced(step, api)),
      ];
      break;
    case "wait":
      parts = [field("Пауза, сек", secInput(step, "ms", api))];
      break;
    case "waitFor":
      parts = [pickRow(step, api), scopeBlock(step, api), advanced(step, api, ...selectorAdvanced(step, api, { index: false }))];
      break;
    case "extract":
      parts = [
        pickRow(step, api),
        scopeBlock(step, api),
        h(
          "div",
          { class: "grid2" },
          field("Что считать", selectInput([["text", "Текст"], ["value", "Значение поля"], ["html", "HTML"], ["href", "Ссылка (href)"], ["src", "Адрес картинки (src)"]], step.attr || "text", (v) => { step.attr = v; api.save(); })),
          field("Сохранить в переменную", bind(step, "varName", api, { mono: true, placeholder: "result" }))
        ),
        checkbox("Собрать все совпадения списком", step.multiple, (v) => { step.multiple = v; api.save(); }),
        advanced(step, api, ...selectorAdvanced(step, api)),
      ];
      break;
    case "extractTable":
      parts = extractTableBody(step, api);
      break;
    case "exportCsv":
      parts = [
        h(
          "div",
          { class: "grid2" },
          field("Таблица (переменная)", textInput({ value: step.sourceVar, mono: true, list: "dl-lists", placeholder: "rows", onInput: (v) => { step.sourceVar = v.trim(); api.save(); } })),
          field("Имя файла", bind(step, "filename", api, { placeholder: "export.csv" }))
        ),
      ];
      break;
    case "loadExcel":
      parts = [dataStepBody(step, api)];
      break;
    case "keypress": {
      const options = KEYS.some(([v]) => v === step.key) ? KEYS : [...KEYS, [step.key, step.key]];
      parts = [field("Клавиша", selectInput(options, step.key || "Enter", (v) => { step.key = v; api.save(); }))];
      break;
    }
    case "scroll":
      parts = [
        segmented([["bottom", "В конец страницы"], ["toElement", "К элементу"]], step.mode, (v) => { step.mode = v; api.save(); api.rerender(); }),
        step.mode === "toElement" ? pickRow(step, api) : null,
        step.mode === "toElement" ? scopeBlock(step, api) : null,
      ];
      break;
    case "setVar":
      parts = [
        h(
          "div",
          { class: "grid2" },
          field("Имя переменной", bind(step, "varName", api, { mono: true, placeholder: "status" })),
          field("Действие", segmented([["set", "Записать"], ["increment", "Прибавить"]], step.mode || "set", (v) => { step.mode = v; api.save(); api.rerender(); }))
        ),
        field(step.mode === "increment" ? "Сколько прибавить (пусто — 1)" : "Значение", bind(step, "value", api, { mono: true, placeholder: step.mode === "increment" ? "1" : "OK" }), { wide: true }),
      ];
      break;
    case "appendReport":
      parts = [
        field("Файл отчёта", bind(step, "filename", api, { placeholder: "report.md" }), { tip: "Сохраняется в папку «Загрузки» в конце запуска; можно с подпапкой: Проверки/отчёт.md" }),
        field("Что дописать (Markdown)", textArea({ value: step.template, rows: 5, mono: true, placeholder: "## Строка ${_row}: ${fio}\n- Статус: ${status}", onInput: (v) => { step.template = v; api.save(); } }), { wide: true }),
        advanced(
          step,
          api,
          field("Заголовок файла (один раз в начале)", textArea({ value: step.header, rows: 2, mono: true, onInput: (v) => { step.header = v; api.save(); } })),
          checkbox("Начинать отчёт заново при каждом запуске", step.resetPerRun !== false, (v) => { step.resetPerRun = v; api.save(); }, { tip: "Иначе дописывается к накопленному" })
        ),
      ];
      break;
    case "switchTab":
      parts = [
        segmented([["popup", "Вкладку открыла страница"], ["href", "Открыть ссылку элемента"]], step.source || "popup", (v) => { step.source = v; api.save(); api.rerender(); }),
        step.source === "href" ? pickRow(step, api, "Элемент со ссылкой") : null,
        step.source === "href" ? scopeBlock(step, api) : null,
        advanced(step, api, field("Ждать вкладку не дольше, сек", secInput(step, "timeoutMs", api), { tip: "Если сайт открывает окно через window.open, разрешите всплывающие окна для сайта или выберите «Открыть ссылку элемента»" })),
      ];
      break;
    case "condition":
      parts = conditionBody(step, api);
      break;
    case "loopList":
      parts = loopListBody(step, api);
      break;
    case "loopCount":
      parts = [
        h("div", { class: "grid2" }, field("Сколько раз", bind(step, "count", api, { mono: true, placeholder: "3" })), field("Имя счётчика", bind(step, "itemVar", api, { mono: true, placeholder: "i" }))),
      ];
      break;
    case "customJs":
      parts = [
        field("Код (доступны vars, helpers.$, helpers.$$, await helpers.sleep(мс); вернуть значение — return)", textArea({ value: step.code, rows: 8, mono: true, onInput: (v) => { step.code = v; api.save(); } }), { wide: true }),
        field("Сохранить результат в переменную", bind(step, "saveTo", api, { mono: true, placeholder: "необязательно" })),
        advanced(step, api, frameField(step, api)),
      ];
      break;
    default:
  }
  if (CHIP_TYPES.includes(step.type)) parts.push(varChips(api));
  return parts.filter(Boolean);
}
