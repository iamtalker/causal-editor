// 안드로이드 어댑터: 프로그램/server.js가 하던 /api/* 요청을 기기 저장소 파일 작업으로 바꿔 줍니다.
// index.html은 PC와 같은 코드를 씁니다. 이 파일은 copy-web.js가 index.html 맨 앞에 끼워 넣습니다.
// 작은 화면에 맞춘 확대율: 노드 상자가 휴대폰에서 너무 커 보이지 않도록 PC 기본값(1)보다 작게 둡니다.
// index.html이 이 값을 읽습니다. 값을 바꾸면 '실제 크기'와 '전체 그래프 보기'의 최대 확대율이 함께 바뀝니다.
window.CAUSAL_BASE_ZOOM = 0.7;
window.CAUSAL_FIT_MAX_ZOOM = 0.7;

(function () {
  const DEFAULT_DIR = '/storage/emulated/0/Documents/인과편집기';
  const ROOT = '/storage/emulated/0';
  const DIR_KEY = 'causal-android-data-folder';
  const OWN_FILE = /^(n\d+_.*|_경로)\.md$/;
  const HISTORY_FILE = /^\d{8}T\d{6}Z_[a-z0-9-]+\.json$/;
  const RESERVED_DIRS = ['노드파일', '변경이력', '내부데이터'];
  const nativeOk = () => !!(window.Capacitor && window.Capacitor.nativePromise);
  const originalFetch = window.fetch.bind(window);

  const native = (method, options) => window.Capacitor.nativePromise('DataFiles', method, options || {});
  const reply = (status, obj) => new Response(JSON.stringify(obj), {status, headers: {'Content-Type': 'application/json; charset=utf-8'}});
  const fail = (err) => reply(500, {ok: false, error: (err && err.message) || String(err)});

  function dataDir() {
    try { const v = localStorage.getItem(DIR_KEY); if (v) return v; } catch (e) {}
    return DEFAULT_DIR;
  }
  const nodeDir = () => `${dataDir()}/노드파일`;
  const historyDir = () => `${dataDir()}/변경이력`;
  // 그래프 JSON은 노드파일 폴더 밖의 내부데이터에 둡니다 (원본은 노드 .md 파일).
  const graphDir = () => `${dataDir()}/내부데이터`;
  const graphFile = () => `${graphDir()}/그래프.json`;
  const legacyGraphFile = () => `${nodeDir()}/그래프.json`;   // 예전 위치 (옮긴 뒤 지웁니다)
  const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  async function readJson(path) {
    const r = await native('readText', {path});
    return r.exists ? JSON.parse(r.text) : null;
  }
  const writeJson = (path, value) => native('writeText', {path, text: JSON.stringify(value, null, 2)});
  const readBody = (init) => JSON.parse((init && init.body) || '{}');

  async function versionsList() {
    await native('mkdirs', {path: historyDir()});
    const {files} = await native('list', {path: historyDir()});
    const names = files.map(f => f.name).filter(n => HISTORY_FILE.test(n)).sort().reverse();
    const items = [];
    for (const name of names) items.push(await readJson(`${historyDir()}/${name}`));
    return items;
  }

  async function listJsonFiles(dir, depth, found) {
    if (depth > 3 || found.length >= 300) return found;
    const {dirs, files} = await native('list', {path: dir});
    for (const f of files) {
      if (/\.json$/i.test(f.name) && !f.name.startsWith('.') && f.name !== 'data-folder.json') found.push(f.path);
    }
    for (const d of dirs) {
      if (d.name.startsWith('.') || RESERVED_DIRS.includes(d.name) || d.name === 'node_modules') continue;
      await listJsonFiles(d.path, depth + 1, found);
    }
    return found;
  }

  async function handle(method, path, params, init) {
    if (method === 'GET' && path === '/api/graph') {
      const internal = await readJson(graphFile());
      if (internal) return reply(200, {ok: true, source: 'internal', data: internal});
      const legacy = await readJson(legacyGraphFile());
      if (legacy) return reply(200, {ok: true, source: 'legacy', data: legacy});
      return reply(200, {ok: true, data: null});
    }
    if (method === 'POST' && path === '/api/graph') {
      const data = readBody(init);
      if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('잘못된 그래프 데이터입니다.');
      await native('mkdirs', {path: graphDir()});
      await writeJson(graphFile(), data);
      await native('remove', {path: legacyGraphFile()});
      return reply(200, {ok: true});
    }
    // 노드 파일 전체: 그래프의 원본입니다. 파일 내용을 그대로 돌려줍니다.
    if (method === 'GET' && path === '/api/nodes') {
      await native('mkdirs', {path: nodeDir()});
      const {files} = await native('list', {path: nodeDir()});
      const out = [];
      for (const f of files) {
        if (!OWN_FILE.test(f.name)) continue;
        const r = await native('readText', {path: f.path});
        out.push({name: f.name, text: r.text || ''});
      }
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return reply(200, {ok: true, files: out});
    }
    if (method === 'GET' && path === '/api/versions') {
      return reply(200, {ok: true, versions: await versionsList()});
    }
    if (method === 'POST' && path === '/api/versions') {
      const item = readBody(init);
      if (!item || !item.data || !Array.isArray(item.data.nodes) || !Array.isArray(item.data.edges) || typeof item.summary !== 'string') throw new Error('잘못된 버전 데이터입니다.');
      const id = `${stamp()}_${Math.random().toString(36).slice(2, 8)}`;
      const saved = {id, at: new Date().toISOString(), summary: item.summary.slice(0, 160), data: item.data};
      await native('mkdirs', {path: historyDir()});
      await writeJson(`${historyDir()}/${id}.json`, saved);
      return reply(200, {ok: true, version: saved});
    }
    const del = path.match(/^\/api\/versions\/(\d{8}T\d{6}Z_[a-z0-9-]+)$/);
    if (method === 'DELETE' && del) {
      const full = `${historyDir()}/${del[1]}.json`;
      const r = await native('readText', {path: full});
      if (!r.exists) return reply(404, {ok: false, error: '버전을 찾지 못했습니다.'});
      await native('remove', {path: full});
      return reply(200, {ok: true});
    }
    if (method === 'POST' && path === '/api/nodes') {
      const {files} = readBody(init);
      await native('mkdirs', {path: nodeDir()});
      const written = new Set();
      for (const f of files) {
        const name = String(f.name).split('/').pop();
        if (!OWN_FILE.test(name)) continue;
        await native('writeText', {path: `${nodeDir()}/${name}`, text: String(f.text)});
        written.add(name);
      }
      const listing = await native('list', {path: nodeDir()});
      for (const f of listing.files) {
        if (OWN_FILE.test(f.name) && !written.has(f.name)) await native('remove', {path: f.path});
      }
      return reply(200, {ok: true, count: written.size});
    }
    if (method === 'POST' && path === '/api/open') {
      const base = String(readBody(init).name || '').split('/').pop();
      if (!OWN_FILE.test(base)) return reply(400, {ok: false, error: '열 수 없는 파일입니다.'});
      await native('openFile', {path: `${nodeDir()}/${base}`});
      return reply(200, {ok: true});
    }
    if (method === 'GET' && path === '/api/folders') {
      const current = params.get('path') || ROOT;
      const {dirs} = await native('list', {path: current});
      const list = dirs.filter(d => !d.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
        .map(d => ({name: d.name, path: d.path}));
      const parent = current === ROOT ? '' : (current.slice(0, current.lastIndexOf('/')) || ROOT);
      return reply(200, {ok: true, current, parent, dirs: list});
    }
    if (method === 'GET' && path === '/api/data-folder') {
      return reply(200, {ok: true, active: dataDir(), default: DEFAULT_DIR});
    }
    if (method === 'POST' && path === '/api/data-folder') {
      const requested = String(readBody(init).path || '').trim();
      if (!requested) {
        try { localStorage.removeItem(DIR_KEY); } catch (e) {}
        return reply(200, {ok: true, path: '', note: '기본 폴더로 되돌렸습니다.'});
      }
      await native('list', {path: requested});
      try { localStorage.setItem(DIR_KEY, requested); } catch (e) {}
      return reply(200, {ok: true, path: requested, note: '저장했습니다. 다음 저장부터 이 폴더를 씁니다.'});
    }
    if (method === 'POST' && path === '/api/alive') {
      return reply(200, {ok: true});
    }
    if (method === 'GET' && path === '/api/project-json') {
      const base = `${dataDir()}/`;
      const files = await listJsonFiles(dataDir(), 0, []);
      return reply(200, {ok: true, files: files.map(f => f.slice(base.length)).sort()});
    }
    if (method === 'GET' && path === '/api/project-json/read') {
      const rel = params.get('path') || '';
      if (rel.includes('..') || !/\.json$/i.test(rel)) return reply(404, {ok: false, error: '파일을 찾지 못했습니다.'});
      const r = await native('readText', {path: `${dataDir()}/${rel}`});
      if (!r.exists) return reply(404, {ok: false, error: '파일을 찾지 못했습니다.'});
      return new Response(r.text, {status: 200, headers: {'Content-Type': 'application/json; charset=utf-8'}});
    }
    return reply(404, {ok: false, error: '지원하지 않는 요청입니다.'});
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : ((input && input.url) || '');
    if (!url.startsWith('/api/')) return originalFetch(input, init);
    const u = new URL(url, 'https://localhost');
    const method = ((init && init.method) || 'GET').toUpperCase();
    if (!nativeOk()) return Promise.resolve(fail(new Error('안드로이드 앱 안에서만 동작합니다.')));
    return handle(method, u.pathname, u.searchParams, init).catch(fail);
  };

  // 시작할 때 파일 접근 권한을 확인합니다.
  document.addEventListener('DOMContentLoaded', async () => {
    if (!nativeOk()) return;
    try {
      const s = await native('status');
      if (!s.granted) {
        alert('그래프 파일을 저장하려면 "모든 파일 관리" 권한이 필요합니다. 다음 화면에서 허용해 주세요.');
        await native('openAccessSettings');
      }
    } catch (e) { /* 권한 확인 실패 시에도 편집은 계속할 수 있습니다 */ }
  });
})();
