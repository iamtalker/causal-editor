// 인과 편집기 도우미 서버
// - index.html을 http://localhost:8787 로 보여 줍니다.
// - 노드 Markdown 파일과 그래프 버전을 각각 '노드파일', '변경이력' 폴더에 저장합니다.
// - 폴더는 없으면 자동으로 만듭니다. 외부 패키지 없이 Node.js 기본 모듈만 사용합니다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');

// 콘솔 출력을 server.log에도 남깁니다. 창 없이(숨김) 실행해도 상태와 오류를 볼 수 있고, 서버가 둘 동시에 써도 막히지 않도록 매번 덧붙여 씁니다.
const LOG_FILE = path.join(__dirname, 'server.log');
try { if (fs.statSync(LOG_FILE).size > 204800) fs.unlinkSync(LOG_FILE); } catch (e) {}   // 200KB가 넘으면 새로 시작
const rawLog = console.log.bind(console);
console.log = (...args) => {
  rawLog(...args);
  try { fs.appendFileSync(LOG_FILE, new Date().toLocaleString('sv-SE') + ' ' + args.join(' ') + '\n'); } catch (e) {}
};
process.on('uncaughtException', err => { console.log('오류로 종료합니다: ' + (err && err.stack || err)); process.exit(1); });

const PORT = 8787;
// 편집기 탭은 열려 있는 동안 /api/alive-stream 연결을 계속 열어 둡니다. 탭을 닫으면 이 연결이 바로 끊기고,
// 연결이 하나도 없는 상태로 IDLE_MS(5초)가 지나면 서버를 끕니다. 연결 방식이라 브라우저가 백그라운드 탭의 타이머를 늦춰도 영향이 없습니다.
// (EDITOR_IDLE_MS, EDITOR_GRACE_MS는 시험용)
const IDLE_MS = Number(process.env.EDITOR_IDLE_MS) || 5000;
// 서버를 막 켰거나 이미 켜진 서버에 다시 붙을 때는 브라우저가 페이지를 열 시간을 줍니다.
const GRACE_MS = Number(process.env.EDITOR_GRACE_MS) || 30000;
const graceTime = () => Date.now() + GRACE_MS - IDLE_MS;
let lastSeen = graceTime();
let openStreams = 0;
const APP_DIR = __dirname;
const ROOT = path.resolve(APP_DIR, '..');
// 데이터 폴더: 설정 창에서 지정한 외부 폴더가 있으면 노드파일·변경이력을 그곳에 둡니다. 없으면 프로젝트 폴더입니다.
const CONFIG_FILE = path.join(APP_DIR, 'data-folder.json');
function readDataFolder() {
  try {
    const p = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).path;
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) return path.resolve(p);
  } catch (err) { /* 설정이 없으면 기본 폴더 */ }
  return ROOT;
}
const DATA_DIR = readDataFolder();
const NODE_DIR = path.join(DATA_DIR, '노드파일');
// 그래프 JSON은 노드파일 폴더 밖의 '내부데이터'에 둡니다. 원본은 노드 Markdown 파일이고, 이 JSON은 설정과 백업용 사본입니다.
const GRAPH_DIR = path.join(DATA_DIR, '내부데이터');
const GRAPH_FILE = path.join(GRAPH_DIR, '그래프.json');
const HISTORY_DIR = path.join(DATA_DIR, '변경이력');
// 이 프로그램이 만든 파일 이름 패턴: n1_제목.md, n12_제목.md, _경로.md
const OWN_FILE = /^(n\d+_.*|_경로)\.md$/;
const HISTORY_FILE = /^\d{8}T\d{6}Z_[a-z0-9-]+\.json$/;
// 파일 쓰기: 내용이 같으면 쓰지 않고(클라우드 동기화가 안 바뀐 파일을 다시 올리지 않게), 쓸 때는 임시 파일에 쓴 뒤 바꿔치기해서
// 중간에 끊겨도 파일이 반쯤 쓰인 채 남지 않게 합니다. 바꿔치기가 막히면(동기화 프로그램이 파일을 잡고 있을 때 등) 직접 씁니다.
function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file); }
  catch (err) { try { fs.unlinkSync(tmp); } catch (e) { /* 없으면 그대로 */ } fs.writeFileSync(file, text, 'utf8'); }
}
function writeIfChanged(file, text) {
  try { if (fs.readFileSync(file, 'utf8') === text) return false; } catch (err) { /* 없으면 새로 씁니다 */ }
  writeFileAtomic(file, text);
  return true;
}
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

  if (req.method === 'GET' && req.url === '/md-graph.js') {
    res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8'});
    fs.createReadStream(path.join(APP_DIR, 'md-graph.js')).pipe(res);
    return;
  }

  // 노드 파일 전체를 읽습니다. 그래프의 원본이므로 편집기는 시작할 때와 '파일 다시 읽기'에 이 목록을 씁니다.
  if (req.method === 'GET' && req.url === '/api/nodes') {
    try {
      fs.mkdirSync(NODE_DIR, {recursive: true});
      const files = fs.readdirSync(NODE_DIR)
        .filter(name => OWN_FILE.test(name) && fs.statSync(path.join(NODE_DIR, name)).isFile())
        .sort()
        .map(name => ({name, text: fs.readFileSync(path.join(NODE_DIR, name), 'utf8')}));
      return sendJson(res, 200, {ok: true, files});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }

  // 설정과 백업을 담은 보조 그래프 JSON. 없으면 data가 null입니다.
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/graph') {
    try {
      const data = fs.existsSync(GRAPH_FILE) ? JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8')) : null;
      return sendJson(res, 200, {ok: true, data});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }

  if (req.method === 'POST' && req.url === '/api/graph') {
    readBody(req).then(body => {
      const data = JSON.parse(body);
      if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('잘못된 그래프 데이터입니다.');
      fs.mkdirSync(GRAPH_DIR, {recursive: true});
      writeIfChanged(GRAPH_FILE, JSON.stringify(data, null, 2));
      sendJson(res, 200, {ok: true});
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
      writeFileAtomic(path.join(HISTORY_DIR, `${id}.json`), JSON.stringify(saved, null, 2));
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
        const {files} = JSON.parse(body);
        fs.mkdirSync(NODE_DIR, {recursive: true});

        const written = new Set();
        let changed = 0;
        for (const f of files) {
          const name = path.basename(String(f.name));   // 폴더 밖으로 나가지 못하게 경로 제거
          if (!OWN_FILE.test(name)) continue;
          if (writeIfChanged(path.join(NODE_DIR, name), String(f.text))) changed++;
          written.add(name);
        }

        // 삭제된 노드의 예전 파일 정리 (이 프로그램 파일 패턴에 맞는 것만)
        for (const old of fs.readdirSync(NODE_DIR)) {
          if (OWN_FILE.test(old) && !written.has(old)) fs.unlinkSync(path.join(NODE_DIR, old));
        }

        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify({ok: true, count: written.size, changed}));
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
        const {name: requestedName} = JSON.parse(body);
        const name = path.basename(String(requestedName));
        const full = path.join(NODE_DIR, name);
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

  // 폴더 고르기 창: 하위 폴더 목록 (path가 비어 있으면 드라이브 목록)
  if (req.method === 'GET' && req.url.startsWith('/api/folders')) {
    try {
      const requested = new URL(req.url, 'http://localhost').searchParams.get('path') || '';
      if (!requested) {
        const drives = [];
        for (let c = 67; c <= 90; c++) {   // C:~Z:
          const root = String.fromCharCode(c) + ':\\';
          if (fs.existsSync(root)) drives.push({name: root.slice(0, 2), path: root});
        }
        return sendJson(res, 200, {ok: true, current: '', parent: null, dirs: drives});
      }
      const full = path.resolve(requested);
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return sendJson(res, 400, {ok: false, error: '폴더를 찾지 못했습니다.'});
      const dirs = fs.readdirSync(full, {withFileTypes: true})
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({name: e.name, path: path.join(full, e.name)}))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      const up = path.dirname(full);
      return sendJson(res, 200, {ok: true, current: full, parent: up === full ? '' : up, dirs});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }

  // 데이터 폴더 설정 보기
  if (req.method === 'GET' && req.url === '/api/data-folder') {
    return sendJson(res, 200, {ok: true, active: DATA_DIR, default: ROOT});
  }

  // 데이터 폴더 설정 저장 (적용은 편집기를 다시 실행한 뒤)
  if (req.method === 'POST' && req.url === '/api/data-folder') {
    readBody(req).then(body => {
      const requested = String(JSON.parse(body).path || '').trim();
      if (!requested) {
        try { fs.unlinkSync(CONFIG_FILE); } catch (err) { /* 이미 없음 */ }
        return sendJson(res, 200, {ok: true, path: '', note: '프로젝트 폴더를 쓰도록 되돌렸습니다. 편집기를 다시 실행하면 적용됩니다.'});
      }
      const full = path.resolve(requested);
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return sendJson(res, 400, {ok: false, error: '폴더가 없습니다. 경로를 확인해 주세요.'});
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({path: full}, null, 2), 'utf8');
      sendJson(res, 200, {ok: true, path: full, note: '저장했습니다. 편집기를 다시 실행하면 이 폴더를 씁니다.'});
    }).catch(err => sendJson(res, 400, {ok: false, error: err.message}));
    return;
  }

  // 편집기 탭이 열려 있는 동안 계속 열어 두는 연결. 끊기면(탭 닫힘) 종료 타이머가 시작됩니다.
  if (req.method === 'GET' && req.url === '/api/alive-stream') {
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive'});
    res.write(': connected\n\n');
    openStreams++;
    const ping = setInterval(() => res.write(': ping\n\n'), 3000);   // 끊어진 연결을 빨리 알아채기 위한 주기적 쓰기
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true; clearInterval(ping); openStreams = Math.max(0, openStreams - 1); lastSeen = Date.now();
    };
    req.on('close', done); res.on('close', done); res.on('error', done);
    return;
  }

  // 예전 방식의 살아 있다는 신호(이미 열려 있던 옛 탭용), 그리고 이미 켜진 서버에 다시 붙을 때의 연장 요청(?grace=1)
  if (req.method === 'POST' && (req.url === '/api/alive' || req.url === '/api/alive?grace=1')) {
    lastSeen = req.url === '/api/alive' ? Date.now() : Math.max(lastSeen, graceTime());
    return sendJson(res, 200, {ok: true});
  }

  // 프로젝트 폴더 안의 JSON 파일 목록 (불러오기 창에서 사용)
  if (req.method === 'GET' && req.url === '/api/project-json') {
    const SKIP = new Set(['node_modules', '.venv', '변경이력', '노드파일', '내부데이터']);   // 내부 데이터와 변경이력은 목록에서 제외
    const found = [];
    try {
      (function walk(dir, depth) {
        if (depth > 3 || found.length >= 300) return;
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.name === 'data-folder.json') continue;
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

// 편집기 주소를 기본 브라우저로 엽니다. 서버가 준비된 뒤에만 부르므로, 서버가 없는 빈 페이지가 뜨는 일이 없습니다. (EDITOR_NO_OPEN=1이면 열지 않음: 시험용)
function openBrowser() {
  if (process.env.EDITOR_NO_OPEN) return;
  const url = `http://localhost:${PORT}`;
  try {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, {detached: true, stdio: 'ignore', windowsHide: true}).unref();
  } catch (e) { console.log('브라우저를 자동으로 열지 못했습니다. 직접 ' + url + ' 을 여세요.'); }
}

// 이미 실행 중인 편집기가 있으면 새 서버를 또 띄우지 않습니다.
// 기존 서버의 종료 타이머를 먼저 연장시킨 뒤 브라우저를 엽니다. (탭을 닫고 곧 종료되려던 서버에 붙는 일을 막기 위해)
function portBusy() {
  console.log('포트 ' + PORT + '을(를) 다른 프로그램이 쓰고 있습니다. 그 프로그램을 끈 뒤 다시 실행하세요.');
  process.exit(1);
}
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  const req = http.request({host: '127.0.0.1', port: PORT, path: '/api/alive?grace=1', method: 'POST', timeout: 3000}, res => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      let ok = false;
      try { ok = JSON.parse(body).ok === true; } catch (e) {}
      if (!ok) portBusy();
      console.log('이미 실행 중인 편집기에 연결합니다.');
      openBrowser();
      setTimeout(() => process.exit(0), 500);
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', portBusy);
  req.end();
});

// 이 PC에서만 접속 가능하도록 127.0.0.1에만 엽니다.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`인과 편집기 실행 중: http://localhost:${PORT}`);
  console.log('편집기 탭을 닫으면 잠시 뒤 이 창도 자동으로 꺼집니다.');
  setInterval(() => {
    if (openStreams === 0 && Date.now() - lastSeen > IDLE_MS) {
      console.log('편집기 탭이 닫혀 서버를 끕니다.');
      process.exit(0);
    }
  }, 1000);
  console.log(`프로그램 폴더: ${APP_DIR}`);
  console.log(`노드 파일 폴더: ${NODE_DIR}`);
  console.log(`변경 이력 폴더: ${HISTORY_DIR}`);
  console.log('이 창을 닫으면 편집기가 종료됩니다 (저장된 내용은 유지됩니다).');
  openBrowser();
});
