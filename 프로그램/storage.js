// 인과 편집기 저장소.
// 편집기는 아래 두 방식 중 하나로 노드 파일·그래프 JSON·버전 기록을 저장하고 읽습니다. 화면 코드는 방식을 신경 쓰지 않습니다.
//   browser 기본값. 이 브라우저(확장 프로그램)의 IndexedDB에 저장합니다. 권한 확인이 필요 없습니다.
//   folder  사용자가 고른 폴더에 노드파일/·내부데이터/·변경이력/ 을 만듭니다. 크롬·엣지(File System Access API)에서만 됩니다.
// 폴더를 연결하면 폴더가 원본입니다. 브라우저에 저장된 내용은 그대로 두고 쓰지 않으며, 연결을 끊으면 다시 그 내용으로 돌아옵니다.
const Store = (function () {
  const OWN_FILE = /^(n\d+_.*|_경로)\.md$/;
  const HISTORY_FILE = /^\d{8}T\d{6}Z_[a-z0-9-]+\.json$/;
  const DIR_NODES = '노드파일', DIR_GRAPH = '내부데이터', DIR_HISTORY = '변경이력', GRAPH_NAME = '그래프.json';
  const folderSupported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

  const S = {mode: 'browser', folderName: '', handle: null, folderReady: false};

  /* ---------- IndexedDB ---------- */
  let dbPromise = null;
  function db() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open('causal-editor-data', 1);
      open.onupgradeneeded = () => {
        const d = open.result;
        d.createObjectStore('nodes', {keyPath: 'name'});
        d.createObjectStore('kv');
        d.createObjectStore('versions', {keyPath: 'id'});
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error || new Error('브라우저 저장소를 열지 못했습니다.'));
    });
    return dbPromise;
  }
  // 요청 하나를 실행하고 트랜잭션이 끝날 때까지 기다립니다. fn(store들) 안에서 요청을 만들어 돌려줍니다.
  async function tx(stores, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let result;
      const out = fn(...stores.map(s => t.objectStore(s)));
      if (out && 'onsuccess' in out) out.onsuccess = () => { result = out.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = t.onabort = () => reject(t.error || new Error('브라우저 저장 실패'));
    });
  }
  const kvGet = key => tx(['kv'], 'readonly', kv => kv.get(key));
  const kvSet = (key, value) => tx(['kv'], 'readwrite', kv => kv.put(value, key));
  const kvDel = key => tx(['kv'], 'readwrite', kv => kv.delete(key));

  /* ---------- 폴더 (File System Access API) ---------- */
  async function permission(handle, ask) {
    const opt = {mode: 'readwrite'};
    if ((await handle.queryPermission(opt)) === 'granted') return true;
    if (!ask) return false;
    try { return (await handle.requestPermission(opt)) === 'granted'; } catch (e) { return false; }
  }
  // 폴더를 쓸 수 있는 상태인지 확인하고 루트 핸들을 돌려줍니다. 권한이 풀렸으면 다시 허용을 요청합니다(버튼 클릭 같은 사용자 동작 안에서만 성공).
  async function root() {
    if (!S.handle) throw new Error('연결된 폴더가 없습니다.');
    if (!(await permission(S.handle, true))) {
      S.folderReady = false;
      throw new Error('폴더 접근 권한이 필요합니다. "파일 다시 읽기"나 설정의 "폴더 다시 허용"을 눌러 허용해 주세요.');
    }
    S.folderReady = true;
    return S.handle;
  }
  const sub = async (name, create) => (await root()).getDirectoryHandle(name, {create});
  async function readText(dir, name) {
    try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
    catch (e) { if (e && e.name === 'NotFoundError') return null; throw e; }
  }
  async function writeText(dir, name, text) {
    const w = await (await dir.getFileHandle(name, {create: true})).createWritable();   // 닫을 때 한 번에 반영되어 중간에 끊겨도 파일이 깨지지 않습니다
    await w.write(text);
    await w.close();
  }
  async function writeIfChanged(dir, name, text) {
    if ((await readText(dir, name)) === text) return false;
    await writeText(dir, name, text);
    return true;
  }
  async function listFiles(dir, pattern) {
    const names = [];
    for await (const [name, h] of dir.entries()) if (h.kind === 'file' && pattern.test(name)) names.push(name);
    return names.sort();
  }

  const newVersionId = () => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}_${Math.random().toString(36).slice(2, 8)}`;
  function checkGraph(d) { if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('잘못된 그래프 데이터입니다.'); }

  /* ---------- 공통 인터페이스 ---------- */
  // 노드 파일 전체: [{name, text}]
  async function readNodes() {
    if (S.mode === 'folder') {
      const dir = await sub(DIR_NODES, true);
      const files = [];
      for (const name of await listFiles(dir, OWN_FILE)) files.push({name, text: await readText(dir, name)});
      return files;
    }
    return (await tx(['nodes'], 'readonly', s => s.getAll())).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  // 노드 파일 저장. 바뀐 것만 쓰고, 이번 목록에 없는 예전 노드 파일은 지웁니다. → {count, changed}
  async function writeNodes(files) {
    const clean = files.filter(f => OWN_FILE.test(String(f.name))).map(f => ({name: String(f.name), text: String(f.text)}));
    if (S.mode === 'folder') {
      const dir = await sub(DIR_NODES, true);
      let changed = 0;
      for (const f of clean) if (await writeIfChanged(dir, f.name, f.text)) changed++;
      const keep = new Set(clean.map(f => f.name));
      for (const old of await listFiles(dir, OWN_FILE)) if (!keep.has(old)) await dir.removeEntry(old);
      return {count: clean.length, changed};
    }
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(['nodes'], 'readwrite'), s = t.objectStore('nodes');
      const keep = new Set(clean.map(f => f.name));
      let changed = 0;
      s.getAll().onsuccess = e => {
        const old = new Map(e.target.result.map(x => [x.name, x.text]));
        for (const name of old.keys()) if (!keep.has(name)) s.delete(name);
        for (const f of clean) if (old.get(f.name) !== f.text) { s.put(f); changed++; }
      };
      t.oncomplete = () => resolve({count: clean.length, changed});
      t.onerror = t.onabort = () => reject(t.error || new Error('브라우저 저장 실패'));
    });
  }

  // 설정과 백업을 담은 보조 그래프 JSON → {data} (없으면 data는 null)
  async function readGraph() {
    if (S.mode === 'folder') {
      const text = await readText(await sub(DIR_GRAPH, true), GRAPH_NAME);
      return {ok: true, data: text ? JSON.parse(text) : null};
    }
    return {ok: true, data: (await kvGet('graph')) || null};
  }
  async function writeGraph(data) {
    checkGraph(data);
    if (S.mode === 'folder') { await writeIfChanged(await sub(DIR_GRAPH, true), GRAPH_NAME, JSON.stringify(data, null, 2)); return; }
    await kvSet('graph', data);
  }

  // 버전 기록. 최신순 [{id, at, summary, data}]
  async function listVersions() {
    if (S.mode === 'folder') {
      const dir = await sub(DIR_HISTORY, true);
      const items = [];
      for (const name of (await listFiles(dir, HISTORY_FILE)).reverse()) items.push(JSON.parse(await readText(dir, name)));
      return items;
    }
    return (await tx(['versions'], 'readonly', s => s.getAll())).sort((a, b) => a.id < b.id ? 1 : -1);
  }
  async function addVersion(item) {
    if (!item || !item.data) throw new Error('잘못된 버전 데이터입니다.');
    checkGraph(item.data);
    const id = newVersionId();
    const saved = {id, at: new Date().toISOString(), summary: String(item.summary || '').slice(0, 160), data: item.data};
    if (S.mode === 'folder') await writeText(await sub(DIR_HISTORY, true), `${id}.json`, JSON.stringify(saved, null, 2));
    else await tx(['versions'], 'readwrite', s => s.put(saved));
    return saved;
  }
  async function deleteVersion(id) {
    if (!HISTORY_FILE.test(`${id}.json`)) throw new Error('버전을 찾지 못했습니다.');
    if (S.mode === 'folder') { await (await sub(DIR_HISTORY, true)).removeEntry(`${id}.json`); return; }
    await tx(['versions'], 'readwrite', s => s.delete(id));
  }

  /* ---------- 폴더 연결 ---------- */
  // 폴더 고르기 창을 띄웁니다(사용자 동작 안에서 불러야 합니다). 아직 저장소 방식은 바꾸지 않고 핸들만 돌려줍니다.
  async function pickFolder() {
    if (!folderSupported) throw new Error('이 브라우저는 폴더 저장을 지원하지 않습니다. 크롬이나 엣지를 쓰세요.');
    return window.showDirectoryPicker({id: 'causal-editor', mode: 'readwrite'});
  }
  // 고른 폴더에 이미 있는 노드 파일 개수 (연결 전에 어느 쪽을 쓸지 물을 때 씁니다)
  async function countNodeFiles(handle) {
    try { return (await listFiles(await handle.getDirectoryHandle(DIR_NODES), OWN_FILE)).filter(n => n !== '_경로.md').length; }
    catch (e) { if (e && e.name === 'NotFoundError') return 0; throw e; }
  }
  async function useFolder(handle) {
    if (!(await permission(handle, true))) throw new Error('폴더 접근을 허용하지 않았습니다.');
    S.handle = handle; S.folderName = handle.name; S.folderReady = true; S.mode = 'folder';
    await kvSet('dirHandle', handle);
  }
  async function disconnectFolder() {
    S.handle = null; S.folderName = ''; S.folderReady = false; S.mode = 'browser';
    await kvDel('dirHandle');
  }
  async function allowFolderAgain() { await root(); }

  // 시작할 때 한 번 부릅니다. 저장해 둔 폴더가 있으면 폴더 방식, 없으면 브라우저 방식입니다.
  async function init() {
    try {
      const handle = folderSupported ? await kvGet('dirHandle') : null;
      if (handle) {
        S.handle = handle; S.folderName = handle.name; S.mode = 'folder';
        S.folderReady = await permission(handle, false);
      }
    } catch (e) { /* 저장소를 못 열어도 브라우저 방식으로 계속 */ }
    return S;
  }

  return {
    state: S, init, OWN_FILE, folderSupported,
    readNodes, writeNodes, readGraph, writeGraph, listVersions, addVersion, deleteVersion,
    pickFolder, countNodeFiles, useFolder, disconnectFolder, allowFolderAgain,
    // 브라우저 저장소의 노드 파일을 폴더로 옮기거나, 폴더 내용을 확인할 때 씁니다.
    readBrowserNodes: async () => (await tx(['nodes'], 'readonly', s => s.getAll())).sort((a, b) => a.name < b.name ? -1 : 1)
  };
})();
