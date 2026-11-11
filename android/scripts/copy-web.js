// 프로그램/index.html을 www/로 복사하고, 안드로이드용 파일 접근 어댑터(android-shim.js)를 끼워 넣습니다.
// PC용 프로그램/index.html은 바꾸지 않습니다.
const fs = require('fs');
const path = require('path');

const ANDROID_DIR = path.resolve(__dirname, '..');
const SRC_HTML = path.resolve(ANDROID_DIR, '..', '프로그램', 'index.html');
const WWW = path.join(ANDROID_DIR, 'www');
const NATIVE_SRC_DIR = path.join(ANDROID_DIR, 'native');
const NATIVE_DEST = path.join(ANDROID_DIR, 'android', 'app', 'src', 'main', 'java', 'com', 'causaleditor', 'app');

fs.mkdirSync(WWW, { recursive: true });
let html = fs.readFileSync(SRC_HTML, 'utf8');
if (!html.includes('android-shim.js')) {
  html = html.replace('<head>', '<head>\n<script src="android-shim.js"></script>\n<script src="android-update.js"></script>\n<script src="android-touch.js"></script>');
}
fs.writeFileSync(path.join(WWW, 'index.html'), html, 'utf8');
for (const name of ['android-shim.js', 'android-update.js', 'android-touch.js']) {
  fs.copyFileSync(path.join(ANDROID_DIR, 'web', name), path.join(WWW, name));
}
// 노드 Markdown <-> 그래프 변환기는 PC와 같은 파일을 씁니다 (index.html이 불러옵니다)
fs.copyFileSync(path.resolve(ANDROID_DIR, '..', '프로그램', 'md-graph.js'), path.join(WWW, 'md-graph.js'));
console.log('www/ 준비 완료');

if (fs.existsSync(path.join(ANDROID_DIR, 'android'))) {
  fs.mkdirSync(NATIVE_DEST, { recursive: true });
  for (const name of fs.readdirSync(NATIVE_SRC_DIR).filter(n => n.endsWith('.java'))) {
    fs.copyFileSync(path.join(NATIVE_SRC_DIR, name), path.join(NATIVE_DEST, name));
  }
  console.log('네이티브 플러그인 복사 완료');
}
