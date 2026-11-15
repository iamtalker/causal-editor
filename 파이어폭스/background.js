// 툴바 아이콘을 누르면 편집기를 새 탭으로 엽니다. 이미 열려 있으면 그 탭으로 이동합니다(탭 두 개가 같은 데이터를 고치는 일을 피합니다).
// 파이어폭스에는 chrome.runtime.getContexts가 없어서 tabs.query로 같은 주소의 탭을 찾습니다.
const api = typeof browser !== 'undefined' ? browser : chrome;
api.action.onClicked.addListener(async () => {
  const url = api.runtime.getURL('index.html');
  try {
    const tabs = await api.tabs.query({url});
    if (tabs.length) {
      await api.tabs.update(tabs[0].id, {active: true});
      await api.windows.update(tabs[0].windowId, {focused: true});
      return;
    }
  } catch (e) { /* 찾지 못하면 새 탭을 엽니다 */ }
  api.tabs.create({url});
});
