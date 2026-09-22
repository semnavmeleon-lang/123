let lastHighlighted = null;
let pickCallback = null;

chrome.runtime.sendMessage({ type: 'CONTENT_READY', url: location.href }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_PICK') {
    enterPickMode((el) => {
      chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKED',
        role: msg.role,
        selector: buildSelector(el),
        meta: describeElement(el),
      });
    });
    sendResponse({ ok: true });
  }
  return true;
});

main().catch((err) => console.error('[vsk-prolong] main() error', err));

async function main() {
  const { run, config } = await chrome.storage.local.get(['run', 'config']);
  if (!run || !run.active) return;

  try {
    if (run.phase === 'awaiting-form') {
      await runFormPhase(run, config || {});
    } else if (run.phase === 'awaiting-result' || run.phase === 'teach-result') {
      await runResultPhase(run, config || {});
    }
  } catch (err) {
    reportError(run, err);
  }
}

async function runFormPhase(run, config) {
  const sel = config.selectors || {};
  const skip = config.skip || {};

  const missing = [];
  if (!skip.checkbox && !sel.checkbox) missing.push('чекбокс «Предыдущий полис ВСК»');
  if (!sel.input) missing.push('поле ввода полиса');
  if (!sel.findBtn) missing.push('кнопка «Найти»');
  if (!sel.continueBtnInactive) missing.push('«Продолжить» (неактивная)');
  if (!sel.continueBtnActive) missing.push('«Продолжить» (активная)');
  if (missing.length > 0) {
    reportError(run, new Error(`Не назначены элементы формы: ${missing.join(', ')} — сделайте это в панели`));
    return;
  }

  const checkbox = skip.checkbox ? null : await waitForElement(sel.checkbox.selector, FORM_WAIT_MS);
  const input = await waitForElement(sel.input.selector, FORM_WAIT_MS);
  const findBtn = await waitForElement(sel.findBtn.selector, FORM_WAIT_MS);

  if (checkbox && !checkbox.checked) checkbox.click();
  setNativeValue(input, run.policyNumber);
  findBtn.click();

  const continueBtn = await waitForElement(sel.continueBtnActive.selector, FORM_WAIT_MS);

  const nextRun = { ...run, phase: 'awaiting-result' };
  await chrome.storage.local.set({ run: nextRun });

  continueBtn.click();

  await runResultPhase(nextRun, config);
}

async function runResultPhase(run, config) {
  const sel = config.selectors || {};
  const known = [];
  if (sel.priceResult) known.push({ role: 'price', selector: sel.priceResult.selector });
  if (sel.impossibleResult) known.push({ role: 'impossible', selector: sel.impossibleResult.selector });

  if (known.length === 0) {
    requestTeach(run);
    return;
  }

  let match;
  try {
    match = await waitForAny(known.map((k) => k.selector), RESULT_WAIT_MS);
  } catch {
    if (known.length < 2) {
      requestTeach(run);
      return;
    }
    reportError(run, new Error('Не дождались результата: оба варианта уже изучены, но не появились'));
    return;
  }

  const role = known.find((k) => k.selector === match.selector).role;
  finishRow(run, role, textOf(match.element));
}

function requestTeach(run) {
  chrome.storage.local.set({ run: { ...run, phase: 'teach-result' } });
  chrome.runtime.sendMessage({ type: 'NEED_TEACH', rowId: run.rowId });
  enterPickMode((el) => {
    chrome.runtime.sendMessage({
      type: 'TEACH_PICKED',
      rowId: run.rowId,
      selector: buildSelector(el),
      text: textOf(el),
      meta: describeElement(el),
    });
  });
}

function finishRow(run, role, text) {
  chrome.storage.local.set({ run: { ...run, active: false, phase: 'idle' } });
  chrome.runtime.sendMessage({ type: 'RESULT', rowId: run.rowId, role, text });
}

function reportError(run, err) {
  chrome.storage.local.set({ run: { ...run, active: false, phase: 'idle' } });
  chrome.runtime.sendMessage({ type: 'ERROR', rowId: run.rowId, message: String((err && err.message) || err) });
}

function textOf(el) {
  return (el.innerText || el.textContent || '').trim();
}

function isVisible(el) {
  if (!el) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function waitForElement(selector, timeout) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing && isVisible(existing)) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) {
        cleanup();
        resolve(el);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    const timer = timeout
      ? setTimeout(() => {
          cleanup();
          reject(new Error(`Элемент не появился: ${selector}`));
        }, timeout)
      : null;

    function cleanup() {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    }
  });
}

function waitForAny(selectors, timeout) {
  return new Promise((resolve, reject) => {
    const check = () => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && isVisible(el)) return { selector, element: el };
      }
      return null;
    };

    const existing = check();
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const found = check();
      if (found) {
        cleanup();
        resolve(found);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    const timer = timeout
      ? setTimeout(() => {
          cleanup();
          reject(new Error('Ни один из ожидаемых результатов не появился'));
        }, timeout)
      : null;

    function cleanup() {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    }
  });
}

function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function enterPickMode(onPick) {
  exitPickMode();
  pickCallback = onPick;
  document.addEventListener('mouseover', handleHover, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleEscape, true);
}

function exitPickMode() {
  document.removeEventListener('mouseover', handleHover, true);
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('keydown', handleEscape, true);
  clearHighlight();
  pickCallback = null;
}

function handleHover(e) {
  clearHighlight();
  lastHighlighted = e.target;
  lastHighlighted.style.outline = '2px solid #ff3860';
  lastHighlighted.style.outlineOffset = '1px';
}

function clearHighlight() {
  if (lastHighlighted) {
    lastHighlighted.style.outline = '';
    lastHighlighted.style.outlineOffset = '';
    lastHighlighted = null;
  }
}

function handleClick(e) {
  if (!pickCallback) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  const el = e.target;
  const cb = pickCallback;
  exitPickMode();
  cb(el);
}

function handleEscape(e) {
  if (e.key === 'Escape' && pickCallback) {
    exitPickMode();
    chrome.runtime.sendMessage({ type: 'PICK_CANCELLED' });
  }
}

function buildSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function describeElement(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
  const type = el.getAttribute('type') ? `[type="${el.getAttribute('type')}"]` : '';
  const text = textOf(el).slice(0, 40);
  return `${tag}${id}${name}${type}${text ? ' "' + text + '"' : ''}`;
}
