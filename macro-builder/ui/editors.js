// Редакторы шагов для панели свойств. Поля собраны в разделы; редкие настройки (номер совпадения,
// таймауты, iframe, повторы) спрятаны в «Дополнительно». Значения, которые вводит макрос
// (текст в поле, сравнение и т. д.), выбираются из списка: столбцы загруженной таблицы, переменные
// или свой текст. Пояснения - только во всплывающих подсказках.

import { h, field, textInput, textArea, selectInput, checkbox, segmented, disclosure, button, iconButton, popover, menuList, insertAtCaret } from "./dom.js";
import { defaultTest } from "../common.js";
import { OP_LABELS, OP_TIPS, UNARY_OPS, migrateCondition } from "../logic.js";
import { dataStepBody } from "./data-step.js";

const NO_BODY = ["closeTab", "loopContinue", "loopBreak", "stopMacro"];
export const hasBody = (step) => !NO_BODY.includes(step.type);

// Повтор при ошибке имеет смысл только для шагов, работающих со страницей
const RETRY_TYPES = ["navigate", "click", "hover", "type", "waitFor", "extract", "extractTable", "scroll", "keypress", "customJs", "switchTab"];

const SEL_KEYS = { sel: "selector", type: "selectorType", frame: "frameUrlIncludes" };
const REFS = new WeakMap(); // цель (шаг или проверка) -> ссылки на поля селектора для «Указать»/«Показать»

// Вложенные списки шагов контейнеров: в дереве видны всегда
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

const section = (title, ...children) => h("div", { class: "section" }, title ? h("div", { class: "section-title" }, title) : null, children);
const checks = (label, ...items) => field(label, h("div", { class: "row wrap" }, items));

// Список «Вставить значение...»: подставляет ${имя} в указанное поле в позицию курсора
function insertSelect(getInput, api) {
  const sel = h("select", { title: "Вставить значение из таблицы или переменную в текст", "data-role": "insert-value" });
  sel.append(h("option", { value: "" }, "Вставить значение..."));
  for (const g of api.valueSources()) {
    const og = h("optgroup", { label: g.label });
    for (const it of g.items) og.append(h("option", { value: it.value }, it.label));
    sel.append(og);
  }
  sel.style.width = "auto";
  sel.addEventListener("change", () => {
    if (sel.value) insertAtCaret(getInput(), sel.value);
    sel.value = "";
  });
  return sel;
}

// Значение, которое вводит или сравнивает макрос: столбец таблицы / переменная из списка либо свой текст
// (в своём тексте тоже можно вставлять значения из списка)
function valueField(target, key, api, { placeholder = "" } = {}) {
  const groups = api.valueSources();
  const cur = String(target[key] ?? "");
  const known = new Set(groups.flatMap((g) => g.items.map((i) => i.value)));
  const isRef = known.has(cur);
  const wrap = h("div", { class: "value-field", "data-role": "value-field" });
  const sel = h("select", { title: "Откуда взять значение", "data-role": "value-source" });
  sel.append(h("option", { value: "" }, "Свой текст"));
  for (const g of groups) {
    const og = h("optgroup", { label: g.label });
    for (const it of g.items) og.append(h("option", { value: it.value }, it.label));
    sel.append(og);
  }
  sel.value = isRef ? cur : "";
  sel.addEventListener("change", () => {
    target[key] = sel.value || "";
    api.save();
    api.rerender();
  });
  wrap.append(sel);
  if (!isRef) {
    const input = textInput({ value: cur, mono: true, placeholder, onInput: (v) => { target[key] = v; api.save(); } });
    wrap.append(h("div", { class: "row" }, h("div", { style: "flex:1;min-width:0" }, input), insertSelect(() => input, api)));
  }
  return wrap;
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
    { class: "pick", "data-role": "pick" },
    h("div", { class: "pick-main" }, refs.type, refs.input),
    h(
      "div",
      { class: "pick-buttons" },
      button(compact ? "Указать" : "Указать на странице", { tip: "Нажмите и кликните нужный элемент на рабочей вкладке", onClick: () => api.pick(target, refs) }),
      button("Показать", { tip: "Подсветить найденные элементы на рабочей вкладке красным с названием", onClick: () => api.highlight(target, refs) })
    )
  );
}

const pickRow = (target, api, label = "Элемент", keys) => field(label, pickControl(target, api, keys), { wide: true });

function scopeBlock(target, api) {
  const on = !!(target.scopeSelector || target.scopeText);
  const box = h("div", { class: "stack", style: "gap:0" });
  box.append(
    segmented([["page", "На всей странице"], ["row", "Внутри строки или блока"]], on ? "row" : "page", (v) => {
      if (v === "page") {
        target.scopeSelector = "";
        target.scopeText = "";
      } else {
        target.scopeSelector = target.scopeSelector || "tr";
      }
      api.save();
      api.rerender();
    })
  );
  if (on) {
    box.append(
      h(
        "div",
        { class: "scope-box" },
        field("Блок (CSS)", bind(target, "scopeSelector", api, { mono: true, placeholder: "tr" }), { tip: "CSS-селектор строки или карточки, например tr или .result-row" }),
        field("С текстом", valueField(target, "scopeText", api, { placeholder: "текст внутри блока" }), { tip: "Элемент ищется только внутри блока, в тексте которого есть это значение" })
      )
    );
  }
  return field("Где искать", box, { wide: true });
}

function frameField(target, api, keys = SEL_KEYS) {
  const input = textInput({ value: target[keys.frame], placeholder: "часть адреса iframe, например checkout", onInput: (v) => { target[keys.frame] = v; api.save(); } });
  const refs = REFS.get(target);
  if (refs) refs.frame = input;
  return field("Во фрейме (iframe)", input, { tip: "Пусто — основная страница" });
}

function retryBlock(step, api) {
  return h(
    "div",
    { class: "stack" },
    field("Повторов при ошибке", textInput({ type: "number", min: 0, value: step.retries ?? 0, onInput: (v) => { step.retries = v; api.save(); } })),
    field("Пауза между попытками, сек", secInput(step, "retryDelayMs", api)),
    field(
      "Если не получилось",
      segmented([["stop", "Остановить макрос"], ["skip", "Пропустить шаг"]], step.onError || "stop", (v) => {
        step.onError = v;
        api.save();
        api.rerender();
      })
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
    index ? field("Какое по счёту совпадение", bind(step, "index", api, { type: "number", min: 0 }), { tip: "0 — первое найденное" }) : null,
    timeout ? field("Ждать элемент не дольше, сек", secInput(step, "timeoutMs", api)) : null,
    frameField(step, api),
  ];
}

// ---------- условия ----------

const KIND_LABELS = { element: "Элемент на странице", elementText: "Текст элемента", var: "Два значения" };

function normBlock(t, api) {
  const on = (key, dflt = true) => (t[key] === undefined ? dflt : !!t[key]);
  return field(
    "Сравнение",
    h(
      "div",
      { class: "row wrap" },
      checkbox("не различать регистр", on("ignoreCase"), (v) => { t.ignoreCase = v; api.save(); }),
      checkbox("е = ё", on("yo"), (v) => { t.yo = v; api.save(); }),
      checkbox("схлопывать пробелы", on("collapseSpaces"), (v) => { t.collapseSpaces = v; api.save(); }),
      checkbox("игнорировать знаки препинания", on("stripPunct", false), (v) => { t.stripPunct = v; api.save(); })
    )
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
  const remove = iconButton("×", "Удалить проверку", () => {
    step.tests.splice(i, 1);
    api.save();
    api.rerender();
  });

  if (t.kind === "var") {
    row.append(
      h(
        "div",
        { class: "test-line" },
        kindSel,
        checkbox("НЕ", t.negate, (v) => { t.negate = v; api.save(); }, { tip: "Инвертировать проверку" }),
        h("div", { class: "grow" }, valueField(t, "left", api, { placeholder: "значение" })),
        opSelect(t, api),
        UNARY_OPS.includes(t.op) ? null : h("div", { class: "grow" }, valueField(t, "right", api, { placeholder: "значение" })),
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
        UNARY_OPS.includes(t.op) ? null : h("div", { class: "grow" }, valueField(t, "value", api, { placeholder: "с чем сравнить" }))
      )
    );
  }

  const extra = [scopeBlock(t, api)];
  if (t.kind === "elementText") {
    extra.push(
      field("Что читать у элемента", selectInput([["text", "Текст"], ["value", "Значение поля"], ["href", "Ссылка (href)"]], t.attr || "text", (v) => { t.attr = v; api.save(); })),
      field("Какие из найденных", selectInput([["any", "Хотя бы один"], ["first", "Первый"], ["all", "Все"]], t.which || "any", (v) => { t.which = v; api.save(); })),
      normBlock(t, api)
    );
  }
  extra.push(
    field("Ждать выполнения, сек", secInput(t, "waitMs", api), { tip: "0 — проверить один раз" }),
    frameField(t, api),
    checks("Видимость", checkbox("учитывать только видимые элементы", t.visibleOnly !== false, (v) => { t.visibleOnly = v; api.save(); }))
  );
  row.append(disclosure("Дополнительно", extra));
  return row;
}

function conditionBody(step, api) {
  migrateCondition(step);
  const tests = h("div", { class: "tests" });
  step.tests.forEach((t, i) => {
    if (i > 0) tests.append(h("div", { class: "test-and" }, step.logic === "any" ? "ИЛИ" : "И"));
    tests.append(testRow(step, t, i, api));
  });
  const addBtn = button("Добавить условие", { onClick: () => {
    const pop = popover(addBtn, menuList(Object.entries(KIND_LABELS).map(([k, l]) => ({ label: l, onClick: () => { step.tests.push(defaultTest(k)); api.save(); api.rerender(); } })), () => pop.close()));
  } });
  return [
    section(
      "Условия",
      h("div", { class: "cond-head" }, h("span", {}, "Выполнять ветку «Тогда», если"), selectInput([["all", "верны все условия"], ["any", "верно хотя бы одно"]], step.logic, (v) => { step.logic = v; api.save(); api.rerender(); })),
      tests,
      h("div", {}, addBtn)
    ),
  ];
}

// ---------- прочие шаги ----------

function loopListBody(step, api) {
  return [
    section(
      "Источник",
      field("Повторять для каждой записи из", textInput({ value: step.sourceKey, mono: true, list: "dl-lists", placeholder: "rows", onInput: (v) => { step.sourceKey = v.trim(); api.save(); } }), { tip: "Таблица или список: из шага «Данные из Excel/CSV», параметра запуска и т. д." })
    ),
    section(
      "Ошибки",
      field(
        "Если в записи ошибка",
        segmented([["stop", "Остановить макрос"], ["continue", "Пропустить запись и продолжить"]], step.onRowError || "stop", (v) => {
          step.onRowError = v;
          api.save();
          api.rerender();
        })
      )
    ),
    advanced(
      step,
      api,
      field("Обработать не больше записей", bind(step, "limit", api, { type: "number", min: 0 }), { tip: "0 — все. Удобно для пробного прогона" }),
      field("Имя переменной записи", bind(step, "itemVar", api, { mono: true, placeholder: "item" })),
      checks(
        "Продолжение",
        checkbox("продолжать с места остановки при следующем запуске", step.resume, (v) => { step.resume = v; api.save(); api.rerender(); }, { tip: "Если запуск прервали, следующий начнётся с необработанной записи" }),
        step.resume ? button("Сбросить прогресс", { onClick: async () => { await api.resetProgress(step); api.toast("Прогресс сброшен", "ok"); } }) : null
      )
    ),
  ];
}

function extractTableBody(step, api) {
  step.columns = step.columns && step.columns.length ? step.columns : [{ key: "col1", selector: "", attr: "text" }];
  const cols = h("div", { class: "stack", style: "gap:6px" });
  step.columns.forEach((col, i) => {
    cols.append(
      h(
        "div",
        { class: "row" },
        h("div", { style: "flex:1;min-width:0" }, textInput({ value: col.key, placeholder: "имя колонки", mono: true, onInput: (v) => { col.key = v.trim(); api.save(); } })),
        h("div", { style: "flex:1;min-width:0" }, textInput({ value: col.selector, placeholder: "селектор внутри строки", mono: true, onInput: (v) => { col.selector = v; api.save(); } })),
        selectInput([["text", "Текст"], ["value", "Значение"], ["html", "HTML"], ["href", "href"], ["src", "src"]], col.attr || "text", (v) => { col.attr = v; api.save(); }),
        iconButton("×", "Удалить колонку", () => { step.columns.splice(i, 1); api.save(); api.rerender(); })
      )
    );
  });
  cols.append(h("div", {}, button("Добавить колонку", { onClick: () => { step.columns.push({ key: "col" + (step.columns.length + 1), selector: "", attr: "text" }); api.save(); api.rerender(); } })));
  return [
    section("Строки на странице", pickRow(step, api, "Строки таблицы", { sel: "rowSelector", type: "rowSelectorType", frame: "frameUrlIncludes" })),
    section("Колонки", cols),
    section("Результат", field("Сохранить в переменную", bind(step, "varName", api, { mono: true, placeholder: "rows" }))),
    advanced(step, api, frameField(step, api)),
  ];
}

const KEYS = [["Enter", "Enter"], ["Tab", "Tab"], ["Escape", "Esc"], ["ArrowDown", "Стрелка вниз"], ["ArrowUp", "Стрелка вверх"], [" ", "Пробел"]];

// Возвращает массив узлов для панели свойств шага
export function stepBody(step, api) {
  let parts = [];
  switch (step.type) {
    case "navigate": {
      const url = bind(step, "url", api, { placeholder: "https://...", mono: true });
      parts = [section("Страница", field("Адрес", h("div", { class: "row" }, h("div", { style: "flex:1;min-width:0" }, url), insertSelect(() => url, api)))), advanced(step, api)];
      break;
    }
    case "click":
    case "hover":
      parts = [section("Элемент на странице", pickRow(step, api), scopeBlock(step, api)), advanced(step, api, ...selectorAdvanced(step, api))];
      break;
    case "type":
      parts = [
        section("Поле на странице", pickRow(step, api), scopeBlock(step, api)),
        section(
          "Что ввести",
          field("Значение", valueField(step, "value", api, { placeholder: "введите текст" })),
          checks(
            "После ввода",
            checkbox("очистить поле перед вводом", step.clear, (v) => { step.clear = v; api.save(); }),
            checkbox("нажать Enter", step.pressEnter, (v) => { step.pressEnter = v; api.save(); })
          )
        ),
        advanced(step, api, ...selectorAdvanced(step, api)),
      ];
      break;
    case "wait":
      parts = [section("Пауза", field("Сколько ждать, сек", secInput(step, "ms", api)))];
      break;
    case "waitFor":
      parts = [section("Элемент на странице", pickRow(step, api), scopeBlock(step, api)), advanced(step, api, ...selectorAdvanced(step, api, { index: false }))];
      break;
    case "extract":
      parts = [
        section("Элемент на странице", pickRow(step, api), scopeBlock(step, api)),
        section(
          "Результат",
          field("Что считать", selectInput([["text", "Текст"], ["value", "Значение поля"], ["html", "HTML"], ["href", "Ссылка (href)"], ["src", "Адрес картинки (src)"]], step.attr || "text", (v) => { step.attr = v; api.save(); })),
          field("Сохранить в переменную", bind(step, "varName", api, { mono: true, placeholder: "result" })),
          checks("Несколько", checkbox("собрать все совпадения списком", step.multiple, (v) => { step.multiple = v; api.save(); }))
        ),
        advanced(step, api, ...selectorAdvanced(step, api)),
      ];
      break;
    case "extractTable":
      parts = extractTableBody(step, api);
      break;
    case "exportCsv":
      parts = [
        section(
          "Файл",
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
      parts = [section("Клавиша", field("Нажать", selectInput(options, step.key || "Enter", (v) => { step.key = v; api.save(); })))];
      break;
    }
    case "scroll":
      parts = [
        section(
          "Прокрутка",
          field("Куда", segmented([["bottom", "В конец страницы"], ["toElement", "К элементу"]], step.mode, (v) => { step.mode = v; api.save(); api.rerender(); })),
          step.mode === "toElement" ? pickRow(step, api) : null,
          step.mode === "toElement" ? scopeBlock(step, api) : null
        ),
      ];
      break;
    case "setVar":
      parts = [
        section(
          "Переменная",
          field("Имя", bind(step, "varName", api, { mono: true, placeholder: "status" })),
          field("Действие", segmented([["set", "Записать"], ["increment", "Прибавить"]], step.mode || "set", (v) => { step.mode = v; api.save(); api.rerender(); })),
          field(step.mode === "increment" ? "Сколько прибавить" : "Значение", valueField(step, "value", api, { placeholder: step.mode === "increment" ? "пусто — прибавить 1" : "значение" }))
        ),
      ];
      break;
    case "appendReport": {
      const tpl = textArea({ value: step.template, rows: 6, mono: true, placeholder: "## Строка ${_row}: ${fio}\n- Статус: ${status}", onInput: (v) => { step.template = v; api.save(); } });
      parts = [
        section(
          "Отчёт",
          field("Файл", bind(step, "filename", api, { placeholder: "report.md" }), { tip: "Сохраняется в папку «Загрузки» в конце запуска; можно с подпапкой: Проверки/отчёт.md" }),
          field("Что дописать (Markdown)", h("div", { class: "stack", style: "gap:6px" }, tpl, h("div", {}, insertSelect(() => tpl, api))))
        ),
        advanced(
          step,
          api,
          field("Заголовок файла", textArea({ value: step.header, rows: 2, mono: true, onInput: (v) => { step.header = v; api.save(); } }), { tip: "Пишется один раз в начале отчёта" }),
          checks("Запуск", checkbox("начинать отчёт заново при каждом запуске", step.resetPerRun !== false, (v) => { step.resetPerRun = v; api.save(); }, { tip: "Иначе дописывается к накопленному" }))
        ),
      ];
      break;
    }
    case "switchTab":
      parts = [
        section(
          "Вкладка",
          field("Как получить", segmented([["popup", "Вкладку открыла страница"], ["href", "Открыть ссылку элемента"]], step.source || "popup", (v) => { step.source = v; api.save(); api.rerender(); })),
          step.source === "href" ? pickRow(step, api, "Элемент со ссылкой") : null,
          step.source === "href" ? scopeBlock(step, api) : null
        ),
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
      parts = [section("Повторы", field("Сколько раз", bind(step, "count", api, { mono: true, placeholder: "3" })), field("Имя счётчика", bind(step, "itemVar", api, { mono: true, placeholder: "i" })))];
      break;
    case "customJs":
      parts = [
        section(
          "Код",
          field("Скрипт", textArea({ value: step.code, rows: 9, mono: true, onInput: (v) => { step.code = v; api.save(); } }), { tip: "Доступны vars, helpers.$, helpers.$$, await helpers.sleep(мс); вернуть значение — return" }),
          field("Результат в переменную", bind(step, "saveTo", api, { mono: true, placeholder: "необязательно" }))
        ),
        advanced(step, api, frameField(step, api)),
      ];
      break;
    default:
  }
  return parts.filter(Boolean);
}
