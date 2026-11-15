// 인과 편집기 저장소 (설치버전).
// 노드 파일·그래프 JSON·버전 기록은 편집기를 띄운 도우미 서버(server.js)가 데이터 폴더의 노드파일/·내부데이터/·변경이력/ 에 저장하고 읽습니다.
// 화면 코드는 저장 방식을 신경 쓰지 않습니다. 폴더 방식에서 쓰는 이름(mode 'folder' 등)을 그대로 따릅니다.
const Store = (function () {
  const OWN_FILE = /^(n\d+_.*|_경로)\.md$/;
  const S = {mode: 'folder', folderName: '', folderPath: '', defaultPath: '', custom: false, handle: null, folderReady: true};
  let alive = null;

  const base = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');
  const DOWN = '서버에 연결하지 못했습니다. 편집기 서버가 꺼졌을 수 있습니다. 인과편집기.bat을 다시 실행하세요.';

  async function api(path, opt = {}) {
    let res;
    try { res = await fetch(path, {cache: 'no-store', ...opt, headers: opt.body ? {'Content-Type': 'application/json'} : undefined}); }
    catch (e) { throw new Error(DOWN); }
    let j;
    try { j = await res.json(); } catch (e) { throw new Error(`서버 응답을 읽지 못했습니다 (${res.status})`); }
    if (!res.ok || !j.ok) throw new Error(j.error || `서버 오류 (${res.status})`);
    return j;
  }
  const post = (path, value, opt = {}) => api(path, {method: 'POST', body: JSON.stringify(value), ...opt});

  function applyFolder(j) {
    S.folderPath = j.active; S.folderName = base(j.active); S.custom = !!j.custom;
    if (j.default) S.defaultPath = j.default;
  }

  /* ---------- 공통 인터페이스 ---------- */
  // 노드 파일 전체: [{name, text}]
  async function readNodes() { return (await api('/api/nodes')).files; }
  // 노드 파일 저장. 바뀐 것만 쓰고, 이번 목록에 없는 예전 노드 파일은 지웁니다. → {count, changed}
  async function writeNodes(files) {
    const clean = files.filter(f => OWN_FILE.test(String(f.name))).map(f => ({name: String(f.name), text: String(f.text)}));
    const body = JSON.stringify({files: clean});
    const j = await api('/api/nodes', {method: 'POST', body, keepalive: body.length < 60000});   // 탭을 닫는 중에도 작은 저장은 끝까지 보냅니다
    return {count: j.count, changed: j.changed};
  }
  // 설정과 백업을 담은 보조 그래프 JSON → {data} (없으면 data는 null)
  async function readGraph() { return {ok: true, data: (await api('/api/graph')).data}; }
  async function writeGraph(data) {
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('잘못된 그래프 데이터입니다.');
    await post('/api/graph', data);
  }
  // 버전 기록. 최신순 [{id, at, summary, data}]
  async function listVersions() { return (await api('/api/versions')).versions; }
  async function addVersion(item) {
    if (!item || !item.data) throw new Error('잘못된 버전 데이터입니다.');
    return (await post('/api/versions', {summary: String(item.summary || '').slice(0, 160), data: item.data})).version;
  }
  async function deleteVersion(id) { await api(`/api/versions/${encodeURIComponent(id)}`, {method: 'DELETE'}); }

  /* ---------- 데이터 폴더 ---------- */
  // 폴더 고르기 창(서버가 PowerShell로 띄움). 창을 못 띄우면 경로를 직접 입력받습니다. 취소하면 AbortError를 던집니다.
  async function pickFolder() {
    let p = '';
    try { p = (await post('/api/pick-folder', {})).path; }
    catch (err) {
      if (err.message === DOWN) throw err;
      p = (prompt(`${err.message}\n\n데이터 폴더 경로를 입력하세요. 예: D:\\인과편집기 데이터`) || '').trim();
    }
    if (!p) { const e = new Error('취소'); e.name = 'AbortError'; throw e; }
    return {name: base(p), path: p};
  }
  // 고른 폴더에 이미 있는 노드 파일 개수 (연결 전에 어느 쪽을 쓸지 물을 때 씁니다). path가 비어 있으면 기본 폴더입니다.
  async function countNodeFiles(handle) {
    return (await api(`/api/folder-info?path=${encodeURIComponent(handle.path || S.defaultPath)}`)).nodeFiles;
  }
  async function useFolder(handle) { applyFolder(await post('/api/data-folder', {path: handle.path || ''})); }
  async function disconnectFolder() { await useFolder({path: ''}); }   // 기본 폴더로 되돌립니다
  async function allowFolderAgain() { /* 서버 방식은 권한 확인이 필요 없습니다 */ }

  // 시작할 때 한 번 부릅니다. 서버의 데이터 폴더를 알아 오고, 탭이 열려 있는 동안 서버에 "살아 있음" 연결을 유지합니다.
  async function init() {
    try {
      applyFolder(await api('/api/data-folder'));
      alive = new EventSource('/api/alive-stream');   // 탭을 닫으면 끊기고, 서버는 잠시 뒤 스스로 꺼집니다
    } catch (e) { /* 서버가 꺼져 있으면 이후 읽기·쓰기에서 안내합니다 */ }
    return S;
  }

  return {
    state: S, init, OWN_FILE, folderSupported: true,
    readNodes, writeNodes, readGraph, writeGraph, listVersions, addVersion, deleteVersion,
    pickFolder, countNodeFiles, useFolder, disconnectFolder, allowFolderAgain
  };
})();
