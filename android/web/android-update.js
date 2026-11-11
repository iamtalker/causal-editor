// 안드로이드 앱 업데이트 화면 (apk 업데이트 모듈의 동작을 본땄습니다).
//  - 앱을 열면 6시간에 한 번 GitHub 최신 릴리즈를 확인합니다(설정에서 끌 수 있음).
//  - 새 버전이 있으면 화면 위 띠를 띄우고, 누르면 업데이트 창에서 받아 설치합니다.
//  - 받는 중에는 진행 막대와 알림, 설치 확인 화면과 설치 중 단계를 안내합니다.
//  - 설치 뒤 새 버전으로 켜지면 '업데이트 완료' 띠를 한 번 보여 줍니다.
// copy-web.js가 index.html에 끼워 넣습니다.
(function () {
  const REPO = 'iamtalker/causal-editor-android';
  const AUTO_KEY = 'causal-android-auto-update';          // '0'이면 자동 확인을 끔
  const CHECKED_KEY = 'causal-android-update-checked';    // 마지막 확인 시각(밀리초)
  const LAST_VERSION_KEY = 'causal-android-last-version'; // 마지막으로 켜진 버전
  const DISMISSED_KEY = 'causal-android-dismissed-version';
  const CHECK_EVERY_MS = 6 * 3600 * 1000;

  const nativeOk = () => !!(window.Capacitor && window.Capacitor.nativePromise);
  const updater = (method, options) => window.Capacitor.nativePromise('Updater', method, options || {});
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + 'MB';

  // 저장소 접근은 실패해도 앱은 계속 동작해야 합니다.
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* 저장이 막혀도 이번 실행에는 동작합니다 */ } }
  };
  const autoOn = () => store.get(AUTO_KEY, '1') !== '0';

  // 'v1.1.0' 또는 '1.0' 같은 버전을 숫자 배열로 바꿉니다.
  const parseVersion = (text) => String(text || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  function isNewer(latest, current) {
    const a = parseVersion(latest), b = parseVersion(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  // ---------- 업데이트 창 ----------
  const dlg = document.createElement('dialog');
  dlg.id = 'updDlg';
  dlg.style.cssText = 'width:min(440px,92vw);border:1px solid #cbd2dc;border-radius:12px;padding:18px;font:inherit;color:#222';
  dlg.innerHTML = [
    '<h2 style="font-size:17px;margin:0 0 10px">앱 업데이트</h2>',
    '<p id="updCurrent" style="margin:0 0 8px;font-size:14px"></p>',
    '<label style="display:flex;gap:6px;align-items:center;font-size:13px;margin-bottom:10px">',
    '  <input id="updAuto" type="checkbox"> 앱을 열 때 6시간마다 새 버전 확인',
    '</label>',
    '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">',
    '  <button id="updCheck" type="button">업데이트 확인</button>',
    '  <button id="updAction" type="button" hidden></button>',
    '</div>',
    '<div id="updStatus" role="status" style="font-size:14px;min-height:20px;margin-bottom:8px"></div>',
    '<div id="updBarWrap" hidden style="height:10px;background:#e5e7eb;border-radius:6px;overflow:hidden;margin-bottom:6px">',
    '  <div id="updBar" style="height:100%;width:0;background:#2563eb;transition:width .2s"></div>',
    '</div>',
    '<div id="updProgressText" style="font-size:12px;color:#555;margin-bottom:8px"></div>',
    '<pre id="updNotes" hidden style="white-space:pre-wrap;font:inherit;font-size:13px;background:#f4f5f7;border-radius:8px;padding:8px;max-height:160px;overflow:auto;margin:0 0 10px"></pre>',
    '<div style="text-align:right"><button id="updClose" type="button">닫기</button></div>'
  ].join('');
  // 이 스크립트는 <head>에서 실행되므로 body가 준비된 뒤에 대화상자를 붙입니다.
  const attachDialog = () => document.body.appendChild(dlg);
  if (document.body) attachDialog();
  else document.addEventListener('DOMContentLoaded', attachDialog);

  const $ = (id) => dlg.querySelector('#' + id);
  const setStatus = (text, isError) => {
    const el = $('updStatus');
    el.textContent = text;
    el.style.color = isError ? '#b91c1c' : '#222';
  };
  const setAction = (label, handler) => {
    const btn = $('updAction');
    if (!label) { btn.hidden = true; btn.onclick = null; return; }
    btn.hidden = false;
    btn.textContent = label;
    btn.onclick = handler;
  };
  const showProgress = (show) => {
    $('updBarWrap').hidden = !show;
    if (!show) { $('updBar').style.width = '0'; $('updProgressText').textContent = ''; }
  };

  let pollTimer = null;
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const p = await updater('progress');
        if (!p.total) {
          $('updBar').style.width = '100%';
          $('updProgressText').textContent = `다운로드 중… ${mb(p.received)}`;
          return;
        }
        const pct = Math.min(100, Math.floor(p.received * 100 / p.total));
        $('updBar').style.width = pct + '%';
        $('updProgressText').textContent = `다운로드 중 ${pct}% (${mb(p.received)} / ${mb(p.total)})`;
      } catch (e) { /* 진행률 조회 실패는 무시하고 다운로드는 계속합니다 */ }
    }, 300);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // 설치 단계를 읽어 안내합니다. 5(완료)나 9(실패)가 되면 멈춥니다.
  let installTimer = null;
  function watchInstall() {
    if (installTimer) clearInterval(installTimer);
    installTimer = setInterval(async () => {
      try {
        const s = await updater('installState');
        if (s.step === 9) {
          clearInterval(installTimer); installTimer = null;
          showProgress(false);
          setStatus(s.message, true);
          setAction('다시 시도', () => download());
          $('updCheck').disabled = false;
          return;
        }
        if (s.message) setStatus(s.message);
        if (s.step === 5) { clearInterval(installTimer); installTimer = null; showProgress(false); }
      } catch (e) { /* 앱이 교체되는 순간에는 조회가 실패할 수 있습니다 */ }
    }, 800);
  }

  let currentVersion = '';
  let latest = null;

  // 화면 위 띠 (새 버전 / 업데이트 완료)
  let banner = null;
  function showBanner(text, actionLabel, onAction, dismissable) {
    if (!banner) return;
    banner.querySelector('#updBannerText').textContent = text;
    const btn = banner.querySelector('#updBannerAction');
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel || '';
    btn.onclick = onAction || null;
    banner.querySelector('#updBannerClose').hidden = !dismissable;
    banner.style.display = 'flex';   // 인라인 display가 hidden 속성을 이기므로 여기서 직접 보이게 합니다
  }
  function hideBanner() { if (banner) banner.style.display = 'none'; }

  async function openDialog() {
    $('updAuto').checked = autoOn();
    showProgress(false);
    $('updNotes').hidden = true;
    setAction(null);
    setStatus('');
    dlg.showModal();
    try {
      const info = await updater('appInfo');
      currentVersion = info.versionName;
      $('updCurrent').textContent = `현재 버전: v${currentVersion} (빌드 ${info.versionCode})`;
    } catch (e) {
      $('updCurrent').textContent = '현재 버전을 읽지 못했습니다.';
    }
  }

  // 릴리즈를 확인합니다. silent 이면 결과를 띠로만 알립니다(실패해도 조용히 넘깁니다).
  async function check({silent = false} = {}) {
    if (!silent) {
      $('updCheck').disabled = true;
      setAction(null);
      showProgress(false);
      $('updNotes').hidden = true;
      setStatus('업데이트를 확인하는 중…');
    }
    try {
      // 저장소가 공개라서 토큰 없이 확인합니다
      const info = await updater('checkLatest', {repo: REPO, token: ''});
      store.set(CHECKED_KEY, String(Date.now()));
      latest = info;
      if (silent) {
        if (isNewer(info.tag, currentVersion || '0') && store.get(DISMISSED_KEY, '') !== info.tag) {
          showBanner(`새 버전 ${info.tag} 이(가) 있습니다.`, '업데이트', openFromBanner, true);
        }
        return;
      }
      $('updNotes').hidden = !info.notes;
      $('updNotes').textContent = info.notes || '';
      if (isNewer(info.tag, currentVersion)) {
        setStatus(`새 버전 ${info.tag} 이(가) 있습니다. 현재 버전은 v${currentVersion}입니다.`);
        setAction('다운로드 후 설치', () => download());
      } else {
        setStatus(`최신 버전을 사용 중입니다 (v${currentVersion}).`);
      }
    } catch (err) {
      latest = null;
      if (!silent) setStatus(err.message || String(err), true);
    } finally {
      if (!silent) $('updCheck').disabled = false;
    }
  }

  // 띠의 '업데이트' 버튼: 창을 열고 바로 확인합니다
  async function openFromBanner() {
    await openDialog();
    await check();
  }

  async function download() {
    if (!latest) return;
    const info = latest;
    setAction(null);
    $('updCheck').disabled = true;
    showProgress(true);
    $('updBar').style.width = '0';
    setStatus('다운로드를 시작합니다…');
    startPolling();
    try {
      const file = await updater('download', {url: info.assetUrl, token: '', fileName: info.assetName});
      stopPolling();
      $('updBar').style.width = '100%';
      $('updProgressText').textContent = `다운로드 완료 (${mb(file.size)})`;
      await installFlow(file.path);
    } catch (err) {
      stopPolling();
      showProgress(false);
      setStatus(err.message || String(err), true);
      setAction('다시 시도', () => download());
    } finally {
      $('updCheck').disabled = false;
    }
  }

  async function installFlow(path) {
    setStatus('설치 권한을 확인하는 중…');
    const can = await updater('canInstall');
    if (!can.allowed) {
      setStatus('설치하려면 이 앱의 "출처를 알 수 없는 앱 설치"를 허용해야 합니다. 허용한 뒤 다시 눌러 주세요.', true);
      setAction('설치 허용 화면 열기', async () => {
        await updater('openInstallSettings');
        setStatus('허용했다면 "설치 계속"을 누르세요.');
        setAction('설치 계속', () => installFlow(path));
      });
      return;
    }
    setStatus('설치를 준비하는 중…');
    await updater('install', {path});
    watchInstall();
  }

  // 자동 확인: 앱을 열 때 6시간이 지났으면 조용히 확인합니다.
  function autoCheckIfDue() {
    if (!autoOn() || !currentVersion) return;   // 현재 버전을 모르면 확인하지 않습니다
    const last = parseInt(store.get(CHECKED_KEY, '0'), 10) || 0;
    if (Date.now() - last < CHECK_EVERY_MS) return;
    check({silent: true});
  }

  // 설치를 마치고 새 버전으로 켜졌으면 한 번 알립니다.
  async function noticeIfJustUpdated() {
    const info = await updater('appInfo');
    currentVersion = info.versionName;
    const last = store.get(LAST_VERSION_KEY, '');
    store.set(LAST_VERSION_KEY, currentVersion);
    if (last && last !== currentVersion) {
      showBanner(`앱이 v${currentVersion} 으로 업데이트되었습니다.`, null, null, true);
    }
  }

  // 화면 위 띠 만들기 (헤더 바로 아래)
  function addBanner() {
    banner = document.createElement('div');
    banner.id = 'updBanner';
    banner.style.cssText = 'display:none;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 14px;background:#eff6ff;border-bottom:1px solid #bfd3f7;font-size:13px;color:#1e3a8a';
    banner.innerHTML = [
      '<span id="updBannerText" style="flex:1;min-width:0"></span>',
      '<button id="updBannerAction" type="button" hidden></button>',
      '<button id="updBannerClose" type="button" hidden>나중에</button>'
    ].join('');
    const main = document.querySelector('main');
    if (main && main.parentNode) main.parentNode.insertBefore(banner, main);
    else document.body.insertBefore(banner, document.body.firstChild);
    banner.querySelector('#updBannerClose').onclick = () => {
      const text = banner.querySelector('#updBannerText').textContent;
      if (latest && latest.tag && text.includes(latest.tag)) store.set(DISMISSED_KEY, latest.tag);
      hideBanner();
    };
  }

  $('updAuto').onchange = (e) => store.set(AUTO_KEY, e.target.checked ? '1' : '0');
  $('updCheck').onclick = () => check();
  dlg.querySelector('#updClose').onclick = () => { stopPolling(); dlg.close(); };

  // 이 스크립트는 안드로이드 빌드에만 들어가므로 바로 버튼을 답니다.
  function addButton() {
    const btn = document.createElement('button');
    btn.id = 'btnUpdate';
    btn.type = 'button';
    btn.textContent = '업데이트';
    btn.onclick = openDialog;
    const header = document.querySelector('header') || document.body;
    header.appendChild(btn);
  }
  function start() {
    addButton();
    addBanner();
    if (!nativeOk()) return;
    // 현재 버전을 먼저 읽은 뒤에 비교해야 합니다
    noticeIfJustUpdated().catch(() => {}).then(autoCheckIfDue);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
