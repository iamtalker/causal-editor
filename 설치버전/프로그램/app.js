const KEY = 'causal-editor-v3';
const SIDEBAR_KEY = 'causal-editor-sidebar-hidden-v1';
const RECT = {w: 200, h: 110}, CIRCLE = {w: 130, h: 130};
const DEFAULT_SETTINGS = {shape:'rect', nodeColor:'#ffffff', bgColor:'#fafafa', lineStyle:'curve', arrowSize:14, lineWidth:1, allowMutualEdges:false, canvasPadding:400};
const NUMBER_CTRL = [['s_arrowSize','arrowSize',4,60],['s_lineWidth','lineWidth',0.5,10]];
const NODE_FIELDS = [['f_title','title'],['f_memo','memo']];
const NODE_STATUSES = {
  start: {label:'시작', color:'#f5b400'},
  not_started: {label:'미착수', color:'#9aa5b8'},
  in_progress: {label:'진행 중', color:'#3b82f6'},
  completed: {label:'완료', color:'#22c55e'},
  stopped: {label:'중단', color:'#ef4444'},
  failed: {label:'실패', color:'#d946ef'},
  end: {label:'종료', color:'#06b6d4'}
};
const DEFAULT_STATUS_COLORS = Object.fromEntries(Object.entries(NODE_STATUSES).map(([k, v]) => [k, v.color]));
// 설정에서 바꾼 상태 색(S.settings.statusColors)을 NODE_STATUSES에 반영합니다. 없거나 잘못된 값이면 기본 색입니다.
function applyStatusColors() {
  const custom = (S && S.settings && S.settings.statusColors) || {};
  for (const key of Object.keys(NODE_STATUSES)) {
    NODE_STATUSES[key].color = /^#[0-9a-fA-F]{6}$/.test(custom[key]) ? custom[key].toLowerCase() : DEFAULT_STATUS_COLORS[key];
  }
}
// 진행 상태에 따라 노드 안쪽을 상태 색으로 옅게 칠합니다. 미착수는 설정의 기본 노드 색을 씁니다.
const tintColor = (hex, a) => '#' + [1, 3, 5].map(i => Math.round(255 - (255 - parseInt(hex.slice(i, i + 2), 16)) * a).toString(16).padStart(2, '0')).join('');
const EDGE_FIELDS = [['e_memo','memo']];
const SELECT_CTRL = [['s_shape','shape'],['s_lineStyle','lineStyle']];
const COLOR_CTRL = ['nodeColor','bgColor'];   // 네이티브 색상 창 대신 입력칸 + 색 견본 방식
const PRESETS = {
  nodeColor: ['#ffffff','#f8fafc','#fef9c3','#dcfce7','#dbeafe','#fce7f3'],
  bgColor: ['#fafafa','#f4f5f7','#f5f0e6','#ffffff','#1e293b','#0f172a']
};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const trunc = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const titleLines = (s, maxChars, maxLines = 2) => {
  const chars = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()), lines = [];
  for (let i = 0; i < maxLines && chars.length; i++) {
    let line = chars.splice(0, maxChars).join('');
    if (i === maxLines - 1 && chars.length) line = Array.from(line).slice(0, -1).join('') + '…';
    lines.push(line);
  }
  return lines;
};
const today = () => new Date().toISOString().slice(0, 10);
const svg = $('#canvas');

let S, sel = {type: null, id: null}, drag = null, pan = null, pendingConnectionSource = null;
let focusMode = false, focusNodeId = null;
// 연결 모드: 처음 선택한 노드(connNodeId)를 중심으로 고정하고, 연결된 노드만 connDepth 단계까지 보여 줍니다(방향은 따지지 않습니다). 화면 설정이라 파일에는 저장하지 않습니다.
let connMode = false, connNodeId = null, connDepth = 1;
const connCreatedIds = new Set();
// 상태 보기: 선택한 상태가 아닌 노드와 그 화살표를 흐리게 표시합니다. 화면 보기 설정이라 파일에 저장하지 않습니다.
let statusFilter = 'all';
let compactView = false;
const isDimmedByStatus = n => statusFilter !== 'all' && n.status !== statusFilter;
let focusCreatedNodeIds = new Set(), focusCreatedEdgeIds = new Set();
let lastEditAt = 0;   // 마지막 편집 시각: 편집 직후에는 파일을 다시 읽지 않습니다
let mdReadFailed = false;   // 노드 md를 읽지 못한 상태: 이때는 파일과 JSON을 아무것도 쓰지 않습니다
const undoStack = [], redoStack = [];
let historyCurrent = null, historyGroup = null, historyGroupAt = 0;
const HISTORY_LIMIT = 100;
// 기본 확대율: 안드로이드 앱은 작은 화면에 맞게 shim에서 더 작은 값을 넣습니다. PC는 1입니다.
const BASE_ZOOM = window.CAUSAL_BASE_ZOOM || 1;
const FIT_MAX_ZOOM = window.CAUSAL_FIT_MAX_ZOOM || 2;
let zoom = BASE_ZOOM, lastCW = 800, lastCH = 600, viewMinX = 0, viewMinY = 0;   // 확대율과 뷰박스(저장하지 않음)
let VERSION_LIST = [];

/* ---------- 데이터 ----------
   노드 = 하나의 상태 (제목, 진행 상태, 메모, 위치)
   화살표 = 인과 (원인 노드 → 결과 노드, 메모)
   설정(settings)도 데이터와 함께 저장됩니다. */
function initial() {
  return {nextId: 1, nodes: [], edges: [], settings: {...DEFAULT_SETTINGS}};
}
function ensureSettings() { S.settings = Object.assign({}, DEFAULT_SETTINGS, S.settings || {}); if (!S.settings.statusColors || typeof S.settings.statusColors !== 'object') S.settings.statusColors = {}; delete S.settings.selectionColor; delete S.settings.highlightColor; delete S.settings.lineColor; }
function load() { try { const v = localStorage.getItem(KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function snapshotGraph() { return JSON.stringify(S); }
function updateHistoryButtons() {
  $('#btnUndo').disabled = undoStack.length === 0;
  $('#btnRedo').disabled = redoStack.length === 0;
}
function resetHistory() {
  undoStack.length = 0; redoStack.length = 0;
  historyCurrent = snapshotGraph(); historyGroup = null; historyGroupAt = 0;
  updateHistoryButtons();
}
function recordHistory(group = null) {
  const next = snapshotGraph();
  if (historyCurrent === null) { historyCurrent = next; updateHistoryButtons(); return; }
  if (next === historyCurrent) return;
  const now = Date.now();
  if (!group || group !== historyGroup || now - historyGroupAt > 900) {
    undoStack.push(historyCurrent);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  }
  historyCurrent = next; historyGroup = group; historyGroupAt = now;
  redoStack.length = 0; updateHistoryButtons();
}
async function restoreHistory(snapshot) {
  S = JSON.parse(snapshot);
  prepareState();
  sel = {type:null, id:null};
  focusMode = false; focusNodeId = null;
  focusCreatedNodeIds.clear(); focusCreatedEdgeIds.clear();
  $('#btnFocus').textContent = '흐름 모드';
  $('#btnFocus').setAttribute('aria-pressed', 'false');
  resetConnMode();
  historyCurrent = snapshotGraph(); historyGroup = null;
  await persistNow();
  render(); renderPanel(); renderSettings(); fitView(); updateHistoryButtons();
}
async function undo() {
  if (!undoStack.length) return;
  redoStack.push(historyCurrent);
  const previous = undoStack.pop();
  await restoreHistory(previous);
}
async function redo() {
  if (!redoStack.length) return;
  undoStack.push(historyCurrent);
  const next = redoStack.pop();
  await restoreHistory(next);
}
/* ---------- 저장 ----------
   원본은 노드 md 파일(syncNodeFiles)입니다. 내부데이터/그래프.json(persistGraph)은 설정과 백업용 사본입니다.
   브라우저(localStorage)에는 설정만 보관합니다(cacheSettings). 그래프 내용은 브라우저에 복사하지 않습니다.
   편집하면 save()가 설정을 바로 캐시하고, 400ms 뒤 persistNow()가 md → JSON 순서로 한 번에 저장합니다. */
function cacheSettings() { try { localStorage.setItem(KEY, JSON.stringify({settings: S.settings})); } catch (e) {} }
let persistTimer = null, persistChain = Promise.resolve(), persistBusy = 0;
function schedulePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(persistNow, 400); }
// 저장은 항상 순서대로 한 번에 하나씩 실행하고, 실행 시점의 최신 그래프를 저장합니다.
function persistNow() {
  clearTimeout(persistTimer); persistTimer = null;
  persistChain = persistChain.then(doPersist, doPersist);
  return persistChain;
}
async function doPersist() {
  persistBusy++;
  try {
    cacheSettings();
    await syncNodeFiles();
    await persistGraph(S);
  } finally { persistBusy--; }
}
// 탭을 닫거나 숨길 때, 아직 저장 전인 편집이 있으면 노드 파일을 바로 저장합니다.
window.addEventListener('pagehide', () => {
  if (persistTimer === null) return;
  clearTimeout(persistTimer); persistTimer = null;
  syncNodeFiles();
});
function save(historyGroupKey = null) {
  lastEditAt = Date.now();
  recordHistory(historyGroupKey);
  cacheSettings();
  schedulePersist();
}
async function persistGraph(data) {
  if (mdReadFailed) return true;   // md를 못 읽은 상태에서는 JSON 사본도 덮어쓰지 않습니다
  try {
    await Store.writeGraph(data);
    return true;
  } catch (err) { setFstat(`그래프 JSON 저장 실패: ${err.message}`); return false; }
}
function versions() { return VERSION_LIST; }
const postVersion = item => Store.addVersion(item);
async function loadVersions() { VERSION_LIST = await Store.listVersions(); }
async function createVersion(summary, data = S, force = false) {
  const snapshot = JSON.parse(JSON.stringify(data));
  if (!force && VERSION_LIST.length && JSON.stringify(VERSION_LIST[0].data) === JSON.stringify(snapshot)) return true;
  try {
    const item = await postVersion({summary:summary.trim(), data:snapshot});
    VERSION_LIST.unshift(item);
    if ($('#versionDlg').open) renderVersions();
    return true;
  } catch (e) { setFstat(`변경 이력 저장 실패: ${e.message}`); return false; }
}
function renderVersions() {
  const list = versions(), box = $('#versionList');
  if (!list.length) { box.innerHTML = '<p>아직 저장된 버전이 없습니다.</p>'; return; }
  const toolbar = `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding-bottom:8px"><label><input type="checkbox" id="verPickAll"> 전체 선택</label><button id="btnDeleteSelectedVersions" type="button">선택 삭제</button></div>`;
  box.innerHTML = toolbar + list.map(v => `<div style="border-top:1px solid #ddd;padding:10px 0;display:flex;gap:8px;align-items:flex-start"><input type="checkbox" class="ver-pick" data-version-pick="${esc(v.id)}" style="margin-top:4px"><div><b>${esc(new Date(v.at).toLocaleString())}</b><br>${esc(v.summary)}<br><span style="font-size:12px;color:#777">노드 ${v.data?.nodes?.length || 0}개 · 화살표 ${v.data?.edges?.length || 0}개</span><br><button data-version-open="${esc(v.id)}">JSON 내려받기</button> <button data-version-restore="${esc(v.id)}">이 버전 복원</button> <button data-version-delete="${esc(v.id)}">삭제</button></div></div>`).join('');
}
async function deleteVersionsBulk(ids) {
  if (!ids.length) { alert('삭제할 버전을 체크하세요.'); return; }
  if (!confirm(`체크한 버전 ${ids.length}개를 삭제할까요? 삭제한 버전 파일은 복구할 수 없습니다.`)) return;
  let failed = 0;
  for (const id of ids) {
    try {
      await Store.deleteVersion(id);
      VERSION_LIST = VERSION_LIST.filter(item => item.id !== id);
    } catch (err) { failed++; }
  }
  renderVersions();
  setFstat(`버전 ${ids.length - failed}개를 삭제했습니다${failed ? ` (실패 ${failed}개)` : ''}.`);
}

/* 노드 파일(.md)이 그래프의 원본입니다. 시작할 때와 '파일 다시 읽기'를 누를 때 파일에서 그래프를 만듭니다.
   그래프 JSON(내부데이터/그래프.json)은 설정과 백업을 담는 보조 사본입니다. */
const fetchNodeFiles = () => Store.readNodes();
const fetchBackupGraph = () => Store.readGraph();   // {data}  (파일이 없으면 data는 null)
// 파일 내용만 비교합니다 (반올림한 위치 기준). 같으면 다시 그리지 않습니다.
const graphSnapshot = g => JSON.stringify([
  g.nodes.map(n => [n.id, n.status, n.title, Math.round(n.x), Math.round(n.y), n.memo]),
  g.edges.map(e => [e.from, e.to, e.memo])
]);

async function loadSavedGraph(localData) {
  // 그래프의 원본은 노드 md 파일입니다. JSON은 설정을 가져올 때만 쓰고, 내용으로는 쓰지 않습니다.
  let files = null, loadError = null, backup = null;
  try { files = await fetchNodeFiles(); } catch (err) { loadError = err; }
  let j = null;
  try { j = await fetchBackupGraph(); } catch (err) { j = null; }   // JSON을 못 읽어도 md로 엽니다
  backup = j && j.data && Array.isArray(j.data.nodes) ? j.data : null;
  const settingsFrom = backup || localData || null;

  if (loadError) {
    // md를 읽지 못하면 JSON으로 그래프를 대신하지 않습니다. 빈 화면으로 열고, 파일을 읽기 전까지는 아무것도 저장하지 않습니다.
    mdReadFailed = true;
    S = {...initial(), settings: settingsFrom?.settings || {...DEFAULT_SETTINGS}};
    S.edges = S.edges || []; S.nextId = S.nextId || 1;
    prepareState(); resetHistory();
    render(); renderPanel(); renderSettings(); fitView();
    setFstat(`노드 파일을 읽지 못했습니다. 파일 상태를 확인한 뒤 '파일 다시 읽기'를 누르세요: ${loadError.message}`);
    return;
  }
  mdReadFailed = false;

  if (files.length) {
    const g = NodeMd.parseNodeFiles(files);
    S = {nextId: 1, nodes: g.nodes, edges: g.edges, settings: settingsFrom?.settings || {}};
  } else {
    S = {...initial(), settings: settingsFrom?.settings || {...DEFAULT_SETTINGS}};
  }
  S.edges = S.edges || []; S.nextId = S.nextId || 1;
  prepareState();
  resetHistory();
  await persistNow();
  render(); renderPanel(); renderSettings(); fitView();
}

// 파일을 다시 읽어 화면을 맞춥니다. 편집 직후나 드래그 중에는 건너뜁니다.
async function reloadFromNodeFiles(manual = false) {
  // 저장 대기·진행 중에 읽으면 방금 고친 내용을 덜 쓴 파일로 덮어쓸 수 있어서 건너뜁니다
  if (drag || pan || persistTimer !== null || persistBusy > 0 || Date.now() - lastEditAt < 1500) return;
  let files;
  try { files = await fetchNodeFiles(); }
  catch (err) { if (manual) setFstat(`파일 다시 읽기 실패: ${err.message}`); return; }
  mdReadFailed = false;   // 파일을 읽었으니 저장을 다시 허용합니다
  // 파일이 하나도 없으면: 자동 읽기에서는 그대로 둡니다(동기화 중일 수 있음). 직접 누른 경우에만 확인 후 화면을 비웁니다.
  if (!files.length) {
    if (!manual) return;
    if (!S.nodes.length) { setFstat('노드 파일이 없습니다. 화면도 비어 있습니다.'); return; }
    if (!confirm('노드 파일이 하나도 없습니다. 화면의 노드도 모두 지울까요?\n노드 파일이 원본이므로 파일이 없는 상태가 그대로 반영됩니다.')) {
      setFstat('노드 파일이 없지만 화면은 그대로 두었습니다.');
      return;
    }
  }
  const g = files.length ? NodeMd.parseNodeFiles(files) : {nodes: [], edges: []};
  if (graphSnapshot(g) === graphSnapshot(S)) { if (manual) setFstat('노드 파일이 바뀌지 않았습니다.'); return; }
  S = {...S, nodes: g.nodes, edges: g.edges};
  prepareState();
  resetHistory();
  sel = {type: null, id: null};
  focusMode = false; focusNodeId = null;
  focusCreatedNodeIds.clear(); focusCreatedEdgeIds.clear();
  $('#btnFocus').textContent = '흐름 모드';
  $('#btnFocus').setAttribute('aria-pressed', 'false');
  resetConnMode();
  await persistGraph(S);
  render(); renderPanel();
  setFstat(`노드 파일에서 다시 읽었습니다 (노드 ${g.nodes.length}개, 화살표 ${g.edges.length}개)`);
}
$('#btnReload').onclick = () => reloadFromNodeFiles(true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reloadFromNodeFiles(false); });

async function applyGraph(data) {
  S = JSON.parse(JSON.stringify(data));
  S.edges = S.edges || []; S.nextId = S.nextId || 1;
  prepareState();
  resetHistory();
  focusMode = false; focusNodeId = null;
  focusCreatedNodeIds.clear(); focusCreatedEdgeIds.clear();
  $('#btnFocus').textContent = '흐름 모드';
  $('#btnFocus').setAttribute('aria-pressed', 'false');
  resetConnMode();
  await persistNow();
  select(null, null); renderSettings(); fitView();
}
// id로 노드·화살표를 찾습니다. 그릴 때마다 수백~수천 번 부르므로 목록을 훑지 않고 id 표를 씁니다.
// 표는 목록(배열)이 바뀌거나 개수가 달라질 때만 다시 만듭니다. 노드·화살표를 더하고 빼는 코드는 모두 새 배열을 만들거나 개수를 바꿉니다.
const idIndexes = {nodes: {arr: null, len: -1, map: null}, edges: {arr: null, len: -1, map: null}};
function lookup(kind, arr, id) {
  const c = idIndexes[kind];
  if (c.arr !== arr || c.len !== arr.length) {
    c.arr = arr; c.len = arr.length; c.map = new Map();
    for (const x of arr) if (!c.map.has(x.id)) c.map.set(x.id, x);   // 같은 id가 있으면 먼저 나온 것 (find와 같은 결과)
  }
  return c.map.get(id);
}
const node = id => lookup('nodes', S.nodes, id);
const edge = id => lookup('edges', S.edges, id);
function normalizeNodeStatuses() {
  for (const n of S.nodes || []) {
    if (!NODE_STATUSES[n.status]) n.status = 'not_started';
    delete n.checked;
    delete n.now;
    delete n.kind;
  }
  for (const e of S.edges || []) {
    if (e.label) e.memo = [e.memo, e.label].filter(Boolean).join(' / ');
    delete e.label;
  }
}
// 불러온 그래프(JSON, 버전 파일)가 사람 손을 거쳤거나 깨져 있어도 화면이 멈추지 않게 값을 고칩니다.
// 같은 id의 중복 노드·화살표는 먼저 것만 남기고, 없는 노드를 가리키는 화살표와 숫자가 아닌 위치는 바로잡습니다.
function sanitizeGraph() {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const seen = new Set();
  S.nodes = (Array.isArray(S.nodes) ? S.nodes : []).filter(n => {
    if (!n || n.id == null || n.id === '') return false;
    n.id = String(n.id);
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    n.title = String(n.title ?? ''); n.memo = String(n.memo ?? '');
    n.x = num(n.x, 60); n.y = num(n.y, 60);
    return true;
  });
  const eseen = new Set();
  S.edges = (Array.isArray(S.edges) ? S.edges : []).filter(e => {
    if (!e || e.from == null || e.to == null) return false;
    e.from = String(e.from); e.to = String(e.to);
    if (!seen.has(e.from) || !seen.has(e.to)) return false;
    if (e.id == null || e.id === '' || eseen.has(String(e.id))) e.id = `e_${e.from}_${e.to}_${eseen.size}`;
    e.id = String(e.id);
    if (eseen.has(e.id)) return false;
    eseen.add(e.id);
    e.memo = String(e.memo ?? '');
    return true;
  });
}
// 시작·종료는 화살표가 아니라 진행 상태(시작/종료)로 직접 정합니다.
// 불러온 그래프를 쓰기 전에 상태값과 설정을 보정합니다 (불러오는 모든 경로에서 같은 순서로 호출).
function prepareState() { sanitizeGraph(); normalizeNodeStatuses(); ensureSettings(); }
function nodeKind(n) {
  if (n.status === 'start') return 'start';
  if (n.status === 'end') return 'goal';
  return 'normal';
}
const startNodes = () => S.nodes.filter(n => nodeKind(n) === 'start');
const goalNodes = () => S.nodes.filter(n => nodeKind(n) === 'goal');
// 간편 보기: 제목 한 줄만 있는 작은 상자로 그립니다. 화면 설정이라 파일에 저장하지 않습니다.
const COMPACT = {w: 170, h: 34};
const dims = () => compactView ? COMPACT : S.settings.shape === 'circle' ? CIRCLE : RECT;
const pushTo = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };

function reach(starts, adj) {
  const seen = new Set(starts), q = [...starts];
  while (q.length) {
    const u = q.shift();
    for (const v of adj.get(u) || []) if (!seen.has(v)) { seen.add(v); q.push(v); }
  }
  return seen;
}

function analyze() {
  const starts = startNodes(), goals = goalNodes();
  if (!starts.length || !goals.length) return {onNode: () => false, onEdge: () => false};
  const fwd = new Map(), rev = new Map();
  for (const e of S.edges) { pushTo(fwd, e.from, e.to); pushTo(rev, e.to, e.from); }
  const fromStart = reach(starts.map(n => n.id), fwd);
  const toGoal = reach(goals.map(n => n.id), rev);
  return {onNode: id => fromStart.has(id) && toGoal.has(id), onEdge: e => fromStart.has(e.from) && toGoal.has(e.to)};
}

/* ---------- 렌더링 ---------- */
// 화면에 보이는 노드·화살표 범위. 흐름 모드이면 흐름 경로와 새로 만든 항목만 보입니다.
// render()와 흐름 모드 안에서의 자동 배열이 같이 씁니다.
const connActive = () => connMode && connNodeId && !!node(connNodeId);
function visibleSets() {
  const visibleNodeIds = new Set(S.nodes.map(n => n.id));
  const visibleEdgeIds = new Set(S.edges.map(e => e.id));
  const focusPathEdgeIds = new Set();
  if (focusMode && focusNodeId) {
    visibleNodeIds.clear();
    visibleEdgeIds.clear();
    visibleNodeIds.add(focusNodeId);
    const outEdges = new Map();   // 노드 -> 나가는 화살표 (노드마다 전체 화살표를 훑지 않으려고 미리 모읍니다)
    for (const e of S.edges) pushTo(outEdges, e.from, e);
    const queue = [focusNodeId];
    for (let i = 0; i < queue.length; i++) {
      const currentId = queue[i];
      for (const e of outEdges.get(currentId) || []) {
        visibleEdgeIds.add(e.id);
        focusPathEdgeIds.add(e.id);
        if (!visibleNodeIds.has(e.to)) {
          visibleNodeIds.add(e.to);
          queue.push(e.to);
        }
      }
    }
    if (sel.type === 'node' && node(sel.id)) visibleNodeIds.add(sel.id);
    for (const id of focusCreatedNodeIds) if (node(id)) visibleNodeIds.add(id);
    for (const id of focusCreatedEdgeIds) {
      const e = edge(id);
      if (e && visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to)) visibleEdgeIds.add(id);
    }
  } else if (connActive()) {
    visibleNodeIds.clear();
    visibleEdgeIds.clear();
    const around = new Map();   // 노드 -> 이웃 노드 (원인·결과 모두)
    for (const e of S.edges) { pushTo(around, e.from, e.to); pushTo(around, e.to, e.from); }
    const dist = new Map([[connNodeId, 0]]), queue = [connNodeId];
    for (let i = 0; i < queue.length; i++) {
      const u = queue[i], d = dist.get(u);
      if (d >= connDepth) continue;
      for (const v of around.get(u) || []) {
        if (dist.has(v) || !node(v)) continue;
        dist.set(v, d + 1);
        queue.push(v);
      }
    }
    for (const id of dist.keys()) visibleNodeIds.add(id);
    for (const id of connCreatedIds) if (node(id)) visibleNodeIds.add(id);   // 연결 모드 중 새로 만든 노드는 계속 보입니다
    for (const e of S.edges) if (visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to)) visibleEdgeIds.add(e.id);
  }
  return {visibleNodeIds, visibleEdgeIds, focusPathEdgeIds};
}

function render() {
  const g = analyze(), st = S.settings, D = dims(), W = D.w, H = D.h;
  if (focusNodeId && !node(focusNodeId)) focusNodeId = null;
  applyStatusColors();
  const {visibleNodeIds, visibleEdgeIds, focusPathEdgeIds} = visibleSets();
  $('#stage').style.background = st.bgColor;
  const EDGE_HOT = '#111827';   // 선택한 노드에 연결된 선을 강조하는 검정
  const markerColors = new Set([...Object.values(NODE_STATUSES).map(status => status.color), EDGE_HOT]);
  const arrowPx = Math.max(4, Number(st.arrowSize) || 14), linePx = Math.max(0.5, Number(st.lineWidth) || 1);
  const markerAttrs = `viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="${arrowPx}" markerHeight="${arrowPx}" orient="auto-start-reverse"`;
  let h = `<defs>${[...markerColors].map(color => `<marker id="arr-${color.slice(1)}" ${markerAttrs}><path d="M0,0L10,5L0,10z" fill="${color}"/></marker>`).join('')}</defs>`;

  const focusOffsets = new Map();
  if (focusMode && focusNodeId) {
    const focusedEdges = S.edges.filter(e => visibleEdgeIds.has(e.id));
    const outBy = new Map(), inBy = new Map();   // 노드마다 전체를 훑지 않고 한 번에 나눕니다
    for (const e of focusedEdges) { pushTo(outBy, e.from, e); pushTo(inBy, e.to, e); }
    for (const n of S.nodes) {
      const outgoing = outBy.get(n.id) || [];
      const incoming = inBy.get(n.id) || [];
      const assignOffsets = (edges, key) => edges.forEach((e, i) => {
        const spacing = Math.min(14, 70 / Math.max(1, edges.length - 1));
        const offset = (i - (edges.length - 1) / 2) * spacing;
        const current = focusOffsets.get(e.id) || {start: 0, end: 0};
        current[key] = offset;
        focusOffsets.set(e.id, current);
      });
      assignOffsets(outgoing, 'start');
      assignOffsets(incoming, 'end');
    }
  }

  let hotOut = '';
  for (const e of S.edges) {
    if (!visibleEdgeIds.has(e.id)) continue;
    let out = '';
    const a = node(e.from), b = node(e.to);
    if (!a || !b) continue;   // 없는 노드를 가리키는 화살표 때문에 화면 전체가 멈추지 않게 건너뜁니다
    // 선택한 노드에 들어오거나 나가는 선은 검정으로 강조하고, 다른 선 위에 그립니다
    const hot = sel.type === 'node' && (e.from === sel.id || e.to === sel.id);
    const edgeDim = isDimmedByStatus(a) || isDimmedByStatus(b);
    out += `<g opacity="${edgeDim ? 0.2 : 1}">`;
    const forward = a.x + W / 2 <= b.x + W / 2;
    const x1 = forward ? a.x + W : a.x, x2 = forward ? b.x : b.x + W;
    const offsets = focusOffsets.get(e.id) || {start: 0, end: 0};
    const y1 = a.y + H / 2 + offsets.start, y2 = b.y + H / 2 + offsets.end;
    let d;
    if (st.lineStyle === 'straight') {
      d = `M${x1},${y1} L${x2},${y2}`;
    } else {
      const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
      d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    }
    const aStatus = NODE_STATUSES[a.status] || NODE_STATUSES.not_started;
    const bStatus = NODE_STATUSES[b.status] || NODE_STATUSES.not_started;
    const sameStatus = a.status === b.status;
    const color = hot ? EDGE_HOT : sameStatus ? aStatus.color : bStatus.color;
    const stroke = (hot || sameStatus) ? color : `url(#grad-${esc(e.id)})`;
    const w = hot ? linePx + 1 : linePx;
    if (!sameStatus && !hot) out += `<defs><linearGradient id="grad-${esc(e.id)}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0%" stop-color="${aStatus.color}"/><stop offset="50%" stop-color="${aStatus.color}"/><stop offset="50%" stop-color="${bStatus.color}"/><stop offset="100%" stop-color="${bStatus.color}"/></linearGradient></defs>`;
    out += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" marker-end="url(#arr-${color.slice(1)})"/>`;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 8;
    const edgeMemoSummary = e.memo ? titleLines(e.memo, 14, 1)[0] : '';
    if (edgeMemoSummary && !compactView) out += `<text x="${mx}" y="${my}" font-size="11" fill="#4b5563" text-anchor="middle" paint-order="stroke" stroke="${st.bgColor}" stroke-width="4" pointer-events="none"><title>${esc(e.memo)}</title>${esc(edgeMemoSummary)}</text>`;
    out += `<path d="${d}" fill="none" stroke="transparent" stroke-width="14" data-edge="${esc(e.id)}" style="cursor:pointer"/></g>`;
    if (hot) hotOut += out; else h += out;
  }
  h += hotOut;

  for (const n of S.nodes) {
    if (!visibleNodeIds.has(n.id)) continue;
    const isSel = sel.type === 'node' && sel.id === n.id;
    const status = NODE_STATUSES[n.status] || NODE_STATUSES.not_started;
    const fill = (NODE_STATUSES[n.status] && n.status !== 'not_started') ? tintColor(status.color, 0.12) : st.nodeColor;
    const stroke = isSel ? '#1a1d21' : status.color;
    const sw = isSel ? 2.5 : 1.5;
    let body;
    const titleRows = titleLines(n.title, st.shape === 'circle' ? 8 : 12);
    const memoRows = n.memo ? titleLines(n.memo, st.shape === 'circle' ? 8 : 16, 1) : [];
    const memoSummary = memoRows[0] || '';
    if (compactView) {
      body = `<rect width="${W}" height="${H}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
        <text x="10" y="${H / 2 + 4.5}" font-size="12" font-weight="600" fill="#1a1d21"><title>${esc(n.title || '')}</title>${esc(titleLines(n.title, 20, 1)[0] || '')}</text>`;
    } else if (st.shape === 'circle') {
      body = `<circle cx="${W / 2}" cy="${H / 2}" r="${W / 2 - 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
        <text x="${W / 2}" y="${H / 2 - (titleRows.length > 1 ? 15 : 7)}" font-size="13" font-weight="600" fill="#1a1d21" text-anchor="middle">${titleRows.map((line, i) => `<tspan x="${W / 2}" dy="${i ? 15 : 0}">${esc(line)}</tspan>`).join('')}</text>
        ${memoSummary ? `<text x="${W / 2}" y="${H / 2 + 15}" font-size="10" fill="#6b7280" text-anchor="middle"><title>${esc(n.memo)}</title>${esc(memoSummary)}</text>` : ''}
        <text x="${W / 2}" y="${H / 2 + 34}" font-size="10" font-weight="600" fill="${status.color}" text-anchor="middle">${status.label}</text>`;
    } else {
      body = `<rect width="${W}" height="${H}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
        <text x="12" y="24" font-size="14" font-weight="600" fill="#1a1d21">${titleRows.map((line, i) => `<tspan x="12" dy="${i ? 17 : 0}">${esc(line)}</tspan>`).join('')}</text>
        ${memoSummary ? `<text x="12" y="58" font-size="11" fill="#6b7280"><title>${esc(n.memo)}</title>${esc(memoSummary)}</text>` : ''}
        <circle cx="16" cy="88" r="3.5" fill="${status.color}"/>
        <text x="26" y="92" font-size="11" fill="#6b7280">${status.label}</text>`;
    }
    h += `<g data-node="${esc(n.id)}" transform="translate(${n.x},${n.y})" style="cursor:move" opacity="${isDimmedByStatus(n) ? 0.25 : 1}">${body}</g>`;
  }
  // 캔버스 크기: 노드가 모두 들어갈 만큼 키우고, 확대/축소 비율을 적용
  const padding = Math.max(0, Math.min(1000, Number(st.canvasPadding) || 0));
  const minNodeX = Math.min(0, ...S.nodes.map(n => n.x)), minNodeY = Math.min(0, ...S.nodes.map(n => n.y));
  const maxNodeX = Math.max(800, ...S.nodes.map(n => n.x + W + 40)), maxNodeY = Math.max(600, ...S.nodes.map(n => n.y + H + 40));
  const hadView = !!svg.getAttribute('viewBox');
  const prevMinX = viewMinX, prevMinY = viewMinY;
  viewMinX = minNodeX - padding; viewMinY = minNodeY - padding;
  lastCW = Math.max(800, maxNodeX - minNodeX + padding * 2);
  lastCH = Math.max(600, maxNodeY - minNodeY + padding * 2);
  svg.setAttribute('viewBox', `${viewMinX} ${viewMinY} ${lastCW} ${lastCH}`);
  svg.setAttribute('width', lastCW * zoom);
  svg.setAttribute('height', lastCH * zoom);
  svg.innerHTML = h;
  // 왼쪽·위로 캔버스가 넓어지면 화면에 보이던 내용이 밀리지 않도록 스크롤 위치를 보정합니다
  if (hadView) {
    const stageEl = $('#stage');
    stageEl.scrollLeft += (prevMinX - viewMinX) * zoom;
    stageEl.scrollTop += (prevMinY - viewMinY) * zoom;
  }

  // 화면 상단 안내: 노드가 하나도 없을 때만 표시
  const tip = $('#tip');
  tip.hidden = S.nodes.length > 0;
  tip.textContent = '노드가 없습니다. 빈 곳을 더블클릭해서 노드를 만드세요. 노드를 선택한 뒤 Shift 키를 누른 채 다른 노드를 클릭하면 화살표가 연결됩니다.';
}

function renderPanel() {
  const n = sel.type === 'node' ? node(sel.id) : null;
  const e = sel.type === 'edge' ? edge(sel.id) : null;
  $('#help').hidden = !!(n || e);
  $('#nodeForm').hidden = !n;
  $('#edgeBox').hidden = !e;
  if (n) {
    for (const [id, key] of NODE_FIELDS) $('#' + id).value = n[key] ?? '';
    $('#f_status').value = n.status || 'not_started';
  }
  if (e) {
    $('#edgeText').textContent = `${node(e.from).title} → ${node(e.to).title}`;
    for (const [id, key] of EDGE_FIELDS) $('#' + id).value = e[key] ?? '';
  }
}

function setSidebarVisible(visible, persist = false) {
  $('aside').hidden = !visible;
  $('#sidebarResizer').hidden = !visible;
  $('#btnSidebar').textContent = visible ? '사이드바 숨기기' : '사이드바 보이기';
  $('#btnSidebar').setAttribute('aria-pressed', String(visible));
  if (persist) {
    try { localStorage.setItem(SIDEBAR_KEY, visible ? '0' : '1'); } catch (e) {}
  }
}

const SIDEBAR_WIDTH_KEY = 'causal-editor-sidebar-width-v1';
const SIDEBAR_MIN_WIDTH = 200;
function clampSidebarWidth(w) {
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.floor(window.innerWidth * 0.6));
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)));
}
function applySidebarWidth(w) {
  const v = clampSidebarWidth(w), aside = $('aside');
  aside.style.width = v + 'px';
  aside.style.flexBasis = v + 'px';
  return v;
}
function loadSidebarWidth() {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (saved > 0) applySidebarWidth(saved);
  } catch (e) {}
}
(function setupSidebarResizer() {
  const rz = $('#sidebarResizer');
  let finalWidth = null;
  rz.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('dragging');
    document.body.style.userSelect = 'none';
    finalWidth = null;
  });
  rz.addEventListener('pointermove', e => {
    if (!rz.classList.contains('dragging')) return;
    const mainRight = $('main').getBoundingClientRect().right;
    finalWidth = applySidebarWidth(mainRight - e.clientX - rz.offsetWidth / 2);
  });
  const endDrag = () => {
    if (!rz.classList.contains('dragging')) return;
    rz.classList.remove('dragging');
    document.body.style.userSelect = '';
    if (finalWidth !== null) {
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(finalWidth)); } catch (e) {}
    }
  };
  rz.addEventListener('pointerup', endDrag);
  rz.addEventListener('pointercancel', endDrag);
})();

function select(type, id) {
  sel = {type, id};
  if (connMode && type === 'node' && !connNodeId) {   // 처음 고른 노드가 중심으로 고정됩니다. 중심을 바꾸려면 연결 모드를 껐다 켭니다.
    connNodeId = id;
    setFstat(`선택 노드와 연결된 노드를 ${connDepth}단계까지 표시합니다. 중심을 바꾸려면 연결 모드를 껐다가 켜세요.`);
  }
  if (focusMode && !focusNodeId && type === 'node') {
    focusNodeId = id;
    setFstat('선택 노드에서 화살표 방향으로 이어지는 경로를 표시합니다.');
  }
  render(); renderPanel();
}

function searchNodes(query) {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  return S.nodes.filter(n => statusMatches(n) && `${n.title || ''}\n${n.memo || ''}`.toLocaleLowerCase().includes(q));
}
// 검색 목록을 보여 줍니다. 검색창이 화면 오른쪽에 있어도 목록이 화면 밖으로 넘치지 않게 왼쪽으로 당깁니다.
function showSearchBox(box) {
  box.hidden = false;
  box.style.left = '0px';
  const over = box.getBoundingClientRect().right - (window.innerWidth - 8);
  if (over > 0) box.style.left = `-${over}px`;
}
// 화살표(들어오는 + 나가는)가 많은 순서의 노드 목록. 연결이 없는 노드는 뺍니다.
// 옵션: listAll=true이면 연결 없는 노드도 맨 끝에 넣고, byStatus=true이면 상태 보기에서 고른 상태의 노드만 남깁니다.
function rankedNodes({listAll = false, byStatus = false} = {}) {
  const inC = new Map(), outC = new Map();
  for (const e of S.edges) { outC.set(e.from, (outC.get(e.from) || 0) + 1); inC.set(e.to, (inC.get(e.to) || 0) + 1); }
  return S.nodes
    .map(n => ({n, inn: inC.get(n.id) || 0, out: outC.get(n.id) || 0}))
    .map(r => ({...r, total: r.inn + r.out}))
    .filter(r => (listAll || r.total > 0) && (!byStatus || statusMatches(r.n)))
    .sort((a, b) => b.total - a.total || (a.n.title || '').localeCompare(b.n.title || '', 'ko'));
}
const statusMatches = n => statusFilter === 'all' || n.status === statusFilter;
const statusDot = n => {
  const st = NODE_STATUSES[n.status] || NODE_STATUSES.not_started;
  return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${st.color};margin-right:5px;vertical-align:1px"></span>${esc(st.label)}`;
};
// 검색창이 비어 있을 때 보여 주는, 연결이 많은 순서의 목록
function renderRankedNodes(box) {
  const rows = rankedNodes({listAll: true, byStatus: true});
  const filtered = statusFilter !== 'all';
  if (!rows.length) {
    if (!filtered) { box.hidden = true; return; }
    const empty = document.createElement('div'); empty.textContent = '이 상태의 노드가 없습니다.';
    empty.style.cssText = 'padding:10px;color:var(--muted);font-size:13px'; box.appendChild(empty); showSearchBox(box); return;
  }
  const head = document.createElement('div');
  head.textContent = filtered ? `${NODE_STATUSES[statusFilter].label} 노드 · 연결이 많은 순서` : '연결이 많은 순서';
  head.style.cssText = 'padding:8px 12px 4px;color:var(--muted);font-size:11px;font-weight:600';
  box.appendChild(head);
  for (const r of rows.slice(0, 50)) {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'option');
    b.innerHTML = `${esc(r.n.title || '(제목 없음)')}<span class="search-detail">${statusDot(r.n)} · 연결 ${r.total}개 · 들어오는 ${r.inn} · 나가는 ${r.out}</span>`;
    b.addEventListener('click', () => goToSearchResult(r.n.id));
    box.appendChild(b);
  }
  if (rows.length > 50) { const more = document.createElement('div'); more.textContent = `외 ${rows.length - 50}개`; more.style.cssText = 'padding:8px;color:var(--muted);font-size:12px'; box.appendChild(more); }
  showSearchBox(box);
}
function renderSearchResults() {
  const input = $('#nodeSearch'), box = $('#searchResults'), q = input.value.trim();
  box.replaceChildren();
  if (!q) { renderRankedNodes(box); return; }
  const matches = searchNodes(q);
  if (!matches.length) {
    const empty = document.createElement('div'); empty.textContent = '검색 결과가 없습니다.';
    empty.style.cssText = 'padding:10px;color:#667085;font-size:13px'; box.appendChild(empty);
  } else {
    for (const n of matches.slice(0, 50)) {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role','option');
      b.innerHTML = `${esc(n.title || '(제목 없음)')}<span class="search-detail">${statusDot(n)} · ${esc(trunc(n.memo || '메모 없음', 80))}</span>`;
      b.addEventListener('click', () => goToSearchResult(n.id)); box.appendChild(b);
    }
    if (matches.length > 50) { const more = document.createElement('div'); more.textContent = `외 ${matches.length - 50}개 결과`; more.style.cssText = 'padding:8px;color:#667085;font-size:12px'; box.appendChild(more); }
  }
  showSearchBox(box);
}
function goToSearchResult(id) {
  if (focusMode) toggleFocusMode();
  if (connMode) toggleConnMode();
  setSidebarVisible(true, true);
  select('node', id);
  const n = node(id), stage = $('#stage'), rect = svg.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const x = rect.left - sr.left + (n.x + dims().w / 2 - viewMinX) * zoom;
  const y = rect.top - sr.top + (n.y + dims().h / 2 - viewMinY) * zoom;
  stage.scrollLeft += x - stage.clientWidth / 2;
  stage.scrollTop += y - stage.clientHeight / 2;
  $('#searchResults').hidden = true;
  searchFocusGuard = true;   // 아래 focus()가 목록을 다시 열지 않게 합니다
  $('#nodeSearch').focus();
  searchFocusGuard = false;
}
let searchFocusGuard = false;
$('#nodeSearch').addEventListener('input', renderSearchResults);
$('#nodeSearch').addEventListener('focus', () => { if (!searchFocusGuard) renderSearchResults(); });
$('#nodeSearch').addEventListener('click', () => { if ($('#searchResults').hidden) renderSearchResults(); });
$('#nodeSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const first = searchNodes(e.currentTarget.value)[0]; if (first) { e.preventDefault(); goToSearchResult(first.id); } }
  if (e.key === 'Escape') $('#searchResults').hidden = true;
});
document.addEventListener('mousedown', e => { if (!e.target.closest('.search-wrap')) $('#searchResults').hidden = true; });

function resetConnMode() {
  connMode = false; connNodeId = null; connCreatedIds.clear();
  $('#btnConn').textContent = '연결 모드';
  $('#btnConn').setAttribute('aria-pressed', 'false');
}
function toggleConnMode() {
  if (connMode) {
    resetConnMode();
    setFstat('전체 그래프를 표시합니다.');
  } else {
    if (focusMode) toggleFocusMode();
    connMode = true;
    connCreatedIds.clear();
    connNodeId = null;
    sel = {type: null, id: null};   // 켜기 전에 선택해 둔 노드는 풀고, 연결을 볼 노드를 새로 고르게 합니다
    $('#btnConn').textContent = '연결 종료';
    $('#btnConn').setAttribute('aria-pressed', 'true');
    setFstat('연결을 볼 노드를 선택하세요.');
  }
  render();
  renderPanel();
}
function toggleFocusMode() {
  if (focusMode) {
    focusMode = false; focusNodeId = null;
    focusCreatedNodeIds.clear(); focusCreatedEdgeIds.clear();
    $('#btnFocus').textContent = '흐름 모드';
    $('#btnFocus').setAttribute('aria-pressed', 'false');
  resetConnMode();
    setFstat('전체 그래프를 표시합니다.');
  } else {
    focusMode = true;
    resetConnMode();
    focusCreatedNodeIds.clear(); focusCreatedEdgeIds.clear();
    sel = {type: null, id: null};
    focusNodeId = null;
    $('#btnFocus').textContent = '흐름 종료';
    $('#btnFocus').setAttribute('aria-pressed', 'true');
    setFstat('흐름을 볼 시작 노드를 선택하세요.');
  }
  render();
  renderPanel();
}

/* ---------- 편집 동작 ---------- */
// 사용 중이 아닌 가장 작은 번호를 씁니다. 예) n1, n2, n4가 있으면 다음은 n3
function freeNodeId() {
  const used = new Set(S.nodes.map(n => n.id));
  let k = 1;
  while (used.has('n' + k)) k++;
  return 'n' + k;
}

function addNode(x, y) {
  const id = freeNodeId();
  S.nodes.push({id, status:'not_started', title:'새 노드', x: Math.max(0, x), y: Math.max(0, y), memo:''});
  if (focusMode) focusCreatedNodeIds.add(id);
  if (connMode) connCreatedIds.add(id);   // 연결 모드 중 새로 만든 노드는 계속 보입니다
  save(); select('node', id);
}

function addEdge(a, b) {
  const exists = S.edges.some(e => e.from === a && e.to === b);
  const reverse = S.edges.some(e => e.from === b && e.to === a);
  if (!exists && reverse && !S.settings.allowMutualEdges) {
    setFstat('두 노드가 서로 연결되는 화살표는 설정에서 양방향 연결을 허용해야 만들 수 있습니다.');
    select('node', b);
    return;
  }
  if (!exists) {
    let newId;
    do { newId = 'e' + S.nextId++; } while (edge(newId));   // 불러온 화살표가 이미 같은 id를 쓰고 있으면 건너뜁니다
    const newEdge = {id: newId, from: a, to: b, memo: ''};
    S.edges.push(newEdge);
    if (focusMode && (focusCreatedNodeIds.has(a) || focusCreatedNodeIds.has(b))) focusCreatedEdgeIds.add(newEdge.id);
    save();
  }
  select('node', b);
}

function deleteSelected() {
  const deletedFocusNode = sel.type === 'node' && sel.id === focusNodeId;
  if (sel.type === 'edge') {
    S.edges = S.edges.filter(e => e.id !== sel.id);
    focusCreatedEdgeIds.delete(sel.id);
  } else if (sel.type === 'node') {
    const n = node(sel.id);
    if (!n) return;
    S.nodes = S.nodes.filter(x => x.id !== n.id);
    S.edges = S.edges.filter(e => e.from !== n.id && e.to !== n.id);
    focusCreatedNodeIds.delete(n.id);
    connCreatedIds.delete(n.id);
    if (connNodeId === n.id) connNodeId = null;
    for (const id of [...focusCreatedEdgeIds]) if (!edge(id)) focusCreatedEdgeIds.delete(id);
  } else return;
  if (deletedFocusNode) {
    focusNodeId = null;
    if (focusMode) setFstat('흐름을 볼 시작 노드를 선택하세요.');
  }
  sel = {type: null, id: null}; save(); render(); renderPanel();
}

/* ---------- 마크다운 파일 저장 ----------
   노드 하나 = 마크다운 파일 하나. 파일명은 id + 제목, 화살표는 상대 링크로 다른 노드 파일을 가리킴 */
function enumeratePaths(limit) {
  const adj = new Map();
  for (const e of S.edges) pushTo(adj, e.from, e.id);
  const starts = startNodes().map(n => n.id), targets = new Set(goalNodes().map(n => n.id));
  if (!starts.length || !targets.size) return [];
  const out = [];
  let budget = 200000;                    // 탐색 횟수 상한: 경로가 지수적으로 많은 그래프에서 저장할 때마다 멈추는 것을 막습니다
  for (const s of starts) {
    const vis = new Set([s]);
    (function go(u, path) {               // path: 화살표 id 목록
      if (out.length >= limit || --budget < 0) return;
      if (targets.has(u)) { out.push([...path]); return; }
      for (const eid of adj.get(u) || []) {
        const v = edge(eid).to;
        if (vis.has(v)) continue;
        vis.add(v); path.push(eid); go(v, path); path.pop(); vis.delete(v);
      }
    })(s, []);
  }
  return out;
}

const fileName = n => NodeMd.fileName(n);
const linkTo = n => `[${n.title}](${encodeURI(fileName(n))})`;

// 형식과 읽기 규칙은 md-graph.js에 있습니다. 노드 파일이 원본이므로 여기서 파일을 쓰는 내용을 만듭니다.
function nodeMd(n) {
  return NodeMd.toNodeMd(n, S);
}

function pathsMd() {
  const L = ['# 시작에서 종료까지의 경로', '', `- 내보낸 날짜: ${today()}`, ''];
  const paths = enumeratePaths(20);
  if (!paths.length) L.push('_진행 상태를 시작·종료로 지정한 노드 사이를 화살표로 연결하면 경로가 표시됩니다._');
  else paths.forEach((p, i) => {
    const parts = [linkTo(node(edge(p[0]).from))];
    for (const eid of p) { const e = edge(eid); parts.push(linkTo(node(e.to))); }
    L.push(`${i + 1}. ${parts.join(' → ')}`);
  });
  return L.join('\n') + '\n';
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* 노드 파일 자동 저장: 저장소(storage.js)가 브라우저나 연결한 폴더 중 현재 방식에 씁니다. */
const setFstat = t => { $('#fstat').textContent = t; };
const storeLabel = () => `폴더(${Store.state.folderName})`;

async function syncNodeFiles() {
  if (mdReadFailed) return;   // md를 못 읽은 상태에서 쓰면 기존 노드 파일이 지워질 수 있습니다
  const files = NodeMd.toNodeFiles(S);
  files.push({name: '_경로.md', text: pathsMd()});
  try {
    const j = await Store.writeNodes(files);
    setFstat(`${storeLabel()}: 노드 ${j.count}개 중 ${j.changed ?? j.count}개 저장됨 (${new Date().toLocaleTimeString()})`);
  } catch (err) {
    setFstat(`자동 저장 실패: ${err.message}`);
  }
}

/* ---------- 자동 정렬 · 화면 맞춤 ---------- */
// 배열 본체. S.nodes와 S.edges가 배열할 범위를 가리키는 동안 실행합니다 (autoLayout이 맞춥니다).
function layoutNodes(mode) {
  const W = dims().w, H = dims().h, N = S.nodes.length;
  if (!N) return;
  // 화살표를 따라 시작 노드에서 계산한 단계. 정렬마다 좌우 또는 상하 흐름의 기준으로 씁니다.
  const adj = new Map(), hasIn = new Set();
  for (const e of S.edges) { pushTo(adj, e.from, e.to); hasIn.add(e.to); }
  // 단계 0은 "시작" 상태 노드와, 들어오는 화살표가 없는 노드(다른 사슬의 맨 앞 원인)입니다. 시작에서 닿지 않는 사슬의 원인도 시작 쪽에 놓이게 합니다.
  const roots = [...new Set([...startNodes().map(n => n.id), ...S.nodes.filter(n => !hasIn.has(n.id)).map(n => n.id)])];
  const starts = roots.length ? roots : [S.nodes[0].id];
  const level = new Map(), q = [];
  for (const id of starts) { level.set(id, 0); q.push(id); }
  while (q.length) {
    const u = q.shift();
    for (const v of adj.get(u) || []) if (!level.has(v)) { level.set(v, level.get(u) + 1); q.push(v); }
  }
  const maxL = Math.max(0, ...level.values());
  for (const n of S.nodes) if (!level.has(n.id)) level.set(n.id, maxL + 1);
  const goals = goalNodes();
  // 화살표 흐름 순서(시작 → 종료)로 노드를 한 줄로 세웁니다. 같은 단계 안에서는 진행 상태 순(시작·미착수 → … → 종료)으로, 종료 노드는 맨 끝에 둡니다.
  // 모든 모양에서 방향이 같습니다: 시작이 위·왼쪽, 종료가 아래·오른쪽.
  const goalIds = new Set(goals.map(g => g.id));
  const lastLevel = Math.max(0, ...S.nodes.filter(n => !goalIds.has(n.id)).map(n => level.get(n.id)));
  for (const g of goals) level.set(g.id, lastLevel + 1);
  const statusRank = n => { const i = ['start', 'not_started', 'in_progress', 'completed', 'stopped', 'failed', 'end'].indexOf(n.status); return i < 0 ? 1 : i; };
  const flow = [...S.nodes].sort((a, b) => level.get(a.id) - level.get(b.id) || statusRank(a) - statusRank(b) || a.y - b.y || a.x - b.x);
  if (mode === 'circle') {
    // 시작은 왼쪽 위, 종료는 오른쪽 아래입니다. 둘 사이를 두 갈래 호(위·오른쪽을 지나는 호, 왼쪽·아래를 지나는 호)가 잇고,
    // 흐름 순서대로 번갈아 두 호에 놓습니다. 그래서 어느 호에서도 시작에서 종료 쪽으로 갈수록 뒤쪽 단계가 됩니다.
    const R = Math.max(220, N * (Math.max(W, H) + 30) / (2 * Math.PI));
    const cx = R + W / 2 + 40, cy = R + H / 2 + 40;
    const thStart = -3 * Math.PI / 4;
    const arcSize = [Math.ceil(N / 2), Math.floor(N / 2)];
    flow.forEach((n, i) => {
      const arc = i % 2, r = Math.floor(i / 2);
      const th = thStart + (arc === 0 ? 1 : -1) * (r + 0.5) / arcSize[arc] * Math.PI;
      n.x = Math.round(cx + R * Math.cos(th) - W / 2);
      n.y = Math.round(cy + R * Math.sin(th) - H / 2);
    });
  } else {
    const STEP_X = W + 50, STEP_Y = H + 40;
    // 줄마다 놓을 노드 수(widths, 합이 노드 수)를 정해 두고 노드를 순서대로 채웁니다. 줄은 가운데 맞춤입니다.
    const place = (nodes, widths) => {
      const maxW = Math.max(...widths);
      let i = 0;
      widths.forEach((w, row) => {
        const left = 40 + (maxW - w) * STEP_X / 2;
        for (let c = 0; c < w && i < nodes.length; c++, i++) { nodes[i].x = Math.round(left + c * STEP_X); nodes[i].y = Math.round(40 + row * STEP_Y); }
      });
    };
    // 남는 노드 수(extra)를 order에 적은 줄부터 한 칸씩 더해 줍니다.
    const spread = (widths, extra, order) => { for (let k = 0; k < extra; k++) widths[order[k % order.length]]++; return widths; };
    // 피라미드 줄 폭: 위에서부터 1, 2, 3 … 개(아래가 넓음). 남는 노드는 아래쪽 줄에 한 개씩 더합니다.
    const pyramidWidths = () => {
      const m = Math.max(1, Math.floor((Math.sqrt(8 * N + 1) - 1) / 2));
      const widths = Array.from({length: m}, (_, i) => i + 1);
      return spread(widths, N - m * (m + 1) / 2, widths.map((_, i) => m - 1 - i));
    };
    if (mode === 'grid') {
      // 정사각형에 가까운 격자. 시작이 왼쪽 위, 종료가 오른쪽 아래입니다.
      const c = Math.ceil(Math.sqrt(N));
      flow.forEach((n, i) => { n.x = 40 + (i % c) * (W + 60); n.y = 40 + Math.floor(i / c) * (H + 60); });
    } else if (mode === 'pyramid') {
      // 꼭대기가 시작, 아래쪽 넓은 줄이 종료입니다(흐름이 위에서 아래로).
      place(flow, pyramidWidths());
    } else if (mode === 'inversePyramid') {
      // 위쪽 넓은 줄이 시작, 아래쪽 뾰족한 끝이 종료입니다(흐름이 위에서 아래로).
      place(flow, pyramidWidths().reverse());
    } else if (mode === 'diamond') {
      // 줄 폭: 1, 2, … k … 2, 1 개(다이아몬드). 남는 노드는 가운데 줄부터 한 개씩 더합니다.
      const k = Math.max(1, Math.floor(Math.sqrt(N)));
      const widths = [...Array.from({length: k}, (_, i) => i + 1), ...Array.from({length: k - 1}, (_, i) => k - 1 - i)];
      const order = widths.map((_, i) => i).sort((x, y) => Math.abs(x - (k - 1)) - Math.abs(y - (k - 1)) || x - y);
      place(flow, spread(widths, N - k * k, order));
    }
    // 같은 줄 안에서 (단계, 진행 상태)가 같은 노드끼리는 연결된 노드들의 위치 평균에 가깝게 순서를 바꿔, 선이 덜 얽히게 합니다.
    // 단계와 진행 상태 순서는 그대로라서 방향(시작 → 종료, 미착수 → 종료)은 유지됩니다.
    const nbr = new Map(), byId = new Map(S.nodes.map(n => [n.id, n]));
    for (const e of S.edges) { pushTo(nbr, e.from, e.to); pushTo(nbr, e.to, e.from); }
    const rows = new Map();
    for (const n of S.nodes) pushTo(rows, n.y, n);
    const rowList = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(r => r[1]);
    const bary = n => {
      const xs = (nbr.get(n.id) || []).map(id => byId.get(id)).filter(m => m && m.y !== n.y).map(m => m.x);
      return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : n.x;
    };
    for (let sweep = 0; sweep < 4; sweep++) {
      for (const row of (sweep % 2 ? [...rowList].reverse() : rowList)) {
        const slots = row.map(n => n.x).sort((a, b) => a - b);
        const keyed = row.map(n => ({n, l: level.get(n.id), s: statusRank(n), b: bary(n)}));
        keyed.sort((p, q) => p.l - q.l || p.s - q.s || p.b - q.b || p.n.x - q.n.x);
        keyed.forEach((k, i) => { k.n.x = slots[i]; });
      }
    }
  }
}

// 정렬 메뉴에서 고른 모양대로 배열합니다. 흐름 모드이면 흐름으로 보이는 노드와 화살표만 배열합니다.
function autoLayout(mode) {
  const allNodes = S.nodes, allEdges = S.edges;
  if ((focusMode && focusNodeId) || connActive()) {
    const {visibleNodeIds, visibleEdgeIds} = visibleSets();
    S.nodes = allNodes.filter(n => visibleNodeIds.has(n.id));
    S.edges = allEdges.filter(e => visibleEdgeIds.has(e.id) && visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to));
    try { layoutNodes(mode); }
    finally { S.nodes = allNodes; S.edges = allEdges; }
  } else {
    layoutNodes(mode);
  }
  save(); render();
}

function fitView() {
  const st = $('#stage');
  zoom = Math.min(FIT_MAX_ZOOM, (st.clientWidth - 24) / lastCW, (st.clientHeight - 24) / lastCH);
  if (!(zoom > 0)) zoom = 1;
  render();
}

/* ---------- 설정 ---------- */
function renderSettings() {
  applyStatusColors();
  for (const key of Object.keys(NODE_STATUSES)) {
    const input = $('#s_sc_' + key), sw = $('#sw_sc_' + key);
    if (input) input.value = NODE_STATUSES[key].color;
    if (sw) sw.style.background = NODE_STATUSES[key].color;
  }
  for (const [id, key] of SELECT_CTRL) $('#' + id).value = S.settings[key];
  for (const [id, key] of NUMBER_CTRL) $('#' + id).value = S.settings[key];
  $('#s_allowMutualEdges').checked = !!S.settings.allowMutualEdges;
  $('#s_canvasPadding').value = S.settings.canvasPadding;
  for (const key of COLOR_CTRL) {
    $('#s_' + key).value = S.settings[key];
    $('#sw_' + key).style.background = S.settings[key];
  }
}

function setColor(key, val) {
  S.settings[key] = val;
  $('#s_' + key).value = val;
  $('#sw_' + key).style.background = val;
  save(); render();
}

// 견본을 누르면 색상 선택 창을 엽니다. preview(색): 고르는 동안 화면만 바꿈, commit(색): 선택을 마치면 저장
function openColorPicker(sw, current, preview, commit) {
  const p = $('#colorPicker'), r = sw.getBoundingClientRect();
  p.style.left = Math.round(r.left) + 'px';
  p.style.top = Math.round(r.bottom) + 'px';
  p.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current.toLowerCase() : '#000000';
  p.oninput = () => preview(p.value);
  p.onchange = () => commit(p.value);
  try { p.showPicker(); } catch (e) { p.click(); }
}

function setStatusColor(key, val) {
  if (val === DEFAULT_STATUS_COLORS[key]) delete S.settings.statusColors[key];
  else S.settings.statusColors[key] = val;
  save(); render(); renderSettings();
}

function buildStatusColorRows() {
  const box = $('#statusColorList');
  box.innerHTML = '';
  for (const [key, def] of Object.entries(NODE_STATUSES)) {
    const row = document.createElement('div');
    row.className = 'crow';
    row.innerHTML = `<span class="scl">${def.label}</span><input type="text" id="s_sc_${key}" maxlength="7" placeholder="${DEFAULT_STATUS_COLORS[key]}" aria-label="${def.label} 색"><span class="sw" id="sw_sc_${key}"></span>`;
    box.appendChild(row);
    const input = row.querySelector('input');
    const apply = () => {
      const v = input.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) setStatusColor(key, v.toLowerCase());
      else input.value = NODE_STATUSES[key].color;   // 잘못된 값이면 되돌림
    };
    input.addEventListener('change', apply);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    const sw = row.querySelector('.sw');
    sw.title = '클릭해서 색 고르기';
    sw.onclick = () => openColorPicker(sw, NODE_STATUSES[key].color,
      v => { S.settings.statusColors[key] = v; sw.style.background = v; input.value = v; render(); },
      v => setStatusColor(key, v));
  }
  $('#btnStatusColorDefault').onclick = () => {
    S.settings.statusColors = {};
    save(); render(); renderSettings();
  };
}

function buildPresets() {
  buildStatusColorRows();
  for (const key of COLOR_CTRL) {
    const sw = $('#sw_' + key);
    sw.title = '클릭해서 색 고르기';
    sw.onclick = () => openColorPicker(sw, S.settings[key],
      v => { S.settings[key] = v; sw.style.background = v; $('#s_' + key).value = v; render(); },
      v => setColor(key, v));
  }
  for (const key of COLOR_CTRL) {
    const box = $('#p_' + key);
    box.innerHTML = '';
    for (const c of PRESETS[key]) {
      const b = document.createElement('button');
      b.className = 'pc'; b.style.background = c; b.title = c;
      b.onclick = () => setColor(key, c);
      box.appendChild(b);
    }
  }
}

/* ---------- 이벤트 ---------- */
function svgPoint(e) { const r = svg.getBoundingClientRect(); return {x: (e.clientX - r.left) / zoom + viewMinX, y: (e.clientY - r.top) / zoom + viewMinY}; }
function closeCanvasMenu() { $('#canvasMenu').hidden = true; }
function addCanvasMenuAction(label, action, danger = false) {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = label; button.setAttribute('role', 'menuitem');
  if (danger) button.classList.add('danger');
  button.addEventListener('click', () => { closeCanvasMenu(); action(); });
  $('#canvasMenu').appendChild(button);
}
$('#stage').addEventListener('contextmenu', e => {
  e.preventDefault();
  const menu = $('#canvasMenu'), nodeTarget = e.target.closest('[data-node]'), edgeTarget = e.target.closest('[data-edge]');
  const point = svgPoint(e);
  menu.replaceChildren();
  if (nodeTarget) {
    const id = nodeTarget.dataset.node;
    select('node', id);
    addCanvasMenuAction('노드 편집', () => select('node', id));
    addCanvasMenuAction('여기서 화살표 연결', () => {
      pendingConnectionSource = id;
      select('node', id);
      setFstat('연결할 결과 노드를 클릭하세요. Esc를 누르면 취소됩니다.');
    });
    addCanvasMenuAction('노드 삭제', () => { select('node', id); deleteSelected(); }, true);
  } else if (edgeTarget) {
    const id = edgeTarget.dataset.edge;
    select('edge', id);
    addCanvasMenuAction('화살표 편집', () => select('edge', id));
    addCanvasMenuAction('화살표 삭제', () => { select('edge', id); deleteSelected(); }, true);
  } else {
    select(null, null);
    addCanvasMenuAction('여기에 노드 추가', () => {
      const D = dims(); addNode(point.x - D.w / 2, point.y - D.h / 2);
    });
    addCanvasMenuAction('전체 그래프 보기', fitView);
    addCanvasMenuAction('실제 크기', () => { zoom = BASE_ZOOM; render(); });
    addCanvasMenuAction('도움말', () => $('#helpDlg').showModal());
  }
  menu.hidden = false;
  menu.style.left = `${e.clientX}px`; menu.style.top = `${e.clientY}px`;
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - r.height - 8))}px`;
    menu.querySelector('button')?.focus();
  });
});
document.addEventListener('mousedown', e => { if (!e.target.closest('#canvasMenu')) closeCanvasMenu(); });
window.addEventListener('resize', closeCanvasMenu);
$('#stage').addEventListener('scroll', closeCanvasMenu, {passive:true});

$('#stage').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  if (e.target.closest('.inline-editor')) return;   // 편집 칸을 누르면 글자 커서만 움직입니다
  // 편집 칸 바깥을 누르면 포커스를 뺏어 저장되게 합니다 (아래 pan 처리의 preventDefault가 포커스 이동을 막기 때문)
  if (inlineEditor && inlineEditor.contains(document.activeElement)) document.activeElement.blur();
  const ng = e.target.closest('[data-node]'), eg = e.target.closest('[data-edge]');
  if (ng) {
    const id = ng.dataset.node;
    if (pendingConnectionSource) {
      const from = pendingConnectionSource; pendingConnectionSource = null; setFstat('');
      if (from !== id) { addEdge(from, id); return; }
    }
    if (e.shiftKey && sel.type === 'node' && sel.id !== id) { addEdge(sel.id, id); return; }
    select('node', id);
    const n = node(id), p = svgPoint(e);
    drag = {id, dx: p.x - n.x, dy: p.y - n.y, moved: false};
  } else if (eg) {
    select('edge', eg.dataset.edge);
  } else {
    select(null, null);
    const stage = $('#stage');
    pan = {x:e.clientX, y:e.clientY, left:stage.scrollLeft, top:stage.scrollTop};
    stage.classList.add('is-panning');
    e.preventDefault();
  }
});
window.addEventListener('mousemove', e => {
  if (pan) {
    const stage = $('#stage');
    stage.scrollLeft = pan.left - (e.clientX - pan.x);
    stage.scrollTop = pan.top - (e.clientY - pan.y);
    return;
  }
  if (!drag) return;
  const p = svgPoint(e), n = node(drag.id);
  n.x = p.x - drag.dx; n.y = p.y - drag.dy;
  drag.moved = true; render(); keepNodeVisible(drag.id);
});
// 노드 더블클릭: 캔버스 위에서 바로 제목·메모를 고칩니다
let inlineEditor = null;
// 화면 좌표에 있는 노드 id. 첫 클릭으로 노드가 다시 그려져도 찾을 수 있도록 좌표로 찾습니다
function nodeIdAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const g = el.closest && el.closest('[data-node]');
    if (g) return g.dataset.node;
  }
  return null;
}
// 노드 자리 편집창의 칸 배치(노드 좌표 기준 px). 노드 모양에 따라 제목·메모 칸 위치가 달라집니다
function inlineEditorLayout() {
  if (compactView) return {radius: 8,
    title: {l: 6, t: 4, w: 100, h: 26, fs: 12, bold: 600, nowrap: true}, memo: null, memoTop: Infinity,
    status: {l: 108, t: 5, w: 56, h: 24, fs: 11}};
  if (S.settings.shape === 'circle') {
    return {radius: '50%', center: true,
      title: {l: 24, t: 26, w: CIRCLE.w - 48, h: 34, fs: 13, bold: 700},
      memo: {l: 24, t: 62, w: CIRCLE.w - 48, h: 28, fs: 11},
      status: {l: 29, t: 94, w: 72, h: 20, fs: 11},
      memoTop: 62};
  }
  return {radius: 10,
    title: {l: 6, t: 6, w: RECT.w - 12, h: 40, fs: 14, bold: 700},
    memo: {l: 6, t: 48, w: RECT.w - 12, h: 36, fs: 11},
    status: {l: 6, t: 86, w: 110, h: 18, fs: 11},
    memoTop: 46};
}
// 더블클릭한 자리에 따라 처음 커서가 갈 칸: 'status' | 'memo' | 'title'
function inlineEditorField(px, py) {
  const L = inlineEditorLayout(), st = L.status;
  if (st && px >= st.l - 4 && px <= st.l + st.w + 4 && py >= st.t - 4 && py <= st.t + st.h + 4) return 'status';
  return L.memo && py >= L.memoTop ? 'memo' : 'title';
}
function closeInlineEditor(save = true) {
  const box = inlineEditor; if (!box || box.dataset.done) return;
  box.dataset.done = '1';
  const id = box.dataset.nodeId;
  if (save) applyInlineEdit(box, id);
  box.remove();
  if (inlineEditor === box) inlineEditor = null;
}
function openInlineEditor(id, field = 'title') {
  const n = node(id); if (!n) return;
  closeInlineEditor(true);
  const stage = $('#stage'), D = dims(), L = inlineEditorLayout();
  const rect = svg.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const left = rect.left - sr.left + stage.scrollLeft + (n.x - viewMinX) * zoom;
  const top = rect.top - sr.top + stage.scrollTop + (n.y - viewMinY) * zoom;
  // 노드와 같은 크기·모양·색으로 덮고, 노드 좌표 그대로 배치한 뒤 확대율만큼 키웁니다 (확대·축소해도 어긋나지 않음)
  const shapeEl = document.querySelector(`[data-node="${CSS.escape(String(id))}"] rect, [data-node="${CSS.escape(String(id))}"] circle`);
  const fill = shapeEl?.getAttribute('fill') || '#ffffff';
  const stroke = shapeEl?.getAttribute('stroke') || '#000000';
  const sw = shapeEl?.getAttribute('stroke-width') || '3';
  const box = document.createElement('div');
  box.className = 'inline-editor';
  box.dataset.nodeId = id;
  box.style.cssText = `left:${left}px;top:${top}px;width:${D.w}px;height:${D.h}px;transform:scale(${zoom});transform-origin:0 0;`
    + `background:${fill};border:${sw}px solid ${stroke};border-radius:${typeof L.radius === 'number' ? L.radius + 'px' : L.radius}`;
  const pos = c => `left:${c.l - sw}px;top:${c.t - sw}px;width:${c.w}px;height:${c.h}px;font-size:${c.fs}px`;
  const ta = (cls, c, ph) => `<textarea class="${cls}" placeholder="${ph}" rows="1" ${c.nowrap ? 'wrap="off"' : ''} style="${pos(c)};font-weight:${c.bold || 400}${L.center ? ';text-align:center' : ''}"></textarea>`;
  const options = Object.entries(NODE_STATUSES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  box.innerHTML = ta('ie-title', L.title, '제목') + (L.memo ? ta('ie-memo', L.memo, '메모') : '')
    + `<select class="ie-status" aria-label="진행 상태" style="${pos(L.status)}${L.center ? ';text-align:center;text-align-last:center' : ''}">${options}</select>`;
  const tEl = box.querySelector('.ie-title'), mEl = box.querySelector('.ie-memo'), sEl = box.querySelector('.ie-status');
  tEl.value = n.title || '';
  if (mEl) mEl.value = n.memo || '';
  sEl.value = NODE_STATUSES[n.status] ? n.status : 'not_started';
  // 상태를 고르면 편집창 안쪽 색도 바로 그 상태 색으로 바뀝니다
  sEl.addEventListener('change', () => {
    box.style.background = sEl.value === 'not_started' ? S.settings.nodeColor : tintColor(NODE_STATUSES[sEl.value].color, 0.12);
  });
  stage.appendChild(box);
  inlineEditor = box;
  // 편집 칸 바깥을 누르면 저장하고 끝냅니다
  box.addEventListener('focusout', e => {
    if (box.contains(e.relatedTarget)) return;
    closeInlineEditor(true);
  });
  // 덮은 배경을 눌러도 포커스가 빠지지 않게 합니다
  box.addEventListener('mousedown', e => { if (e.target === box) e.preventDefault(); });
  // 키: 제목에서 Enter = 저장, 메모에서 Ctrl+Enter = 저장(Enter는 줄바꿈), Esc = 취소, Tab/Shift+Tab = 제목 → 메모 → 진행 상태 순환
  const order = [tEl, mEl, sEl].filter(Boolean);
  box.addEventListener('keydown', e => {
    if (e.isComposing) return;   // 한글 조합 중에는 키를 건드리지 않습니다
    if (e.key === 'Escape') { e.preventDefault(); closeInlineEditor(false); return; }
    if (e.key === 'Enter' && !e.shiftKey && (e.target === tEl || e.ctrlKey || e.metaKey)) { e.preventDefault(); closeInlineEditor(true); return; }
    if (e.key === 'Enter' && e.target === tEl) { e.preventDefault(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const i = order.indexOf(e.target);
      order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length].focus();
    }
  });
  // 제목은 한 줄 취급: 줄바꿈이 붙여 넣어져도 공백으로 바꿉니다
  tEl.addEventListener('input', () => { if (tEl.value.includes('\n')) tEl.value = tEl.value.replace(/\s*\n\s*/g, ' '); });
  const target = field === 'status' ? sEl : (field === 'memo' && mEl) ? mEl : tEl;
  target.focus();
  if (target === sEl) { try { sEl.showPicker(); } catch (e) { /* 목록은 직접 열면 됩니다 */ } }
  else target.setSelectionRange(target.value.length, target.value.length);
}
function applyInlineEdit(box, id) {
  const n = node(id); if (!n) return;
  const t = box.querySelector('.ie-title').value.trim();
  const mEl = box.querySelector('.ie-memo'), st = box.querySelector('.ie-status').value;
  if (t !== (n.title || '')) { n.title = t; save(`node:${id}:title`); }
  if (mEl && mEl.value !== (n.memo || '')) { n.memo = mEl.value; save(`node:${id}:memo`); }
  if (NODE_STATUSES[st] && st !== n.status) { n.status = st; save(`node:${id}:status`); }
  render(); renderPanel();
}
// 노드를 두 번 누르면 편집창을 엽니다. 첫 클릭으로 화면이 다시 그려져 dblclick 이벤트가 나오지 않으므로 mousedown의 클릭 횟수(detail)로 판정합니다
svg.addEventListener('mousedown', e => {
  if (e.button !== 0 || e.detail !== 2 || e.shiftKey || pendingConnectionSource) return;
  const id = nodeIdAt(e.clientX, e.clientY);
  if (!id) return;
  const nd = node(id), pt = svgPoint(e);
  const field = inlineEditorField(pt.x - (nd ? nd.x : 0), pt.y - (nd ? nd.y : 0));   // 누른 자리에 따라 제목·메모·진행 상태 칸으로
  // 마우스 기본 동작이 끝난 뒤에 열어야 포커스가 빠지지 않습니다
  setTimeout(() => openInlineEditor(id, field), 0);
});

// 드래그 중인 노드가 화면 가장자리에 닿으면 스크롤해서 계속 보이게 합니다
function keepNodeVisible(id) {
  const n = node(id); if (!n) return;
  const stage = $('#stage'), D = dims();
  const rect = svg.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const x = rect.left - sr.left + (n.x + D.w / 2 - viewMinX) * zoom;
  const y = rect.top - sr.top + (n.y + D.h / 2 - viewMinY) * zoom;
  const m = 40;
  if (x < m) stage.scrollLeft -= (m - x);
  else if (x > stage.clientWidth - m) stage.scrollLeft += (x - (stage.clientWidth - m));
  if (y < m) stage.scrollTop -= (m - y);
  else if (y > stage.clientHeight - m) stage.scrollTop += (y - (stage.clientHeight - m));
}
window.addEventListener('mouseup', () => {
  if (drag) { if (drag.moved) save(); drag = null; }
  if (pan) { pan = null; $('#stage').classList.remove('is-panning'); }
});
svg.addEventListener('dblclick', e => {
  if (e.target.closest('[data-node],[data-edge]') || nodeIdAt(e.clientX, e.clientY)) return;
  const p = svgPoint(e), D = dims();
  addNode(p.x - D.w / 2, p.y - D.h / 2);
});

NODE_FIELDS.forEach(([id, key]) => $('#' + id).addEventListener('input', e => {
  const n = node(sel.id); if (!n) return;
  n[key] = e.target.value; save(`node:${sel.id}:${key}`); render();
}));
EDGE_FIELDS.forEach(([id, key]) => $('#' + id).addEventListener('input', e => {
  const x = edge(sel.id); if (!x) return;
  x[key] = e.target.value; save(`edge:${sel.id}:${key}`); render();
}));
$('#f_status').addEventListener('change', e => {
  const n = node(sel.id); if (!n) return;
  n.status = NODE_STATUSES[e.target.value] ? e.target.value : 'not_started'; save(); render();
});

SELECT_CTRL.forEach(([id, key]) => $('#' + id).addEventListener('change', e => {
  S.settings[key] = e.target.value; save(); render();
}));
for (const key of COLOR_CTRL) {
  const input = $('#s_' + key);
  const apply = () => {
    const v = input.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(key, v.toLowerCase());
    else input.value = S.settings[key];   // 잘못된 값이면 되돌림
  };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
}
$('#s_allowMutualEdges').addEventListener('change', e => {
  S.settings.allowMutualEdges = e.target.checked; save();
});
for (const [id, key, min, max] of NUMBER_CTRL) {
  $('#' + id).addEventListener('input', e => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value) || e.target.value === '') return;
    S.settings[key] = Math.max(min, Math.min(max, value));
    save(); render();
  });
}
$('#s_canvasPadding').addEventListener('input', e => {
  const value = Number(e.target.value);
  if (!Number.isFinite(value)) return;
  S.settings.canvasPadding = Math.max(0, Math.min(1000, value));
  save(); render();
});
$('#btnSettingsDefault').onclick = () => { S.settings = {...DEFAULT_SETTINGS}; save(); render(); renderSettings(); };
$('#statusFilter').addEventListener('change', e => { statusFilter = e.target.value; render(); if (!$('#searchResults').hidden) renderSearchResults(); });
$('#compactView').addEventListener('change', e => { compactView = e.target.checked; render(); fitView(); });
// 하단 패널(폰 화면): 체크를 해제하면 제목 줄만 남기고 최소화, 다시 체크하면 원래 크기로 돌아갑니다.
$('#panelExpand').addEventListener('change', e => $('aside').classList.toggle('minimized', !e.target.checked));
let activeLayoutMode = 'pyramid';
function setLayoutOptionsOpen(open) {
  const button = $('#layoutMode'), options = $('#layoutOptions');
  options.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open) {
    const r = button.getBoundingClientRect();
    options.style.left = `${Math.max(8, Math.min(r.left, innerWidth - Math.max(170, r.width) - 8))}px`;
    options.style.top = `${r.bottom + 4}px`;
    options.style.minWidth = `${Math.max(170, r.width)}px`;
  }
}
function applyLayoutMode(mode) {
  activeLayoutMode = mode;
  const selected = $('#layoutOptions').querySelector(`[data-layout="${mode}"]`);
  if (!selected) return;
  $('#layoutMode').textContent = `${selected.textContent} ▾`;
  $('#layoutOptions').querySelectorAll('[data-layout]').forEach(option => option.setAttribute('aria-selected', String(option.dataset.layout === mode)));
  setLayoutOptionsOpen(false);
  $('#layoutMode').focus();
  autoLayout(mode); fitView();
}
$('#layoutMode').onclick = () => setLayoutOptionsOpen($('#layoutOptions').hidden);
$('#layoutOptions').addEventListener('click', e => {
  const option = e.target.closest('[data-layout]');
  if (option) applyLayoutMode(option.dataset.layout);
});
$('#layoutMode').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); setLayoutOptionsOpen(true);
    $('#layoutOptions').querySelector(`[data-layout="${activeLayoutMode}"]`)?.focus();
  }
});
$('#layoutOptions').addEventListener('keydown', e => {
  const choices = [...$('#layoutOptions').querySelectorAll('[data-layout]')], i = choices.indexOf(e.target);
  if (e.key === 'Escape') { setLayoutOptionsOpen(false); $('#layoutMode').focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); choices[(i + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]?.focus(); }
  else if (e.key === 'Home') { e.preventDefault(); choices[0]?.focus(); }
  else if (e.key === 'End') { e.preventDefault(); choices.at(-1)?.focus(); }
});
document.addEventListener('mousedown', e => { if (!e.target.closest('.layout-picker') && !e.target.closest('#layoutOptions')) setLayoutOptionsOpen(false); });
$('#btnFit').onclick = fitView;
$('#btnZoom100').onclick = () => { zoom = BASE_ZOOM; render(); };

// Ctrl+휠: 브라우저 배율 대신 캔버스만 조금씩 확대·축소합니다. 커서 아래의 점이 그대로 머물도록 맞춥니다.
$('#stage').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  closeInlineEditor(true);   // 확대·축소 전에 편집 중인 내용을 저장하고 닫습니다
  const stage = $('#stage'), rect = stage.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  const worldX = (stage.scrollLeft + cx) / zoom + viewMinX, worldY = (stage.scrollTop + cy) / zoom + viewMinY;
  zoom = Math.min(3, Math.max(0.2, zoom * Math.exp(-e.deltaY * 0.0015)));
  render();
  stage.scrollLeft = (worldX - viewMinX) * zoom - cx;
  stage.scrollTop = (worldY - viewMinY) * zoom - cy;
}, {passive: false});
$('#btnFocus').onclick = toggleFocusMode;
$('#btnConn').onclick = toggleConnMode;
$('#connDepth').onchange = e => { connDepth = Number(e.target.value) || 1; if (connActive()) setFstat(`연결된 노드를 ${connDepth}단계까지 표시합니다.`); render(); };
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnSidebar').onclick = () => setSidebarVisible($('aside').hidden, true);
$('#btnSettings').onclick = () => { renderSettings(); $('#setDlg').showModal(); };
$('#btnVersions').onclick = () => { renderVersions(); $('#versionDlg').showModal(); };
$('#btnVersionClose').onclick = () => $('#versionDlg').close();
$('#btnCreateVersion').onclick = async () => {
  const input = $('#versionSummary');
  const auto = `수동 저장 · 노드 ${S.nodes.length}개, 화살표 ${S.edges.length}개 · ${new Date().toLocaleString()}`;
  const summary = input.value.trim() || auto;
  if (await createVersion(summary, S, true)) { input.value = ''; renderVersions(); setFstat('현재 상태를 저장했습니다.'); }
};
$('#versionList').addEventListener('change', e => {
  if (e.target.id !== 'verPickAll') return;
  document.querySelectorAll('.ver-pick').forEach(c => c.checked = e.target.checked);
});
$('#versionList').addEventListener('click', async e => {
  if (e.target.closest('#btnDeleteSelectedVersions')) {
    await deleteVersionsBulk([...document.querySelectorAll('.ver-pick:checked')].map(c => c.dataset.versionPick));
    return;
  }
  const open = e.target.closest('[data-version-open]'), restore = e.target.closest('[data-version-restore]'), remove = e.target.closest('[data-version-delete]');
  if (open) {
    const v = versions().find(x => x.id === open.dataset.versionOpen);
    if (v) download(`causal-editor-version-${v.at.slice(0,10)}.json`, JSON.stringify(v.data, null, 2), 'application/json');
  }
  if (restore) {
    const v = versions().find(x => x.id === restore.dataset.versionRestore);
    if (!v || !confirm(`“${v.summary}” 버전으로 그래프 전체를 복원할까요?`)) return;
    await applyGraph(v.data); renderVersions();
  }
  if (remove) {
    const v = versions().find(x => x.id === remove.dataset.versionDelete);
    if (!v || !confirm(`${new Date(v.at).toLocaleString()} 버전을 삭제할까요? 삭제한 버전 파일은 복구할 수 없습니다.`)) return;
    try {
      await Store.deleteVersion(v.id);
      VERSION_LIST = VERSION_LIST.filter(item => item.id !== v.id);
      renderVersions();
    } catch (err) { setFstat(`버전 삭제 실패: ${err.message}`); }
  }
});
$('#btnSetClose').onclick = () => $('#setDlg').close();
/* 데이터 폴더 설정. 노드 파일(.md)·내부데이터·변경이력은 항상 이 폴더에 저장됩니다. 기본은 설치버전 폴더이고, 다른 폴더로 바꿀 수 있습니다. */
async function loadDataFolderSetting() {
  const st = Store.state;
  $('#btnFolderAllow').hidden = true;
  $('#btnDataFolderPick').textContent = '폴더 바꾸기';
  $('#btnDataFolderDefault').hidden = !st.custom;
  $('#btnDataFolderDefault').textContent = '기본 폴더로';
  $('#dataFolderHelp').textContent = '노드 파일(.md)·내부데이터·변경이력이 이 폴더에 저장됩니다. 구글 드라이브, 원드라이브, 싱크싱 같은 동기화 폴더를 고르면 여러 컴퓨터에서 같은 그래프를 쓸 수 있습니다.';
  $('#dataFolderStatus').textContent = `데이터 폴더: ${st.folderPath || '(확인 중)'}${st.custom ? '' : ' (기본)'}`;
}
// 저장 방식이 바뀐 뒤 화면을 새 저장소 기준으로 맞춥니다.
async function afterStoreChange(loadFromStore) {
  if (loadFromStore) await loadSavedGraph({settings: S.settings}); else await persistNow();
  try { await loadVersions(); renderVersions(); } catch (err) { VERSION_LIST = []; setFstat(`변경 이력을 읽지 못했습니다: ${err.message}`); }
  await loadDataFolderSetting();
}
async function connectFolder(chosen = null) {
  let handle = chosen;
  if (!handle) {
    try { handle = await Store.pickFolder(); }
    catch (err) { if (err && err.name !== 'AbortError') alert(`폴더를 열지 못했습니다: ${err.message}`); return; }
  }
  try {
    const n = await Store.countNodeFiles(handle);
    let load = false;
    if (n > 0) {
      if (confirm(`이 폴더에는 노드 파일이 ${n}개 있습니다.\n\n[확인] 폴더의 내용을 불러옵니다 (지금 화면의 그래프는 이 폴더에 저장되지 않습니다)\n[취소] 다음 질문으로 넘어갑니다`)) load = true;
      else if (!confirm(`지금 화면의 그래프로 이 폴더의 노드 파일 ${n}개를 덮어쓸까요?\n폴더에 있던 노드 파일은 지워집니다.`)) return;
    }
    await Store.useFolder(handle);
    await afterStoreChange(load);
    setFstat(load ? `폴더에서 불러왔습니다: ${handle.name}` : `폴더에 저장을 시작했습니다: ${handle.name}`);
  } catch (err) { alert(`폴더 연결 실패: ${err.message}`); await loadDataFolderSetting(); }
}
const disconnectFolder = () => connectFolder({name: '기본 폴더', path: ''});   // 기본 폴더로 되돌립니다. 기본 폴더에 노드 파일이 있으면 같은 방식으로 묻습니다.
$('#btnDataFolderPick').onclick = () => connectFolder();   // 클릭 이벤트가 connectFolder의 매개변수로 들어가지 않게 감쌉니다
$('#btnFolderAllow').onclick = async () => {
  try {
    await Store.allowFolderAgain();
    await reloadFromNodeFiles(true);
    await loadVersions(); renderVersions();
    await loadDataFolderSetting();
  } catch (err) { alert(err.message); }
};
$('#btnDataFolderDefault').onclick = disconnectFolder;
$('#btnSave').onclick = () => download('causal-editor.json', JSON.stringify(S, null, 2), 'application/json');

// 그래프 JSON, 또는 변경이력/의 버전 파일({id, at, summary, data})을 받아 현재 그래프를 바꿉니다.
// 바꾸면 저장 위치(브라우저 또는 연결한 폴더의 노드파일/)도 바로 덮어쓰이므로, 먼저 확인을 받습니다.
async function importGraphFile(text, fileName = '') {
  let o = JSON.parse(text);
  if (!Array.isArray(o.nodes) && o.data && Array.isArray(o.data.nodes)) o = o.data;   // 버전 파일
  if (!Array.isArray(o.nodes)) throw new Error('인과 편집기의 그래프 JSON이 아닙니다.');
  if (S.nodes.length) {
    const where = `데이터 폴더(${Store.state.folderName})의 노드 파일이 모두 이 내용으로 덮어써집니다`;
    const msg = `${fileName ? `“${fileName}”으로 ` : ''}그래프를 바꿀까요?\n\n현재: 노드 ${S.nodes.length}개 · 화살표 ${S.edges.length}개\n불러올 내용: 노드 ${o.nodes.length}개 · 화살표 ${(o.edges || []).length}개\n\n${where}.\n되돌리려면 먼저 "버전 기록"에서 현재 상태를 저장해 두세요.`;
    if (!confirm(msg)) return;
  }
  await applyGraph(o);
  setFstat(`JSON을 불러왔습니다 (노드 ${S.nodes.length}개, 화살표 ${S.edges.length}개)`);
}

$('#file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try { await importGraphFile(await f.text(), f.name); }
  catch (err) { alert(`JSON 불러오기 실패: ${err.message}`); }
  e.target.value = '';
});

$('#btnHelp').onclick = () => $('#helpDlg').showModal();
$('#btnHelpClose').onclick = () => $('#helpDlg').close();
$('#btnAdd').onclick = () => addNode(60 + Math.random() * 300, 60 + Math.random() * 300);
$('#btnDelNode').onclick = deleteSelected;
$('#btnOpenMd').onclick = () => {
  const n = node(sel.id); if (!n) return;
  // 브라우저는 파일을 OS의 기본 프로그램으로 열 수 없으므로, 저장 창 없이 새 탭에 텍스트로 보여 줍니다.
  const url = URL.createObjectURL(new Blob([nodeMd(n)], {type: 'text/plain;charset=utf-8'}));
  const tab = window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  setFstat(tab ? `${fileName(n)} 을 새 탭에 열었습니다.` : '새 탭이 막혔습니다. 브라우저의 팝업 차단을 풀어 주세요.');
};
$('#btnDelEdge').onclick = deleteSelected;
$('#btnReset').onclick = async () => {
  if (!confirm('모든 노드와 화살표를 지우고 처음부터 시작할까요? (설정은 유지됩니다)')) return;
  const keep = S.settings;
  S = initial(); S.settings = keep;
  await applyGraph(S);
  setFstat('모든 노드와 화살표를 지웠습니다.');
};

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeCanvasMenu();
    if (pendingConnectionSource) { pendingConnectionSource = null; setFstat('화살표 연결을 취소했습니다.'); }
    return;
  }
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
});
/* ---------- 시작 ---------- */
// 시작 화면: 빈 그래프에 브라우저에 보관된 설정(색·모양 등)만 먼저 입힙니다. 그래프는 노드 파일에서 읽어 채웁니다(loadSavedGraph).
const browserData = load();
S = {...initial(), settings: browserData?.settings || {}};
prepareState();
resetHistory();
let sidebarHiddenAtLoad = false;
try { sidebarHiddenAtLoad = localStorage.getItem(SIDEBAR_KEY) === '1'; } catch (e) {}
loadSidebarWidth();
setSidebarVisible(!sidebarHiddenAtLoad);
buildPresets();
render(); renderPanel();
// 저장소 방식(브라우저·폴더)을 정한 뒤 변경 이력과 그래프를 읽습니다.
/* ---------- 데이터 안전: 버전 기록의 "N시간마다 자동 저장" 옵션, 첫 실행 때 폴더 연결 권고 ---------- */
// 옵션이 켜져 있으면(기본 켜짐, 기본 24시간마다) 버전 기록에 "자동 저장 날짜 시각"으로 남깁니다. 마지막 자동 저장 뒤 정한 시간이 지났고 그래프가 마지막 버전과 다를 때만 만듭니다.
// 자동 저장한 버전도 일반 버전과 같아서 버전 기록 창에서 복원·삭제할 수 있고, 자동으로 지우지는 않습니다.
// 폴더를 연결한 상태면 버전이 폴더의 변경이력/에 파일로 남습니다(브라우저 저장만 쓸 때는 브라우저 안에만 남아 사이트 데이터를 지우면 함께 사라집니다).
const AUTO_PREFIX = '자동 저장 ', AUTO_VERSION_KEY = 'causal-editor-auto-version', AUTO_HOURS_KEY = 'causal-editor-auto-hours';
const AUTO_HOURS_DEFAULT = 24, AUTO_HOURS_MAX = 720, AUTO_KEEP = 300;   // 자동 저장 버전은 최근 300개만 남깁니다(직접 만든 버전은 지우지 않습니다)
const autoVersionOn = () => { try { return localStorage.getItem(AUTO_VERSION_KEY) !== '0'; } catch (e) { return true; } };
const autoHours = () => {
  let h = AUTO_HOURS_DEFAULT;
  try { h = Math.round(Number(localStorage.getItem(AUTO_HOURS_KEY))) || AUTO_HOURS_DEFAULT; } catch (e) { /* 기본값 */ }
  return Math.min(AUTO_HOURS_MAX, Math.max(1, h));
};
let autoSaveBusy = false;
// 버전 기록은 목록을 열 때 전부 메모리로 읽으므로, 짧은 간격으로 오래 쓰면 자동 저장 버전이 끝없이 쌓여 느려집니다. 가장 오래된 자동 저장부터 지웁니다.
async function pruneAutoVersions() {
  const old = VERSION_LIST.filter(v => String(v.summary).startsWith(AUTO_PREFIX)).slice(AUTO_KEEP);   // VERSION_LIST는 최신순
  if (!old.length) return;
  const gone = new Set();
  for (const v of old) {
    try { await Store.deleteVersion(v.id); gone.add(v.id); } catch (e) { break; }
  }
  if (gone.size) { VERSION_LIST = VERSION_LIST.filter(v => !gone.has(v.id)); if ($('#versionDlg').open) renderVersions(); }
}
async function maybeAutoSaveVersion() {
  if (!autoVersionOn() || autoSaveBusy || mdReadFailed || !S.nodes.length) return;
  if (Store.state.mode === 'folder' && !Store.state.folderReady) return;   // 폴더 권한이 없으면 건너뜁니다
  autoSaveBusy = true;
  try {
    const last = VERSION_LIST.find(v => String(v.summary).startsWith(AUTO_PREFIX));   // VERSION_LIST는 최신순
    if (!last || Date.now() - new Date(last.at).getTime() >= autoHours() * 60 * 60 * 1000) {
      await createVersion(AUTO_PREFIX + new Date().toLocaleString('sv-SE').slice(0, 16), S, false);
      await pruneAutoVersions();
    }
  } finally { autoSaveBusy = false; }
}
$('#autoVersion').checked = autoVersionOn();
$('#autoHours').value = autoHours();
$('#autoVersion').addEventListener('change', e => {
  try { localStorage.setItem(AUTO_VERSION_KEY, e.target.checked ? '1' : '0'); } catch (err) {}
  if (e.target.checked) maybeAutoSaveVersion().catch(() => {});
});
$('#autoHours').addEventListener('change', e => {
  const h = Math.min(AUTO_HOURS_MAX, Math.max(1, Math.round(Number(e.target.value)) || AUTO_HOURS_DEFAULT));   // 1시간 단위 정수만
  e.target.value = h;
  try { localStorage.setItem(AUTO_HOURS_KEY, String(h)); } catch (err) {}
  maybeAutoSaveVersion().catch(() => {});
});
setInterval(() => maybeAutoSaveVersion().catch(() => {}), 10 * 60 * 1000);   // 오래 켜 둔 탭에서도 정한 시간이 지나면 만듭니다
document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeAutoSaveVersion().catch(() => {}); });

Store.init().then(() => {
  loadDataFolderSetting();
  loadVersions().then(() => { renderVersions(); }).catch(err => setFstat(`변경 이력을 읽지 못했습니다: ${err.message}`));
  return loadSavedGraph(browserData);
}).then(async () => {
  try { await loadVersions(); renderVersions(); } catch (e) { /* 위에서 이미 안내합니다 */ }
  await maybeAutoSaveVersion();
}).catch(err => setFstat(`그래프를 읽지 못했습니다: ${err.message}`));
