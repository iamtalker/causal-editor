// 인과 편집기 도우미 서버
// - index.html을 http://localhost:8787 로 보여 줍니다.
// - 페이지가 보낸 노드 데이터를 받아 이 파일 옆의 '노드파일' 폴더에 .md 파일로 씁니다.
// - 폴더는 없으면 자동으로 만듭니다. 외부 패키지 없이 Node.js 기본 모듈만 사용합니다.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8787;
const ROOT = __dirname;
const NODE_DIR = path.join(ROOT, '노드파일');
// 이 프로그램이 만든 파일 이름 패턴: n1_제목.md, n12_제목.md, _경로.md
const OWN_FILE = /^(n\d+_.*|_경로)\.md$/;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
    return;
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
  console.log(`노드 파일 폴더: ${NODE_DIR}`);
  console.log('이 창을 닫으면 편집기가 종료됩니다 (저장된 내용은 유지됩니다).');
});
