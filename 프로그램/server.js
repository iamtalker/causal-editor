// 인과 편집기 도우미 서버
// - index.html을 http://localhost:8787 로 보여 줍니다.
// - 노드 Markdown 파일과 그래프 버전을 각각 '노드파일', '변경이력' 폴더에 저장합니다.
// - 폴더는 없으면 자동으로 만듭니다. 외부 패키지 없이 Node.js 기본 모듈만 사용합니다.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8787;
// 편집기 탭이 열려 있는 동안 10초마다 신호(alive)를 받습니다. 신호가 IDLE_MS 동안 없으면 탭이 닫힌 것으로 보고 서버를 끕니다.
// 브라우저가 백그라운드 탭을 느리게 만들어도 끊기지 않도록 넉넉히 잡았습니다. (EDITOR_IDLE_MS는 시험용)
const IDLE_MS = Number(process.env.EDITOR_IDLE_MS) || 90000;
let lastSeen = Date.now() + IDLE_MS;   // 처음 페이지가 열릴 시간을 줍니다
const APP_DIR = __dirname;
const ROOT = path.resolve(APP_DIR, '..');
const NODE_DIR = path.join(ROOT, '노드파일');
const HISTORY_DIR = path.join(ROOT, '변경이력');
// 이 프로그램이 만든 파일 이름 패턴: n1_제목.md, n12_제목.md, _경로.md
const OWN_FILE = /^(n\d+_.*|_경로)\.md$/;
const HISTORY_FILE = /^\d{8}T\d{6}Z_[a-z0-9-]+\.json$/;
const GRAPH_ID = /^[\p{L}\p{N}_-]{1,80}$/u;
const sendJson = (res, status, value) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
function readBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > maxBytes) { reject(new Error('요청이 너무 큽니다.')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    fs.createReadStream(path.join(APP_DIR, 'index.html')).pipe(res);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sample') {
    try {
      const samplePath = path.join(ROOT, '샘플', '샘플_부자되기.json');
      const sample = fs.readFileSync(samplePath, 'utf8');
      JSON.parse(sample); // 손상된 샘플은 그래프에 적용하지 않도록 확인
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(sample);
    } catch (err) { sendJson(res, 500, {ok: false, error: '부자 되기 예시를 읽지 못했습니다.'}); }
    return;
  }

  if (req.method === 'GET' && req.url === '/api/graphs') {
    try {
      fs.mkdirSync(NODE_DIR, {recursive: true});
      const graphs = [];
      for (const entry of fs.readdirSync(NODE_DIR, {withFileTypes: true})) {
        if (!entry.isDirectory() || !GRAPH_ID.test(entry.name)) continue;
        const jsonName = `${entry.name}.json`, fullDir = path.join(NODE_DIR, entry.name);
        const fullJson = path.join(fullDir, jsonName);
        if (!fs.existsSync(fullJson)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(fullJson, 'utf8'));
          if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) continue;
          graphs.push({id: entry.name, name: path.basename(jsonName, '.json'), data});
        } catch {}
      }
      graphs.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      return sendJson(res, 200, {ok: true, graphs});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }

  const graphMatch = req.url.match(/^\/api\/graphs\/([^/?]+)$/);
  // 그래프 삭제: 폴더를 바로 지우지 않고 변경이력/삭제된_그래프로 옮겨 복구할 수 있게 합니다.
  if (req.method === 'DELETE' && graphMatch) {
    let id;
    try { id = decodeURIComponent(graphMatch[1]); } catch { return sendJson(res, 400, {ok: false, error: '잘못된 그래프 폴더 이름입니다.'}); }
    if (!GRAPH_ID.test(id)) return sendJson(res, 400, {ok: false, error: '잘못된 그래프 폴더 이름입니다.'});
    const src = path.join(NODE_DIR, id);
    if (!fs.existsSync(path.join(src, `${id}.json`))) return sendJson(res, 404, {ok: false, error: '그래프 폴더를 찾지 못했습니다.'});
    try {
      const trashDir = path.join(HISTORY_DIR, '삭제된_그래프');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      fs.mkdirSync(trashDir, {recursive: true});
      const dest = path.join(trashDir, `${id}_${stamp}`);
      fs.renameSync(src, dest);
      return sendJson(res, 200, {ok: true, movedTo: path.relative(ROOT, dest)});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }

  // 그래프 이름 바꾸기: 폴더와 그래프 JSON 파일 이름을 함께 바꿉니다.
  if (req.method === 'PATCH' && graphMatch) {
    let id;
    try { id = decodeURIComponent(graphMatch[1]); } catch { return sendJson(res, 400, {ok: false, error: '잘못된 그래프 폴더 이름입니다.'}); }
    if (!GRAPH_ID.test(id)) return sendJson(res, 400, {ok: false, error: '잘못된 그래프 폴더 이름입니다.'});
    readBody(req).then(body => {
      const {name} = JSON.parse(body);
      const to = String(name || '').normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 70);
      if (!GRAPH_ID.test(to)) throw new Error('이름에는 한글, 영문, 숫자, _, - 만 쓸 수 있습니다.');
      const src = path.join(NODE_DIR, id), dst = path.join(NODE_DIR, to);
      if (!fs.existsSync(path.join(src, `${id}.json`))) return sendJson(res, 404, {ok: false, error: '그래프 폴더를 찾지 못했습니다.'});
      if (to !== id) {
        if (fs.existsSync(dst)) return sendJson(res, 409, {ok: false, error: '같은 이름의 그래프가 이미 있습니다.'});
        fs.renameSync(src, dst);
        fs.renameSync(path.join(dst, `${id}.json`), path.join(dst, `${to}.json`));
      }
      sendJson(res, 200, {ok: true, id: to, name: to});
    }).catch(err => sendJson(res, 400, {ok: false, error: err.message}));
    return;
  }

  if (req.method === 'POST' && graphMatch) {
    let id;
    try { id = decodeURIComponent(graphMatch[1]); } catch { return sendJson(res, 400, {ok: false, error: '잘못된 그래프 폴더 이름입니다.'}); }
    if (!GRAPH_ID.test(id)) return sendJson(res, 400, {ok: false, error: '잘못된 그래프 폴더 이름입니다.'});
    readBody(req).then(body => {
      const data = JSON.parse(body);
      if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('잘못된 그래프 데이터입니다.');
      const graphDir = path.join(NODE_DIR, id);
      fs.mkdirSync(graphDir, {recursive: true});
      fs.writeFileSync(path.join(graphDir, `${id}.json`), JSON.stringify(data, null, 2), 'utf8');
      sendJson(res, 200, {ok: true, id, name: id});
    }).catch(err => sendJson(res, 400, {ok: false, error: err.message}));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/versions') {
    try {
      fs.mkdirSync(HISTORY_DIR, {recursive: true});
      const entries = fs.readdirSync(HISTORY_DIR).filter(name => HISTORY_FILE.test(name)).sort().reverse();
      const items = entries.map(name => JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, name), 'utf8')));
      return sendJson(res, 200, {ok: true, versions: items});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }

  if (req.method === 'POST' && req.url === '/api/versions') {
    readBody(req).then(body => {
      const item = JSON.parse(body);
      if (!item || !item.data || !Array.isArray(item.data.nodes) || !Array.isArray(item.data.edges) || typeof item.summary !== 'string') throw new Error('잘못된 버전 데이터입니다.');
      const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}_${Math.random().toString(36).slice(2, 8)}`;
      const saved = {id, at: new Date().toISOString(), summary: item.summary.slice(0, 160), data: item.data};
      fs.mkdirSync(HISTORY_DIR, {recursive: true});
      fs.writeFileSync(path.join(HISTORY_DIR, `${id}.json`), JSON.stringify(saved, null, 2), 'utf8');
      sendJson(res, 200, {ok: true, version: saved});
    }).catch(err => sendJson(res, 400, {ok: false, error: err.message}));
    return;
  }

  const versionDeleteMatch = req.url.match(/^\/api\/versions\/(\d{8}T\d{6}Z_[a-z0-9-]+)$/);
  if (req.method === 'DELETE' && versionDeleteMatch) {
    const id = versionDeleteMatch[1];
    const full = path.join(HISTORY_DIR, `${id}.json`);
    try {
      if (!HISTORY_FILE.test(`${id}.json`) || !fs.existsSync(full)) return sendJson(res, 404, {ok: false, error: '버전을 찾지 못했습니다.'});
      fs.unlinkSync(full);
      return sendJson(res, 200, {ok: true});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }

  if (req.method === 'POST' && req.url === '/api/nodes') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) req.destroy();   // 너무 큰 요청 차단
    });
    req.on('end', () => {
      try {
        const {files, graphId} = JSON.parse(body);
        const outputDir = graphId ? path.join(NODE_DIR, String(graphId)) : NODE_DIR;
        if (graphId && !GRAPH_ID.test(String(graphId))) throw new Error('잘못된 그래프 폴더 이름입니다.');
        fs.mkdirSync(outputDir, {recursive: true});

        const written = new Set();
        for (const f of files) {
          const name = path.basename(String(f.name));   // 폴더 밖으로 나가지 못하게 경로 제거
          if (!OWN_FILE.test(name)) continue;
          fs.writeFileSync(path.join(outputDir, name), String(f.text), 'utf8');
          written.add(name);
        }

        // 삭제된 노드의 예전 파일 정리 (이 프로그램 파일 패턴에 맞는 것만)
        for (const old of fs.readdirSync(outputDir)) {
          if (OWN_FILE.test(old) && !written.has(old)) fs.unlinkSync(path.join(outputDir, old));
        }

        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify({ok: true, count: written.size}));
      } catch (err) {
        res.writeHead(400, {'Content-Type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify({ok: false, error: err.message}));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/open') {
    // 노드 파일을 PC의 기본 프로그램(메모장 등)으로 엽니다. 노드파일 폴더 안의 이 프로그램 파일만 허용합니다.
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(obj)); };
      try {
        const {name: requestedName, graphId} = JSON.parse(body);
        const name = path.basename(String(requestedName));
        if (!GRAPH_ID.test(String(graphId || ''))) return send(400, {ok: false, error: '그래프 폴더를 찾지 못했습니다.'});
        const full = path.join(NODE_DIR, String(graphId), name);
        if (!OWN_FILE.test(name) || !fs.existsSync(full)) return send(404, {ok: false, error: '파일이 아직 없습니다. 잠시 후 다시 눌러 주세요.'});
        const cmd = process.platform === 'win32' ? `start "" "${full}"`
                  : process.platform === 'darwin' ? `open "${full}"`
                  : `xdg-open "${full}"`;
        require('child_process').exec(cmd);
        send(200, {ok: true});
      } catch (err) {
        send(400, {ok: false, error: err.message});
      }
    });
    return;
  }

  // 편집기 탭이 살아 있다는 신호
  if (req.method === 'POST' && req.url === '/api/alive') {
    lastSeen = Date.now();
    return sendJson(res, 200, {ok: true});
  }

  // 프로젝트 폴더 안의 JSON 파일 목록 (불러오기 창에서 사용)
  if (req.method === 'GET' && req.url === '/api/project-json') {
    const SKIP = new Set(['node_modules', '.venv', '변경이력']);   // 변경이력은 버전 스냅샷이라 목록에서 제외
    const found = [];
    try {
      (function walk(dir, depth) {
        if (depth > 3 || found.length >= 300) return;
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full, depth + 1);
          else if (entry.isFile() && /\.json$/i.test(entry.name)) found.push(path.relative(ROOT, full).split(path.sep).join('/'));
        }
      })(ROOT, 0);
      return sendJson(res, 200, {ok: true, files: found.sort()});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }

  // 프로젝트 폴더 안의 JSON 파일 하나 읽기 (폴더 밖 경로는 거부)
  if (req.method === 'GET' && req.url.startsWith('/api/project-json/read?')) {
    const rel = new URL(req.url, 'http://localhost').searchParams.get('path') || '';
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(ROOT + path.sep) || !/\.json$/i.test(full) || !fs.existsSync(full)) return sendJson(res, 404, {ok: false, error: '파일을 찾지 못했습니다.'});
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    fs.createReadStream(full).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// 이 PC에서만 접속 가능하도록 127.0.0.1에만 엽니다.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`인과 편집기 실행 중: http://localhost:${PORT}`);
  console.log('편집기 탭을 닫으면 잠시 뒤 이 창도 자동으로 꺼집니다.');
  setInterval(() => {
    if (Date.now() - lastSeen > IDLE_MS) {
      console.log('편집기 탭이 닫혀 서버를 끕니다.');
      process.exit(0);
    }
  }, 5000);
  console.log(`프로그램 폴더: ${APP_DIR}`);
  console.log(`노드 파일 폴더: ${NODE_DIR}`);
  console.log(`변경 이력 폴더: ${HISTORY_DIR}`);
  console.log('이 창을 닫으면 편집기가 종료됩니다 (저장된 내용은 유지됩니다).');
});
