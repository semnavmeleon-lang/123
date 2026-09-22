const START_URL = 'https://lka.vsk.ru/products/forge/osago';

const SELECTOR_ROLES = [
  {
    key: 'checkbox',
    label: 'Чекбокс «Предыдущий полис ВСК»',
    instruction: 'Кликните по галочке «Предыдущий полис ВСК» в рабочей вкладке',
    skippable: true,
  },
  {
    key: 'input',
    label: 'Поле ввода номера полиса',
    instruction: 'Кликните по полю ввода номера полиса',
  },
  {
    key: 'findBtn',
    label: 'Кнопка «Найти»',
    instruction: 'Кликните по кнопке «Найти» (нажимается сразу после ввода номера полиса)',
  },
  {
    key: 'continueBtnInactive',
    label: 'Кнопка «Продолжить» (неактивная)',
    instruction: 'Кликните по кнопке «Продолжить», пока она ещё неактивна (сразу после «Найти»)',
  },
  {
    key: 'continueBtnActive',
    label: 'Кнопка «Продолжить» (активная)',
    instruction: 'Кликните по кнопке «Продолжить», когда она уже активна (данные подтянулись)',
  },
  {
    key: 'priceResult',
    label: 'Результат «Цена»',
    instruction: 'Откройте в рабочей вкладке экран с результатом «Цена» и кликните по нему',
  },
  {
    key: 'impossibleResult',
    label: 'Результат «Невозможно рассчитать»',
    instruction: 'Откройте в рабочей вкладке экран с результатом «Невозможно рассчитать» и кликните по нему',
  },
];

let fileHandle = null;
let workbook = null;
let sheetName = null;
let sheet = null;
let cellWriter = null;

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
  selectorRows: document.getElementById('selectorRows'),
  openPageBtn: document.getElementById('openPageBtn'),
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
  renderSelectorRows();
  await refreshSelectorDots();
  wireUi();
}

function wireUi() {
  els.openFileBtn.addEventListener('click', () => openFile().catch((e) => log(`Не удалось открыть файл: ${e.message || e}`, 'error')));
  els.sheetSelect.addEventListener('change', onSheetChange);
  els.policyColSelect.addEventListener('change', () => { policyColIdx = Number(els.policyColSelect.value); saveColumnPrefs(); });
  els.resultColSelect.addEventListener('change', () => { resultColIdx = Number(els.resultColSelect.value); saveColumnPrefs(); });
  els.openPageBtn.addEventListener('click', () => openWorkingPage().catch((e) => log(String(e.message || e), 'error')));
  els.startBtn.addEventListener('click', () => startRun().catch((e) => log(String(e.message || e), 'error')));
  els.stopBtn.addEventListener('click', stopRun);
  els.teachPriceBtn.addEventListener('click', () => confirmTeachRole('price').catch((e) => log(String(e.message || e), 'error')));
  els.teachImpossibleBtn.addEventListener('click', () => confirmTeachRole('impossible').catch((e) => log(String(e.message || e), 'error')));
}

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
    if (err && err.name === 'AbortError') return;
    throw err;
  }

  fileHandle = handle;
  const file = await fileHandle.getFile();
  els.fileName.textContent = file.name;
  const buf = await file.arrayBuffer();
  workbook = XLSX.read(buf, { type: 'array', cellStyles: true });
  cellWriter = await XlsxCellWriter.open(buf);

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
  await cellWriter.useSheet(sheetName);
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

function isWhiteOrDefaultFill(color) {
  if (!color) return true;
  if (color.rgb) return color.rgb.toUpperCase().slice(-6) === 'FFFFFF';
  if (color.theme === 0) return true; // "Фон 1" — цвет темы по умолчанию, обычно белый
  if (color.indexed === 1 || color.indexed === 64 || color.indexed === 65) return true;
  return false;
}

function isCellColored(cell) {
  if (!cell || !cell.s || !cell.s.patternType || cell.s.patternType === 'none') return false;
  if (cell.s.patternType !== 'solid') return true;
  return !isWhiteOrDefaultFill(cell.s.fgColor);
}

function isCellCommented(cell) {
  return !!(cell && Array.isArray(cell.c) && cell.c.length > 0);
}

function extractRows() {
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rows = [];
  let skippedByFilter = 0;
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const policyRef = XLSX.utils.encode_cell({ r, c: policyColIdx });
    const policyCell = sheet[policyRef];
    const value = policyCell ? String(policyCell.v).trim() : '';
    if (!value) continue;

    const resultRef = XLSX.utils.encode_cell({ r, c: resultColIdx });
    const resultCell = sheet[resultRef];
    if (isCellColored(resultCell) || isCellCommented(resultCell)) {
      skippedByFilter++;
      continue;
    }

    rows.push({ id: `row-${r}`, rowIndex: r, policyNumber: value, resultRef });
  }
  rows.skippedByFilter = skippedByFilter;
  return rows;
}

async function persistResult(resultRef, text) {
  if (!fileHandle || !cellWriter) return;
  cellWriter.setCell(resultRef, text);
  const bytes = await cellWriter.toBytes();
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

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

function renderSelectorRows() {
  els.selectorRows.innerHTML = '';
  SELECTOR_ROLES.forEach((role) => {
    const row = document.createElement('div');
    row.className = 'row selector-row';
    row.innerHTML = `
      <span class="status-dot" id="dot-${role.key}"></span>
      <span class="sel-label">${role.label}</span>
      <button class="secondary assign-btn" data-role="${role.key}">Назначить</button>
      <button class="secondary reset-btn" data-role="${role.key}">Сбросить</button>
      ${role.skippable ? `<label class="muted"><input type="checkbox" class="skip-toggle" data-role="${role.key}"> Пропускать этот шаг</label>` : ''}
      <span class="muted sel-meta" id="meta-${role.key}"></span>
    `;
    els.selectorRows.appendChild(row);
  });

  els.selectorRows.addEventListener('click', (e) => {
    const assignBtn = e.target.closest('.assign-btn');
    const resetBtn = e.target.closest('.reset-btn');
    if (assignBtn) {
      assignSelector(assignBtn.dataset.role).catch((err) => log(String(err.message || err), 'error'));
    } else if (resetBtn) {
      resetSelector(resetBtn.dataset.role);
    }
  });

  els.selectorRows.addEventListener('change', (e) => {
    const toggle = e.target.closest('.skip-toggle');
    if (toggle) setSkip(toggle.dataset.role, toggle.checked).catch((err) => log(String(err.message || err), 'error'));
  });
}

async function setSkip(role, skipped) {
  const config = await getConfig();
  config.skip = config.skip || {};
  config.skip[role] = skipped;
  await setConfig(config);
  await refreshSelectorDots();
  const roleDef = SELECTOR_ROLES.find((r) => r.key === role);
  log(`${skipped ? 'Пропуск включён' : 'Пропуск выключен'} для «${roleDef ? roleDef.label : role}»`, 'info');
}

async function refreshSelectorDots() {
  const config = await getConfig();
  const sel = config.selectors || {};
  const skip = config.skip || {};
  SELECTOR_ROLES.forEach((role) => {
    const skipped = !!(role.skippable && skip[role.key]);
    const dot = document.getElementById(`dot-${role.key}`);
    const metaEl = document.getElementById(`meta-${role.key}`);
    const entry = sel[role.key];
    if (dot) dot.classList.toggle('ok', skipped || !!entry);
    if (metaEl) metaEl.textContent = skipped ? 'шаг пропускается' : entry && entry.meta ? entry.meta : '';

    const toggle = document.querySelector(`.skip-toggle[data-role="${role.key}"]`);
    if (toggle) toggle.checked = skipped;
    const assignBtn = document.querySelector(`.assign-btn[data-role="${role.key}"]`);
    const resetBtn = document.querySelector(`.reset-btn[data-role="${role.key}"]`);
    if (assignBtn) assignBtn.disabled = skipped;
    if (resetBtn) resetBtn.disabled = skipped;
  });
}

function setRowBusy(role, busy) {
  document.querySelectorAll(`[data-role="${role}"]`).forEach((btn) => { btn.disabled = busy; });
}

async function openWorkingPage() {
  await ensureWorkingTab();
  await navigateWorkingTab(START_URL);
  await waitForContentReady();
  log('Рабочая вкладка открыта на странице ВСК', 'ok');
}

async function assignSelector(role) {
  const roleDef = SELECTOR_ROLES.find((r) => r.key === role);
  setRowBusy(role, true);
  try {
    await ensureWorkingTab();
    log(roleDef.instruction, 'info');
    const picked = await pickOnce(role);
    await saveSelector(role, picked);
  } catch (err) {
    log(`Не удалось назначить «${roleDef.label}»: ${err.message || err}`, 'error');
  } finally {
    setRowBusy(role, false);
  }
}

function pickOnce(role) {
  return new Promise((resolve, reject) => {
    const listener = (msg) => {
      if (msg.type === 'ELEMENT_PICKED' && msg.role === role) {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ selector: msg.selector, meta: msg.meta, state: msg.state });
      } else if (msg.type === 'PICK_CANCELLED') {
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error('Выбор отменён'));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.tabs.sendMessage(workingTabId, { type: 'START_PICK', role }).catch((err) => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error(`Рабочая вкладка не готова принять команду — откройте нужную страницу ВСК в рабочей вкладке (${err.message || err})`));
    });
  });
}

async function saveSelector(role, picked) {
  const config = await getConfig();
  config.selectors[role] = { selector: picked.selector, meta: picked.meta, state: picked.state };
  await setConfig(config);
  await refreshSelectorDots();
  log(`Назначено (${role}): ${picked.meta}`, 'ok');
  noteContinueSelectorsMatch(config);
}

function noteContinueSelectorsMatch(config) {
  const inactive = config.selectors.continueBtnInactive;
  const active = config.selectors.continueBtnActive;
  if (inactive && active && inactive.selector === active.selector) {
    log(
      'Неактивная и активная «Продолжить» — один и тот же элемент по расположению, отличается только состоянием (класс/disabled/aria-disabled). Это учтено: проверка ждёт именно смены состояния на активное, а не просто появления элемента.',
      'info'
    );
  }
}

async function resetSelector(role) {
  const config = await getConfig();
  delete config.selectors[role];
  await setConfig(config);
  await refreshSelectorDots();
  const roleDef = SELECTOR_ROLES.find((r) => r.key === role);
  log(`Сброшен селектор «${roleDef ? roleDef.label : role}»`, 'warn');
}

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
        clearRowTimeout();
        log('Рабочая вкладка закрыта — цикл остановлен', 'error');
        if (currentRow) {
          persistResult(currentRow.resultRef, 'Ошибка: рабочая вкладка была закрыта до получения результата').catch(
            (e) => log(`Не удалось сохранить файл: ${e.message || e}`, 'error')
          );
        }
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

async function startRun() {
  if (!sheet) return log('Сначала откройте файл', 'error');
  if (policyColIdx == null || resultColIdx == null) return log('Выберите колонки', 'error');

  queue = extractRows();
  if (queue.length === 0) {
    if (queue.skippedByFilter > 0) {
      return log(
        `В выбранной колонке нет строк для проверки: ${queue.skippedByFilter} найдено, но у всех ячейка результата уже закрашена или содержит комментарий — они считаются обработанными. Если это не так, проверьте выбранную колонку результата или сбросьте заливку/комментарии.`,
        'error'
      );
    }
    return log('В выбранной колонке нет номеров полисов', 'error');
  }

  queueIndex = 0;
  running = true;
  updateRunButtons();
  await ensureWorkingTab();
  updateProgress();
  await processNext();
}

function stopRun() {
  running = false;
  clearRowTimeout();
  chrome.storage.local.set({ run: { active: false, phase: 'idle' } });
  updateRunButtons();
  log('Остановлено пользователем', 'warn');
}

let rowTimeoutId = null;

function armRowTimeout(row) {
  clearRowTimeout();
  rowTimeoutId = setTimeout(() => {
    if (!currentRow || currentRow.id !== row.id) return;
    handleRowDone(
      `Ошибка: нет ответа за ${Math.round(ROW_TIMEOUT_MS / 1000)} c — вкладка не ответила (зависла или ушла на непредвиденную страницу)`,
      'error'
    );
  }, ROW_TIMEOUT_MS);
}

function clearRowTimeout() {
  if (rowTimeoutId) {
    clearTimeout(rowTimeoutId);
    rowTimeoutId = null;
  }
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
  armRowTimeout(currentRow);
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
    clearRowTimeout();
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

async function handleRowDone(text, level) {
  clearRowTimeout();
  try {
    await persistResult(currentRow.resultRef, text);
  } catch (e) {
    log(`Не удалось сохранить файл: ${e.message || e}`, 'error');
  }
  log(`Строка ${currentRow.rowIndex + 1}: ${text}`, level);
  queueIndex++;
  updateProgress();
  await processNext();
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
  await handleRowDone(teach.text, role === 'price' ? 'ok' : 'warn');
}

function log(text, level) {
  const line = document.createElement('div');
  if (level) line.className = level;
  const ts = new Date().toLocaleTimeString('ru-RU');
  line.textContent = `[${ts}] ${text}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}
