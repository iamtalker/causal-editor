// 툴바 아이콘을 누르면 편집기를 새 탭으로 엽니다. 이미 열려 있으면 그 탭으로 이동합니다(탭 두 개가 같은 데이터를 고치는 일을 피합니다).
chrome.action.onClicked.addListener(async () => {
  const url = new URL('index.html', self.location.href).href;   // background.js와 같은 폴더(프로그램/)의 index.html
  try {
    const open = await chrome.runtime.getContexts({contextTypes: ['TAB']});
    const hit = open.find(c => c.documentUrl && c.documentUrl.startsWith(url) && c.tabId >= 0);
    if (hit) {
      const tab = await chrome.tabs.update(hit.tabId, {active: true});
      await chrome.windows.update(tab.windowId, {focused: true});
      return;
    }
  } catch (e) { /* 찾지 못하면 새 탭을 엽니다 */ }
  chrome.tabs.create({url});
});
