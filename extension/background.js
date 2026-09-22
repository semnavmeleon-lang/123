const MANAGER_PAGE = 'manager.html';

chrome.action.onClicked.addListener(async () => {
  const managerUrl = chrome.runtime.getURL(MANAGER_PAGE);
  const existing = await chrome.tabs.query({ url: managerUrl });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: managerUrl });
  }
});
