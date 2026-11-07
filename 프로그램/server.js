// 인과 편집기 도우미 서버
// - index.html을 http://localhost:8787 로 보여 줍니다.
// - 노드 Markdown 파일과 그래프 버전을 각각 '노드파일', '변경이력' 폴더에 저장합니다.
// - 폴더는 없으면 자동으로 만듭니다. 외부 패키지 없이 Node.js 기본 모듈만 사용합니다.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8787;
const APP_DIR = __dirname;
const ROOT = path.resolve(APP_DIR, '..');
const NODE_DIR = path.join(ROOT, '노드파일');
const HISTORY_DIR = path.join(ROOT, '변경이력');
// 이 프로그램이 만든 파일 이름 패턴: n1_제목.md, n12_제목.md, _경로.md
const OWN_FILE = /^(n\d+_.*|_경로)\.md$/;
const HISTORY_FILE = /^\d{8}T\d{6}Z_[a-z0-9-]+\.json$/;
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
        const {files} = JSON.parse(body);
        fs.mkdirSync(NODE_DIR, {recursive: true});

        const written = new Set();
        for (const f of files) {
          const name = path.basename(String(f.name));   // 폴더 밖으로 나가지 못하게 경로 제거
          if (!OWN_FILE.test(name)) continue;
          fs.writeFileSync(path.join(NODE_DIR, name), String(f.text), 'utf8');
          written.add(name);
        }

        // 삭제된 노드의 예전 파일 정리 (이 프로그램 파일 패턴에 맞는 것만)
        for (const old of fs.readdirSync(NODE_DIR)) {
          if (OWN_FILE.test(old) && !written.has(old)) fs.unlinkSync(path.join(NODE_DIR, old));
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
        const name = path.basename(String(JSON.parse(body).name));
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

  res.writeHead(404);
  res.end('Not found');
});

// 이 PC에서만 접속 가능하도록 127.0.0.1에만 엽니다.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`인과 편집기 실행 중: http://localhost:${PORT}`);
  console.log(`프로그램 폴더: ${APP_DIR}`);
  console.log(`노드 파일 폴더: ${NODE_DIR}`);
  console.log(`변경 이력 폴더: ${HISTORY_DIR}`);
  console.log('이 창을 닫으면 편집기가 종료됩니다 (저장된 내용은 유지됩니다).');
});
