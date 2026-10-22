// The toolbar button opens the app in a tab (or focuses it if it's already open).
chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL("app.html");
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs.length) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
});
