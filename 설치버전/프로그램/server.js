// 인과 편집기 도우미 서버 (설치버전)
// - 편집기 화면(index.html 등)을 http://localhost:8787 로 보여 줍니다. 파이어폭스, 크롬, 엣지 어디서든 열 수 있습니다.
// - 노드 Markdown 파일, 그래프 JSON, 변경 이력을 데이터 폴더의 '노드파일', '내부데이터', '변경이력'에 저장합니다.
// - 폴더는 없으면 자동으로 만듭니다. 외부 패키지 없이 Node.js 기본 모듈만 사용합니다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');

// 콘솔 출력을 server.log에도 남깁니다. 창 없이(숨김) 실행해도 상태와 오류를 볼 수 있습니다.
const LOG_FILE = path.join(__dirname, 'server.log');
try { if (fs.statSync(LOG_FILE).size > 204800) fs.unlinkSync(LOG_FILE); } catch (e) {}   // 200KB가 넘으면 새로 시작
const rawLog = console.log.bind(console);
console.log = (...args) => {
  rawLog(...args);
  try { fs.appendFileSync(LOG_FILE, new Date().toLocaleString('sv-SE') + ' ' + args.join(' ') + '\n'); } catch (e) {}
};
process.on('uncaughtException', err => { console.log('오류로 종료합니다: ' + (err && err.stack || err)); process.exit(1); });

const PORT = Number(process.env.EDITOR_PORT) || 8787;
// 편집기 탭은 열려 있는 동안 /api/alive-stream 연결을 계속 열어 둡니다. 탭을 닫으면 이 연결이 끊기고,
// 연결이 하나도 없는 상태로 IDLE_MS(5초)가 지나면 서버를 끕니다. (EDITOR_IDLE_MS, EDITOR_GRACE_MS는 시험용)
const IDLE_MS = Number(process.env.EDITOR_IDLE_MS) || 5000;
const GRACE_MS = Number(process.env.EDITOR_GRACE_MS) || 30000;   // 서버를 막 켰을 때 브라우저가 페이지를 열 시간
const graceTime = () => Date.now() + GRACE_MS - IDLE_MS;
let lastSeen = graceTime();
let openStreams = 0;

const APP_DIR = __dirname;
const ROOT = path.resolve(APP_DIR, '..');   // 기본 데이터 폴더: 설치버전 폴더
const CONFIG_FILE = path.join(APP_DIR, 'data-folder.json');
const OWN_FILE = /^(n\d+_.*|_경로)\.md$/;   // 이 프로그램이 만든 노드 파일: n1_제목.md, _경로.md
const HISTORY_FILE = /^\d{8}T\d{6}Z_[a-z0-9-]+\.json$/;

// 데이터 폴더. 설정에서 바꾸면 서버를 다시 켜지 않고 바로 적용합니다.
let DATA_DIR = readConfiguredFolder() || ROOT;
function readConfiguredFolder() {
  try {
    const p = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).path;
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) return path.resolve(p);
  } catch (err) { /* 설정이 없으면 기본 폴더 */ }
  return null;
}
const nodeDir = () => path.join(DATA_DIR, '노드파일');
const graphDir = () => path.join(DATA_DIR, '내부데이터');   // 그래프 JSON은 노드파일 밖에 둡니다. 원본은 노드 Markdown 파일입니다.
const graphFile = () => path.join(graphDir(), '그래프.json');
const historyDir = () => path.join(DATA_DIR, '변경이력');

// 파일 쓰기: 내용이 같으면 쓰지 않고, 쓸 때는 임시 파일에 쓴 뒤 바꿔치기해서 중간에 끊겨도 반쯤 쓰인 파일이 남지 않게 합니다.
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
const sendJson = (res, status, value) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value)); };
function readBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > maxBytes) { reject(new Error('요청이 너무 큽니다.')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
const listNodeFiles = dir => { try { return fs.readdirSync(dir).filter(n => OWN_FILE.test(n) && n !== '_경로.md' && fs.statSync(path.join(dir, n)).isFile()); } catch (e) { return []; } };

// 다른 웹사이트가 이 서버로 요청을 보내 파일을 바꾸지 못하게, 이 편집기에서 온 요청만 받습니다.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
function requestAllowed(req) {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return false;   // 도메인 바꿔치기(DNS rebinding) 방지
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) return false;
  return true;
}

// 폴더 고르기 창(Windows). 브라우저에는 폴더 경로를 알려 주는 기능이 없어서 서버가 PowerShell로 창을 띄웁니다.
let pickBusy = false;
function pickFolder() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('폴더 고르기 창은 Windows에서만 지원합니다. 폴더 경로를 직접 입력하세요.'));
    if (pickBusy) return reject(new Error('폴더 고르기 창이 이미 열려 있습니다.'));
    pickBusy = true;
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      '$o = New-Object System.Windows.Forms.Form; $o.TopMost = $true; $o.Opacity = 0; $o.ShowInTaskbar = $false; $o.Show(); $o.Activate()',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = '인과 편집기 데이터 폴더를 고르세요'",
      '$d.ShowNewFolderButton = $true',
      "if ($d.ShowDialog($o) -eq 'OK') { Write-Output $d.SelectedPath }",
      '$o.Close()'
    ].join('\n');
    const child = spawn('powershell', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {windowsHide: false});
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.on('error', e => { clearTimeout(timer); pickBusy = false; reject(e); });
    child.on('close', () => { clearTimeout(timer); pickBusy = false; resolve(out.trim()); });
  });
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/storage.js': ['storage.js', 'text/javascript; charset=utf-8'],
  '/md-graph.js': ['md-graph.js', 'text/javascript; charset=utf-8']
};

const server = http.createServer((req, res) => {
  if (!requestAllowed(req)) { res.writeHead(403); res.end('Forbidden'); return; }
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && STATIC[url]) {
    res.writeHead(200, {'Content-Type': STATIC[url][1], 'Cache-Control': 'no-store'});
    fs.createReadStream(path.join(APP_DIR, STATIC[url][0])).pipe(res);
    return;
  }

  // 노드 파일 전체를 읽습니다. 그래프의 원본입니다.
  if (req.method === 'GET' && url === '/api/nodes') {
    try {
      const dir = nodeDir();
      fs.mkdirSync(dir, {recursive: true});
      const files = fs.readdirSync(dir)
        .filter(name => OWN_FILE.test(name) && fs.statSync(path.join(dir, name)).isFile())
        .sort()
        .map(name => ({name, text: fs.readFileSync(path.join(dir, name), 'utf8')}));
      return sendJson(res, 200, {ok: true, files});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }

  // 노드 파일 저장: 바뀐 것만 쓰고, 이번 목록에 없는 이 프로그램의 예전 노드 파일은 지웁니다.
  if (req.method === 'POST' && url === '/api/nodes') {
    readBody(req).then(body => {
      const {files} = JSON.parse(body);
      if (!Array.isArray(files)) throw new Error('잘못된 요청입니다.');
      const dir = nodeDir();
      fs.mkdirSync(dir, {recursive: true});
      const written = new Set();
      let changed = 0;
      for (const f of files) {
        const name = path.basename(String(f.name));   // 폴더 밖으로 나가지 못하게 경로 제거
        if (!OWN_FILE.test(name)) continue;
        if (writeIfChanged(path.join(dir, name), String(f.text))) changed++;
        written.add(name);
      }
      for (const old of fs.readdirSync(dir)) {
        if (OWN_FILE.test(old) && !written.has(old)) fs.unlinkSync(path.join(dir, old));
      }
      sendJson(res, 200, {ok: true, count: written.size, changed});
    }).catch(err => sendJson(res, 400, {ok: false, error: err.message}));
    return;
  }

  // 설정과 백업을 담은 보조 그래프 JSON. 없으면 data가 null입니다.
  if (req.method === 'GET' && url === '/api/graph') {
    try {
      const data = fs.existsSync(graphFile()) ? JSON.parse(fs.readFileSync(graphFile(), 'utf8')) : null;
      return sendJson(res, 200, {ok: true, data});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }
  if (req.method === 'POST' && url === '/api/graph') {
    readBody(req).then(body => {
      const data = JSON.parse(body);
      if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('잘못된 그래프 데이터입니다.');
      fs.mkdirSync(graphDir(), {recursive: true});
      writeIfChanged(graphFile(), JSON.stringify(data, null, 2));
      sendJson(res, 200, {ok: true});
    }).catch(err => sendJson(res, 400, {ok: false, error: err.message}));
    return;
  }

  // 변경 이력
  if (req.method === 'GET' && url === '/api/versions') {
    try {
      const dir = historyDir();
      fs.mkdirSync(dir, {recursive: true});
      const entries = fs.readdirSync(dir).filter(name => HISTORY_FILE.test(name)).sort().reverse();
      return sendJson(res, 200, {ok: true, versions: entries.map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }
  if (req.method === 'POST' && url === '/api/versions') {
    readBody(req).then(body => {
      const item = JSON.parse(body);
      if (!item || !item.data || !Array.isArray(item.data.nodes) || !Array.isArray(item.data.edges) || typeof item.summary !== 'string') throw new Error('잘못된 버전 데이터입니다.');
      const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}_${Math.random().toString(36).slice(2, 8)}`;
      const saved = {id, at: new Date().toISOString(), summary: item.summary.slice(0, 160), data: item.data};
      fs.mkdirSync(historyDir(), {recursive: true});
      writeFileAtomic(path.join(historyDir(), `${id}.json`), JSON.stringify(saved, null, 2));
      sendJson(res, 200, {ok: true, version: saved});
    }).catch(err => sendJson(res, 400, {ok: false, error: err.message}));
    return;
  }
  const versionDelete = req.url.match(/^\/api\/versions\/(\d{8}T\d{6}Z_[a-z0-9-]+)$/);
  if (req.method === 'DELETE' && versionDelete) {
    const full = path.join(historyDir(), `${versionDelete[1]}.json`);
    try {
      if (!fs.existsSync(full)) return sendJson(res, 404, {ok: false, error: '버전을 찾지 못했습니다.'});
      fs.unlinkSync(full);
      return sendJson(res, 200, {ok: true});
    } catch (err) { return sendJson(res, 500, {ok: false, error: err.message}); }
  }

  // 데이터 폴더: 현재 폴더 보기 / 바꾸기 / 고르기 창 / 폴더 안 노드 파일 개수
  if (req.method === 'GET' && url === '/api/data-folder') {
    return sendJson(res, 200, {ok: true, active: DATA_DIR, default: ROOT, custom: DATA_DIR !== ROOT});
  }
  if (req.method === 'POST' && url === '/api/data-folder') {
    readBody(req).then(body => {
      const requested = String(JSON.parse(body).path || '').trim();
      if (!requested) {   // 기본 폴더로 되돌립니다
        try { fs.unlinkSync(CONFIG_FILE); } catch (err) { /* 이미 없음 */ }
        DATA_DIR = ROOT;
        return sendJson(res, 200, {ok: true, active: DATA_DIR, custom: false});
      }
      const full = path.resolve(requested);
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return sendJson(res, 400, {ok: false, error: '폴더가 없습니다. 경로를 확인해 주세요.'});
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({path: full}, null, 2), 'utf8');
      DATA_DIR = full;
      sendJson(res, 200, {ok: true, active: DATA_DIR, custom: DATA_DIR !== ROOT});
    }).catch(err => sendJson(res, 400, {ok: false, error: err.message}));
    return;
  }
  if (req.method === 'POST' && url === '/api/pick-folder') {
    console.log('폴더 고르기 창을 엽니다.');
    pickFolder()
      .then(p => { console.log('폴더 고르기 결과: ' + (p || '(취소)')); sendJson(res, 200, {ok: true, path: p || ''}); })
      .catch(err => { console.log('폴더 고르기 실패: ' + err.message); sendJson(res, 500, {ok: false, error: err.message}); });
    return;
  }
  if (req.method === 'GET' && url === '/api/folder-info') {
    const p = new URL(req.url, 'http://localhost').searchParams.get('path') || '';
    const full = path.resolve(p);
    if (!p || !fs.existsSync(full) || !fs.statSync(full).isDirectory()) return sendJson(res, 400, {ok: false, error: '폴더를 찾지 못했습니다.'});
    return sendJson(res, 200, {ok: true, nodeFiles: listNodeFiles(path.join(full, '노드파일')).length});
  }

  // 편집기 탭이 열려 있는 동안 계속 열어 두는 연결. 끊기면(탭 닫힘) 종료 타이머가 시작됩니다.
  if (req.method === 'GET' && url === '/api/alive-stream') {
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive'});
    res.write(': connected\n\n');
    openStreams++;
    const ping = setInterval(() => res.write(': ping\n\n'), 3000);
    let closed = false;
    const done = () => { if (closed) return; closed = true; clearInterval(ping); openStreams = Math.max(0, openStreams - 1); lastSeen = Date.now(); };
    req.on('close', done); res.on('close', done); res.on('error', done);
    return;
  }
  // 이미 켜진 서버에 다시 붙을 때의 종료 연장 요청
  if (req.method === 'POST' && req.url === '/api/alive?grace=1') {
    lastSeen = Math.max(lastSeen, graceTime());
    return sendJson(res, 200, {ok: true});
  }

  res.writeHead(404);
  res.end('Not found');
});

// 편집기 주소를 기본 브라우저로 엽니다. 서버가 준비된 뒤에만 부릅니다. (EDITOR_NO_OPEN=1이면 열지 않음: 시험용)
function openBrowser() {
  if (process.env.EDITOR_NO_OPEN) return;
  const url = `http://localhost:${PORT}`;
  try {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, {detached: true, stdio: 'ignore', windowsHide: true}).unref();
  } catch (e) { console.log('브라우저를 자동으로 열지 못했습니다. 직접 ' + url + ' 을 여세요.'); }
}

// 이미 실행 중인 편집기가 있으면 새 서버를 또 띄우지 않고, 기존 서버의 종료 타이머를 연장한 뒤 브라우저만 엽니다.
function portBusy() {
  console.log('포트 ' + PORT + '을(를) 다른 프로그램이 쓰고 있습니다. 그 프로그램을 끈 뒤 다시 실행하세요.');
  process.exit(1);
}
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  const req = http.request({host: '127.0.0.1', port: PORT, path: '/api/alive?grace=1', method: 'POST', timeout: 3000, headers: {Host: `127.0.0.1:${PORT}`}}, res => {
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
  console.log('편집기 탭을 닫으면 잠시 뒤 서버도 자동으로 꺼집니다.');
  setInterval(() => {
    if (openStreams === 0 && Date.now() - lastSeen > IDLE_MS) {
      console.log('편집기 탭이 닫혀 서버를 끕니다.');
      process.exit(0);
    }
  }, 1000);
  console.log(`프로그램 폴더: ${APP_DIR}`);
  console.log(`데이터 폴더: ${DATA_DIR}`);
  openBrowser();
});
