// 노드 Markdown 파일 <-> 그래프 변환기.
// PC(server.js)와 안드로이드(android-shim.js)가 같은 형식을 읽고 씁니다.
// 원본은 노드 Markdown 파일입니다. 그래프 JSON은 내부데이터 폴더의 보조 사본(백업·설정 보관)입니다.
//
// 파일 형식 (노드 하나 = 파일 하나)
//   ---            앞머리: 기계가 읽는 값 (id, x, y, status)
//   id: n12
//   x: 120
//   y: 340
//   status: in_progress
//   ---
//   # 제목  제목 줄. 시작/종료는 진행 상태(시작·종료)로 정합니다. 예전 파일의 제목 뒤 (시작)/(목표) 표시는 읽을 때 버립니다.
//   ## 진행 상태 / ## 메모 / ## 원인 / ## 결과
//   결과 목록: - [다음 노드 제목](다음파일.md)  ·  메모가 있으면 "  - 메모: ..." (여러 줄이면 다음 줄을 4칸 들여씀)
const NodeMd = (function () {
  const STATUS_LABEL = {
    start: '시작', not_started: '미착수', in_progress: '진행 중', completed: '완료', stopped: '중단', failed: '실패', end: '종료'
  };
  const STATUS_KEY = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [v, k]));
  const OWN_NODE_FILE = /^n\d+_.*\.md$/;          // 노드 파일 이름 (_경로.md는 제외)
  const ID_FROM_NAME = /^n(\d+)_/;
  const DEFAULT_TITLE = '노드';

  const fileName = n => `n${String(n.id).replace(/^n/, '').padStart(4, '0')}_${(n.title || DEFAULT_TITLE).replace(/[\\/:*?"<>|\s]+/g, '_')}.md`;

  function trimBlankLines(lines) {
    let a = 0, b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return lines.slice(a, b).join('\n');
  }

  // 노드 하나를 Markdown 문자열로 만듭니다. graph = {nodes, edges}
  function toNodeMd(n, graph) {
    const byId = new Map(graph.nodes.map(x => [x.id, x]));
    const status = STATUS_LABEL[n.status] ? n.status : 'not_started';
    const x = Math.round(Number(n.x)) || 0, y = Math.round(Number(n.y)) || 0;
    const L = [
      '---', `id: ${n.id}`, `x: ${x}`, `y: ${y}`, `status: ${status}`, '---', '',
      `# ${n.title || DEFAULT_TITLE}`, '',
      '## 진행 상태', '', STATUS_LABEL[status], ''
    ];
    if (n.memo) L.push('## 메모', '', n.memo, '');

    const arrow = (e, other) => {
      const out = [`- [${other.title || DEFAULT_TITLE}](${encodeURI(fileName(other))})`];
      if (e.memo) {
        const [first, ...rest] = String(e.memo).split('\n');
        out.push(`  - 메모: ${first}`, ...rest.map(s => `    ${s}`));
      }
      return out;
    };
    const incoming = graph.edges.filter(e => e.to === n.id && byId.has(e.from));
    const outgoing = graph.edges.filter(e => e.from === n.id && byId.has(e.to));

    L.push('## 원인 (이 상태로 이어진 화살표)', '');
    if (!incoming.length) L.push('_없음_');
    for (const e of incoming) L.push(...arrow(e, byId.get(e.from)));
    L.push('', '## 결과 (이 상태에서 나가는 화살표)', '');
    if (!outgoing.length) L.push('_없음_');
    for (const e of outgoing) L.push(...arrow(e, byId.get(e.to)));
    return L.join('\n') + '\n';
  }

  // 앞머리(---)의 key: value 값을 읽고 본문을 돌려줍니다.
  function splitFrontMatter(text) {
    const src = String(text || '').replace(/\r\n/g, '\n');
    const meta = {};
    if (!src.startsWith('---\n')) return {meta, body: src};
    const end = src.indexOf('\n---', 3);
    if (end < 0) return {meta, body: src};
    for (const line of src.slice(4, end).split('\n')) {
      const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim();
    }
    const after = src.indexOf('\n', end + 1);
    return {meta, body: after < 0 ? '' : src.slice(after + 1)};
  }

  // "## 제목" 아래 줄들을 제목별로 모읍니다.
  function sectionsOf(body) {
    const secs = new Map();
    let cur = null;
    for (const line of body.split('\n')) {
      const m = line.match(/^## (.*)$/);
      if (m) { cur = m[1].trim(); secs.set(cur, []); continue; }
      if (cur !== null) secs.get(cur).push(line);
    }
    return secs;
  }
  const findSection = (secs, prefix) => {
    for (const [h, lines] of secs) if (h.startsWith(prefix)) return lines;
    return null;
  };

  function titleOf(body, fallback) {
    const line = body.split('\n').find(l => /^# /.test(l));
    if (!line) return fallback;
    const t = line.slice(2).trim().replace(/ \((시작|목표)\)$/, '').trim();
    return t || fallback;
  }

  // 화살표 목록 -> [{target, memo}]
  function parseArrows(lines) {
    const out = [];
    let cur = null, memoLines = null;
    const close = () => { if (cur && memoLines) cur.memo = memoLines.join('\n'); memoLines = null; };
    for (const line of lines || []) {
      const link = line.match(/^- \[(.*)\]\((.+)\)\s*$/);
      if (link) { close(); cur = {target: link[2], memo: ''}; out.push(cur); continue; }
      const memo = line.match(/^ {2}- 메모: ?(.*)$/);
      if (memo && cur) { close(); memoLines = [memo[1]]; continue; }
      if (memoLines && /^ {4}/.test(line)) { memoLines.push(line.slice(4)); continue; }
      if (line.trim() === '') close();
    }
    close();
    return out;
  }

  // 노드 파일들([{name, text}]) -> {nodes, edges}
  function parseNodeFiles(files) {
    const items = [];
    const usedIds = new Set();
    for (const f of files || []) {
      const name = String(f.name || '').split('/').pop();
      if (!OWN_NODE_FILE.test(name)) continue;
      const {meta, body} = splitFrontMatter(f.text);
      const fromName = name.match(ID_FROM_NAME);
      let id = /^n\d+$/.test(meta.id || '') ? meta.id : (fromName ? 'n' + Number(fromName[1]) : null);
      if (id && usedIds.has(id)) id = null;          // 같은 번호 중복은 새 번호를 받습니다
      if (id) usedIds.add(id);
      items.push({name, meta, body, id});
    }
    let k = 1;
    for (const it of items) {
      if (it.id) continue;
      while (usedIds.has('n' + k)) k++;
      it.id = 'n' + k; usedIds.add(it.id);
    }

    const nameToId = new Map(items.map(it => [it.name, it.id]));
    const idSet = new Set(items.map(it => it.id));
    const resolve = target => {
      let t = String(target);
      try { t = decodeURI(t); } catch (e) { /* 그대로 씁니다 */ }
      t = t.split('/').pop();
      if (nameToId.has(t)) return nameToId.get(t);
      const m = t.match(ID_FROM_NAME);
      const id = m ? 'n' + Number(m[1]) : null;
      return id && idSet.has(id) ? id : null;
    };

    const nodes = items.map(it => {
      const secs = sectionsOf(it.body);
      const statusLine = (findSection(secs, '진행 상태') || []).find(l => l.trim());
      // 사람이 보는 '진행 상태' 글자를 먼저 따르고, 없으면 앞머리 값을 씁니다
      const status = STATUS_KEY[(statusLine || '').trim()] || (STATUS_LABEL[it.meta.status] ? it.meta.status : 'not_started');
      const x = Number(it.meta.x), y = Number(it.meta.y);
      return {
        id: it.id, status,
        title: titleOf(it.body, it.name.replace(/^n\d+_/, '').replace(/\.md$/, '').replace(/_/g, ' ') || DEFAULT_TITLE),
        x: Number.isFinite(x) ? x : NaN,
        y: Number.isFinite(y) ? y : NaN,
        memo: trimBlankLines(findSection(secs, '메모') || []),
        _out: parseArrows(findSection(secs, '결과')),
        _in: parseArrows(findSection(secs, '원인'))
      };
    });

    // 결과 목록(보낸 쪽)이 메모를 정합니다. 원인 목록은 빠진 화살표만 채웁니다.
    const edgeMap = new Map();
    const addEdge = (from, to, memo) => {
      if (!from || !to || !idSet.has(from) || !idSet.has(to)) return;
      const key = from + '\u0000' + to;
      if (!edgeMap.has(key)) edgeMap.set(key, {id: `e_${from}_${to}`, from, to, memo: memo || ''});
    };
    for (const n of nodes) for (const a of n._out) addEdge(n.id, resolve(a.target), a.memo);
    for (const n of nodes) for (const a of n._in) addEdge(resolve(a.target), n.id, a.memo);

    // 위치가 없는 노드는 격자에 배치합니다
    let slot = 0;
    for (const n of nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
        n.x = 60 + (slot % 5) * 200;
        n.y = 60 + Math.floor(slot / 5) * 140;
        slot++;
      }
    }
    return {
      nodes: nodes.map(({id, status, title, x, y, memo}) => ({id, status, title, x, y, memo})),
      edges: [...edgeMap.values()]
    };
  }

  return {fileName, toNodeMd, parseNodeFiles, OWN_NODE_FILE, STATUS_LABEL, STATUS_KEY};
})();
if (typeof module !== 'undefined') module.exports = NodeMd;
