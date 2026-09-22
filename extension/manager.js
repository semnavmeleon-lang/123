const START_URL = 'https://lka.vsk.ru/products/forge/osago';

let fileHandle = null;
let workbook = null;
let sheetName = null;
let sheet = null;

let policyColIdx = null;
let resultColIdx = null;

let workingTabId = null;
let queue = [];
let queueIndex = 0;
let running = false;
let currentRow = null;
let pendingTeach = null;

const els = {
  openFileBtn: document.getElementById('openFileBtn'),
  fileName: document.getElementById('fileName'),
  sheetRow: document.getElementById('sheetRow'),
  sheetSelect: document.getElementById('sheetSelect'),
  policyColSelect: document.getElementById('policyColSelect'),
  resultColSelect: document.getElementById('resultColSelect'),
  setupBtn: document.getElementById('setupBtn'),
  resetFormSelectorsBtn: document.getElementById('resetFormSelectorsBtn'),
  resetResultSelectorsBtn: document.getElementById('resetResultSelectorsBtn'),
  dotCheckbox: document.getElementById('dotCheckbox'),
  dotInput: document.getElementById('dotInput'),
  dotContinue: document.getElementById('dotContinue'),
  dotPrice: document.getElementById('dotPrice'),
  dotImpossible: document.getElementById('dotImpossible'),
  teachPrompt: document.getElementById('teachPrompt'),
  teachPriceBtn: document.getElementById('teachPriceBtn'),
  teachImpossibleBtn: document.getElementById('teachImpossibleBtn'),
  teachCaptured: document.getElementById('teachCaptured'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  progress: document.getElementById('progress'),
  log: document.getElementById('log'),
};

init();

async function init() {
  await refreshSelectorDots();
  wireUi();
}

function wireUi() {
  els.openFileBtn.addEventListener('click', () => openFile().catch((e) => log(`Не удалось открыть файл: ${e.message || e}`, 'error')));
  els.sheetSelect.addEventListener('change', onSheetChange);
  els.policyColSelect.addEventListener('change', () => { policyColIdx = Number(els.policyColSelect.value); saveColumnPrefs(); });
  els.resultColSelect.addEventListener('change', () => { resultColIdx = Number(els.resultColSelect.value); saveColumnPrefs(); });
  els.setupBtn.addEventListener('click', () => setupFormElements().catch((e) => log(String(e.message || e), 'error')));
  els.resetFormSelectorsBtn.addEventListener('click', resetFormSelectors);
  els.resetResultSelectorsBtn.addEventListener('click', resetResultSelectors);
  els.startBtn.addEventListener('click', () => startRun().catch((e) => log(String(e.message || e), 'error')));
  els.stopBtn.addEventListener('click', stopRun);
  els.teachPriceBtn.addEventListener('click', () => confirmTeachRole('price').catch((e) => log(String(e.message || e), 'error')));
  els.teachImpossibleBtn.addEventListener('click', () => confirmTeachRole('impossible').catch((e) => log(String(e.message || e), 'error')));
}

// ---------- файл ----------

async function openFile() {
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'Excel',
        accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] },
      }],
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // пользователь закрыл диалог
    throw err;
  }

  fileHandle = handle;
  const file = await fileHandle.getFile();
  els.fileName.textContent = file.name;
  const buf = await file.arrayBuffer();
  workbook = XLSX.read(buf, { type: 'array' });

  els.sheetSelect.innerHTML = '';
  workbook.SheetNames.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    els.sheetSelect.appendChild(opt);
  });
  els.sheetRow.style.display = workbook.SheetNames.length > 1 ? 'flex' : 'none';
  sheetName = workbook.SheetNames[0];
  els.sheetSelect.value = sheetName;
  await onSheetChange();
  log(`Открыт файл: ${file.name}`, 'ok');
}

async function onSheetChange() {
  sheetName = els.sheetSelect.value;
  sheet = workbook.Sheets[sheetName];
  await populateColumnSelects();
}

async function populateColumnSelects() {
  const headers = readHeaders(sheet);
  fillSelect(els.policyColSelect, headers);
  fillSelect(els.resultColSelect, headers);
  els.policyColSelect.disabled = false;
  els.resultColSelect.disabled = false;

  const prefs = await getColumnPrefs();
  const byTitle = (title) => headers.find((h) => h.title === title);
  const policyMatch = prefs.policyHeader && byTitle(prefs.policyHeader);
  const resultMatch = prefs.resultHeader && byTitle(prefs.resultHeader);
  if (policyMatch) els.policyColSelect.value = String(policyMatch.colIndex);
  if (resultMatch) els.resultColSelect.value = String(resultMatch.colIndex);
  policyColIdx = Number(els.policyColSelect.value);
  resultColIdx = Number(els.resultColSelect.value);
}

function fillSelect(select, headers) {
  select.innerHTML = '';
  headers.forEach((h) => {
    const opt = document.createElement('option');
    opt.value = String(h.colIndex);
    opt.textContent = `${h.colLetter} — ${h.title}`;
    select.appendChild(opt);
  });
}

function readHeaders(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headers = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const ref = XLSX.utils.encode_cell({ r: range.s.r, c });
    const cell = sheet[ref];
    headers.push({
      colIndex: c,
      colLetter: XLSX.utils.encode_col(c),
      title: cell ? String(cell.v) : `(колонка ${XLSX.utils.encode_col(c)})`,
    });
  }
  return headers;
}

function extractRows() {
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rows = [];
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const ref = XLSX.utils.encode_cell({ r, c: policyColIdx });
    const cell = sheet[ref];
    const value = cell ? String(cell.v).trim() : '';
    if (!value) continue;
    rows.push({ id: `row-${r}`, rowIndex: r, policyNumber: value });
  }
  return rows;
}

function writeResult(rowIndex, text) {
  const ref = XLSX.utils.encode_cell({ r: rowIndex, c: resultColIdx });
  sheet[ref] = { t: 's', v: text };
  const range = XLSX.utils.decode_range(sheet['!ref']);
  range.e.r = Math.max(range.e.r, rowIndex);
  range.e.c = Math.max(range.e.c, resultColIdx);
  sheet['!ref'] = XLSX.utils.encode_range(range);
}

async function persist() {
  if (!fileHandle) return;
  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const writable = await fileHandle.createWritable();
  await writable.write(out);
  await writable.close();
}

// ---------- настройки колонок / селекторов (chrome.storage.local) ----------

async function getColumnPrefs() {
  const { columnPrefs } = await chrome.storage.local.get('columnPrefs');
  return columnPrefs || {};
}
async function saveColumnPrefs() {
  const headers = readHeaders(sheet);
  const policyHeader = headers.find((h) => h.colIndex === policyColIdx)?.title;
  const resultHeader = headers.find((h) => h.colIndex === resultColIdx)?.title;
  await chrome.storage.local.set({ columnPrefs: { policyHeader, resultHeader } });
}

async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return config || { selectors: {} };
}
async function setConfig(config) {
  await chrome.storage.local.set({ config });
}

async function refreshSelectorDots() {
  const config = await getConfig();
  const sel = config.selectors || {};
  setDot(els.dotCheckbox, !!sel.checkbox);
  setDot(els.dotInput, !!sel.input);
  setDot(els.dotContinue, !!sel.continueBtn);
  setDot(els.dotPrice, !!sel.priceResult);
  setDot(els.dotImpossible, !!sel.impossibleResult);
}
function setDot(el, ok) {
  el.classList.toggle('ok', !!ok);
}

async function resetFormSelectors() {
  const config = await getConfig();
  delete config.selectors.checkbox;
  delete config.selectors.input;
  delete config.selectors.continueBtn;
  await setConfig(config);
  await refreshSelectorDots();
  log('Сброшены селекторы формы', 'warn');
}
async function resetResultSelectors() {
  const config = await getConfig();
  delete config.selectors.priceResult;
  delete config.selectors.impossibleResult;
  await setConfig(config);
  await refreshSelectorDots();
  log('Сброшены селекторы результата', 'warn');
}

// ---------- рабочая вкладка ----------

async function ensureWorkingTab() {
  if (workingTabId) {
    try {
      await chrome.tabs.get(workingTabId);
      return;
    } catch {
      workingTabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url: START_URL });
  workingTabId = tab.id;
  chrome.tabs.onRemoved.addListener(function handler(tabId) {
    if (tabId === workingTabId) {
      workingTabId = null;
      if (running) {
        running = false;
        log('Рабочая вкладка закрыта — цикл остановлен', 'error');
        updateRunButtons();
      }
      chrome.tabs.onRemoved.removeListener(handler);
    }
  });
}

async function navigateWorkingTab(url) {
  const tab = await chrome.tabs.get(workingTabId);
  if (tab.url === url) {
    await chrome.tabs.reload(workingTabId);
  } else {
    await chrome.tabs.update(workingTabId, { url });
  }
}

function waitForContentReady(timeout = 15000) {
  return new Promise((resolve, reject) => {
    const listener = (msg, sender) => {
      if (msg.type === 'CONTENT_READY' && sender.tab && sender.tab.id === workingTabId) {
        chrome.runtime.onMessage.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('Страница не отозвалась (не загрузился content script)'));
    }, timeout);
  });
}

// ---------- настройка элементов формы (мастер из 3 шагов) ----------

async function setupFormElements() {
  els.setupBtn.disabled = true;
  try {
    await ensureWorkingTab();
    await navigateWorkingTab(START_URL);
    await waitForContentReady();
    await pickOne('checkbox', 'Кликните по галочке «Предыдущий полис ВСК» в рабочей вкладке');
    await pickOne('input', 'Кликните по полю ввода номера полиса');
    await pickOne('continueBtn', 'Кликните по кнопке «Продолжить» (клик будет перехвачен и форму не отправит)');
    log('Элементы формы настроены', 'ok');
  } finally {
    els.setupBtn.disabled = false;
  }
}

function pickOne(role, instruction) {
  log(instruction, 'info');
  return new Promise((resolve, reject) => {
    const listener = (msg) => {
      if (msg.type === 'ELEMENT_PICKED' && msg.role === role) {
        chrome.runtime.onMessage.removeListener(listener);
        saveSelector(role, msg.selector, msg.meta).then(resolve, reject);
      } else if (msg.type === 'PICK_CANCELLED') {
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error('Выбор отменён'));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.tabs.sendMessage(workingTabId, { type: 'START_PICK', role });
  });
}

async function saveSelector(role, selector, meta) {
  const config = await getConfig();
  config.selectors[role] = { selector, meta };
  await setConfig(config);
  await refreshSelectorDots();
  log(`Сохранено (${role}): ${meta}`, 'ok');
}

// ---------- запуск/цикл проверки ----------

async function startRun() {
  if (!sheet) return log('Сначала откройте файл', 'error');
  if (policyColIdx == null || resultColIdx == null) return log('Выберите колонки', 'error');

  queue = extractRows();
  if (queue.length === 0) return log('В выбранной колонке нет номеров полисов', 'error');

  queueIndex = 0;
  running = true;
  updateRunButtons();
  await ensureWorkingTab();
  updateProgress();
  await processNext();
}

function stopRun() {
  running = false;
  chrome.storage.local.set({ run: { active: false, phase: 'idle' } });
  updateRunButtons();
  log('Остановлено пользователем', 'warn');
}

function updateRunButtons() {
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
}

function updateProgress() {
  els.progress.textContent = queue.length ? `${queueIndex} / ${queue.length}` : '';
}

async function processNext() {
  if (!running) return;
  if (queueIndex >= queue.length) {
    running = false;
    updateRunButtons();
    log(`Готово: обработано ${queue.length} строк`, 'ok');
    return;
  }
  currentRow = queue[queueIndex];
  log(`Строка ${currentRow.rowIndex + 1}: проверяю полис «${currentRow.policyNumber}»…`);

  await chrome.storage.local.set({
    run: {
      active: true,
      phase: 'awaiting-form',
      rowId: currentRow.id,
      policyNumber: currentRow.policyNumber,
      startedAt: Date.now(),
    },
  });
  await navigateWorkingTab(START_URL);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab || sender.tab.id !== workingTabId) return;
  if (!currentRow) return;
  if (msg.rowId && msg.rowId !== currentRow.id) return;

  if (msg.type === 'RESULT') {
    handleRowDone(msg.text, msg.role === 'price' ? 'ok' : 'warn');
  } else if (msg.type === 'ERROR') {
    handleRowDone(`Ошибка: ${msg.message}`, 'error');
  } else if (msg.type === 'NEED_TEACH') {
    running = false;
    updateRunButtons();
    log(`Строка ${currentRow.rowIndex + 1}: появился новый вариант результата — кликните по нему в рабочей вкладке`, 'warn');
    showTeachPrompt();
  } else if (msg.type === 'TEACH_PICKED') {
    pendingTeach = msg;
    els.teachPriceBtn.disabled = false;
    els.teachImpossibleBtn.disabled = false;
    els.teachCaptured.textContent = `Выбрано: ${msg.meta} → «${msg.text}»`;
  }
});

function handleRowDone(text, level) {
  writeResult(currentRow.rowIndex, text);
  persist().catch((e) => log(`Не удалось сохранить файл: ${e.message || e}`, 'error'));
  log(`Строка ${currentRow.rowIndex + 1}: ${text}`, level);
  queueIndex++;
  updateProgress();
  processNext();
}

function showTeachPrompt() {
  els.teachPrompt.style.display = 'block';
  els.teachPriceBtn.disabled = true;
  els.teachImpossibleBtn.disabled = true;
  els.teachCaptured.textContent = '';
}

async function confirmTeachRole(role) {
  if (!pendingTeach) return;
  const config = await getConfig();
  config.selectors[role === 'price' ? 'priceResult' : 'impossibleResult'] = {
    selector: pendingTeach.selector,
    meta: pendingTeach.meta,
  };
  await setConfig(config);
  await refreshSelectorDots();

  const teach = pendingTeach;
  pendingTeach = null;
  els.teachPrompt.style.display = 'none';

  running = true;
  updateRunButtons();
  handleRowDone(teach.text, role === 'price' ? 'ok' : 'warn');
}

// ---------- журнал ----------

function log(text, level) {
  const line = document.createElement('div');
  if (level) line.className = level;
  const ts = new Date().toLocaleTimeString('ru-RU');
  line.textContent = `[${ts}] ${text}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}
