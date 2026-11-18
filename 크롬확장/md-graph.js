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
  // 노드 파일 이름은 제목입니다(예: "나인봇 맥스 수리.md"). 밑줄로 시작하는 파일(_경로.md)과 동기화 충돌 사본은 노드가 아닙니다.
  // 노드를 구별하는 값은 파일 이름이 아니라 앞머리의 id입니다. 같은 제목이 둘 이상이면 "제목 (n12).md"처럼 id를 붙입니다.
  const OWN_NODE_FILE = /^(?!_|.*\.sync-conflict-).+\.md$/;
  const DEFAULT_TITLE = '노드';

  // 제목을 파일 이름으로 쓸 수 있게 다듬습니다. 금지 문자는 밑줄로 바꾸고, 밑줄·점으로 시작하지 않게 하며, 너무 길면 자릅니다.
  const safeTitle = t => (String(t || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, ' ').trim()
    .replace(/^[_.]+/, '').replace(/[. ]+$/, '').slice(0, 100).trim()) || DEFAULT_TITLE;
  // 노드 id -> 파일 이름. 제목이 겹치면 id를 붙입니다(id 순서로 먼저 온 노드가 제목만 쓰는 이름을 받습니다).
  function fileNames(nodes) {
    const names = new Map(), used = new Set();
    for (const n of [...nodes].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', {numeric: true}))) {
      const base = safeTitle(n.title);
      let name = base + '.md';
      if (used.has(name.toLowerCase())) name = `${base} (${n.id}).md`;
      used.add(name.toLowerCase());
      names.set(n.id, name);
    }
    return names;
  }

  function trimBlankLines(lines) {
    let a = 0, b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return lines.slice(a, b).join('\n');
  }

  // 메모 안의 줄이 "#"로 시작하면 파일을 읽을 때 제목·구역 표시(## 원인 등)로 오해해서 메모가 잘리거나 화살표가 생깁니다.
  // 그래서 쓸 때 그런 줄 앞에 역슬래시를 하나 붙이고(\#), 읽을 때 하나 뗍니다. 이미 역슬래시로 시작하는 줄도 같은 규칙이라 그대로 돌아옵니다.
  const escapeMemo = s => String(s).split('\n').map(l => (/^\\*#/.test(l) ? '\\' + l : l)).join('\n');
  const unescapeMemo = s => s.split('\n').map(l => (/^\\+#/.test(l) ? l.slice(1) : l)).join('\n');

  // 화살표를 노드별로 한 번에 모읍니다. 노드마다 전체 화살표를 훑지 않아서 노드가 많아도 빠릅니다.
  function indexGraph(graph) {
    const byId = new Map(graph.nodes.map(x => [x.id, x]));
    const incoming = new Map(), outgoing = new Map();
    const add = (m, k, e) => { const a = m.get(k); if (a) a.push(e); else m.set(k, [e]); };
    for (const e of graph.edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      add(incoming, e.to, e); add(outgoing, e.from, e);
    }
    return {byId, incoming, outgoing, names: fileNames(graph.nodes)};
  }

  // 노드 하나를 Markdown 문자열로 만듭니다. graph = {nodes, edges}. 여러 노드를 만들 때는 index를 한 번 만들어 넘기면 빠릅니다.
  function toNodeMd(n, graph, index = indexGraph(graph)) {
    const status = STATUS_LABEL[n.status] ? n.status : 'not_started';
    const x = Math.round(Number(n.x)) || 0, y = Math.round(Number(n.y)) || 0;
    const L = [
      '---', `id: ${n.id}`, `x: ${x}`, `y: ${y}`, `status: ${status}`, '---', '',
      `# ${n.title || DEFAULT_TITLE}`, '',
      '## 진행 상태', '', STATUS_LABEL[status], ''
    ];
    if (n.memo) L.push('## 메모', '', escapeMemo(n.memo), '');

    const arrow = (e, other) => {
      const out = [`- [${other.title || DEFAULT_TITLE}](${encodeURI(index.names.get(other.id))})`];
      if (e.memo) {
        const [first, ...rest] = String(e.memo).split('\n');
        out.push(`  - 메모: ${first}`, ...rest.map(s => `    ${s}`));
      }
      return out;
    };
    const incoming = index.incoming.get(n.id) || [];
    const outgoing = index.outgoing.get(n.id) || [];

    L.push('## 원인 (이 상태로 이어진 화살표)', '');
    if (!incoming.length) L.push('_없음_');
    for (const e of incoming) L.push(...arrow(e, index.byId.get(e.from)));
    L.push('', '## 결과 (이 상태에서 나가는 화살표)', '');
    if (!outgoing.length) L.push('_없음_');
    for (const e of outgoing) L.push(...arrow(e, index.byId.get(e.to)));
    return L.join('\n') + '\n';
  }

  // 그래프의 모든 노드 파일 [{name, text}]을 한 번에 만듭니다.
  function toNodeFiles(graph) {
    const index = indexGraph(graph);
    return graph.nodes.map(n => ({name: index.names.get(n.id), text: toNodeMd(n, graph, index)}));
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
    // 같은 id의 파일이 여럿이면(제목 변경 뒤 남은 옛 파일 등) 새 노드를 만들지 않습니다.
    // 파일 이름이 제목으로 정해진 이름과 같은 파일을 원본으로 쓰고, 나머지는 무시합니다.
    const parsed = [];
    for (const f of files || []) {
      const name = String(f.name || '').split('/').pop();
      if (!OWN_NODE_FILE.test(name)) continue;
      const {meta, body} = splitFrontMatter(f.text);
      const id = /^n\d+$/.test(meta.id || '') ? meta.id : null;   // id는 앞머리에서만 읽습니다(파일 이름에는 번호가 없습니다)
      parsed.push({name, meta, body, id, mtime: Number(f.mtime) || 0});
    }
    const items = [], groups = new Map();
    for (const it of parsed) {
      if (!it.id) { items.push(it); continue; }
      if (!groups.has(it.id)) groups.set(it.id, []);
      groups.get(it.id).push(it);
    }
    for (const [id, group] of groups) {
      const base = safeTitle(titleOf(group[0].body, DEFAULT_TITLE));
      const canonical = group.find(it => it.name === base + '.md' || it.name === `${base} (${id}).md`);
      items.push(canonical || group[0]);
    }
    const usedIds = new Set(items.filter(it => it.id).map(it => it.id));
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
      return nameToId.get(t) || null;
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
        memo: unescapeMemo(trimBlankLines(findSection(secs, '메모') || [])),
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
    // 제목이 같은 노드는 한 노드로 봅니다(파일 이름이 달라서 따로 생긴 같은 글). 기본 제목("노드")은 합치지 않습니다.
    // 남길 노드는 파일 이름이 제목과 같은 쪽, 없으면 먼저 읽은 쪽입니다. 합쳐진 노드의 화살표는 남길 노드로 옮기고,
    // 합치면서 생긴 자기 자신으로 가는 화살표는 버립니다. 양방향 화살표는 그대로 둡니다(설정은 새로 만들 때만 막습니다).
    const groupsByTitle = new Map();
    nodes.forEach((n, i) => {
      if (n.title === DEFAULT_TITLE) return;
      if (!groupsByTitle.has(n.title)) groupsByTitle.set(n.title, []);
      groupsByTitle.get(n.title).push({n, name: items[i].name, mtime: items[i].mtime});
    });
    const remap = new Map();
    for (const group of groupsByTitle.values()) {
      if (group.length < 2) continue;
      const base = safeTitle(group[0].n.title);
      // 가장 최근에 바뀐 파일을 남깁니다. 시간을 알 수 없으면 파일 이름이 제목과 같은 쪽을 남깁니다.
      const hasTime = group.some(g => g.mtime);
      const keeper = hasTime
        ? group.reduce((best, g) => (g.mtime || 0) > (best.mtime || 0) ? g : best, group[0])
        : (group.find(g => g.name === base + '.md') || group[0]);
      for (const g of group) if (g !== keeper) remap.set(g.n.id, keeper.n.id);
    }
    const mapId = id => remap.get(id) || id;
    const finalEdges = new Map();
    for (const e of edgeMap.values()) {
      const from = mapId(e.from), to = mapId(e.to);
      if (from === to) continue;
      const key = from + '\u0000' + to;
      if (!finalEdges.has(key)) finalEdges.set(key, {id: `e_${from}_${to}`, from, to, memo: e.memo});
    }
    return {
      nodes: nodes.filter(n => !remap.has(n.id)).map(({id, status, title, x, y, memo}) => ({id, status, title, x, y, memo})),
      edges: [...finalEdges.values()]
    };
  }

  return {fileNames, safeTitle, toNodeMd, toNodeFiles, parseNodeFiles, OWN_NODE_FILE, STATUS_LABEL, STATUS_KEY};
})();
if (typeof module !== 'undefined') module.exports = NodeMd;
