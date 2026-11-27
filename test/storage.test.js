const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class NotFoundError extends Error { constructor() { super('Not found'); this.name = 'NotFoundError'; } }
class FileHandle {
  constructor(dir, name) { this.dir = dir; this.name = name; this.kind = 'file'; }
  async getFile() {
    if (!this.dir.files.has(this.name)) throw new NotFoundError();
    const text = this.dir.files.get(this.name);
    return {text: async () => text, lastModified: Date.now()};
  }
  async createWritable() {
    let text = '';
    return {write: async value => { text = value; }, close: async () => {
      if (this.dir.failWrite && this.name === '변경이력.json') { this.dir.failWrite = false; throw Error('write failed'); }
      this.dir.writeCount++;
      this.dir.files.set(this.name, text);
    }};
  }
}
class DirectoryHandle {
  constructor(name = 'root') { this.name = name; this.kind = 'directory'; this.dirs = new Map(); this.files = new Map(); this.failWrite = false; this.writeCount = 0; }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
  async getDirectoryHandle(name, {create} = {}) {
    if (!this.dirs.has(name)) { if (!create) throw new NotFoundError(); this.dirs.set(name, new DirectoryHandle(name)); }
    return this.dirs.get(name);
  }
  async getFileHandle(name, {create} = {}) {
    if (!this.files.has(name) && !create) throw new NotFoundError();
    return new FileHandle(this, name);
  }
  async *entries() {
    for (const [name, dir] of this.dirs) yield [name, dir];
    for (const name of this.files.keys()) yield [name, new FileHandle(this, name)];
  }
  async removeEntry(name) {
    if (this.failRemove === name) { this.failRemove = null; throw Error('remove failed'); }
    if (this.files.delete(name) || this.dirs.delete(name)) return;
    throw new NotFoundError();
  }
}

function setup() {
  const source = fs.readFileSync(path.join(__dirname, '../크롬확장/storage.js'), 'utf8');
  const context = vm.createContext({window: {showDirectoryPicker() {}}, navigator: {}, console, Date, Math, JSON, Set, Map, Promise, Error});
  vm.runInContext(source, context);
  const store = vm.runInContext('Store', context);
  const root = new DirectoryHandle();
  store.state.mode = 'folder'; store.state.handle = root; store.state.folderReady = true;
  return {store, root};
}
const graph = n => ({nodes: [{id: n}], edges: []});
const loose = (id, data = graph(id)) => JSON.stringify({id: 'wrong-id', at: '2020-01-01T00:00:00.000Z', summary: 'old', data});
const hist = root => root.dirs.get('편집기데이터');

test('폴더 이력 추가, 최신순 조회, 단건 및 배열 삭제', async () => {
  const {store} = setup();
  const first = await store.addVersion({summary: 'one', data: graph(1)});
  const second = await store.addVersion({summary: 'two', data: graph(2)});
  assert.deepEqual((await store.listVersions()).map(v => v.id), [second.id, first.id]);
  await store.deleteVersion(first.id);
  assert.deepEqual((await store.listVersions()).map(v => v.id), [second.id]);
  const third = await store.addVersion({summary: 'three', data: graph(3)});
  await store.deleteVersion([second.id, third.id]);
  assert.deepEqual(await store.listVersions(), []);
});

test('느슨한 파일을 파일명 id로 흡수하고 올바른 파일만 제거', async () => {
  const {store, root} = setup();
  const dir = await root.getDirectoryHandle('변경이력', {create: true});
  const id = '20260101T000000Z_abc123';
  dir.files.set(`${id}.json`, loose(id));
  dir.files.set('20260102T000000Z_bad123.json', JSON.stringify({id: 'bad', data: {nodes: []}}));
  dir.files.set('notes.json', 'leave me');
  const items = await store.listVersions();
  assert.equal(items[0].id, id);
  assert.equal(items[0].data.nodes[0].id, id);
  assert.equal(dir.files.has(`${id}.json`), false);
  assert.equal(dir.files.has('20260102T000000Z_bad123.json'), true);
  assert.equal(dir.files.has('notes.json'), true);
  await store.deleteVersion(id);
  assert.deepEqual(await store.listVersions(), []);
});

test('잘못된 번들은 보존하고 느슨한 파일도 제거하지 않음', async () => {
  const {store, root} = setup();
  const dir = await root.getDirectoryHandle('편집기데이터', {create: true});
  const old = await root.getDirectoryHandle('변경이력', {create: true});
  dir.files.set('변경이력.json', '{broken');
  old.files.set('20260101T000000Z_abc123.json', loose('abc123'));
  await assert.rejects(store.listVersions(), /변경이력\.json/);
  assert.equal(dir.files.get('변경이력.json'), '{broken');
  assert.equal(old.files.has('20260101T000000Z_abc123.json'), true);
});

test('번들 쓰기 실패 시 느슨한 파일을 그대로 둠', async () => {
  const {store, root} = setup();
  const dir = await root.getDirectoryHandle('편집기데이터', {create: true});
  const old = await root.getDirectoryHandle('변경이력', {create: true});
  old.files.set('20260101T000000Z_abc123.json', loose('abc123'));
  dir.failWrite = true;
  await assert.rejects(store.listVersions(), /write failed/);
  assert.equal(old.files.has('20260101T000000Z_abc123.json'), true);
  assert.equal(dir.files.has('변경이력.json'), false);
});

test('느슨한 파일 제거 실패 시 삭제를 취소하고 버전을 되살리지 않음', async () => {
  const {store, root} = setup();
  const id = '20260101T000000Z_abc123';
  const put = async () => { const d = await root.getDirectoryHandle('변경이력', {create: true}); d.files.set(`${id}.json`, loose(id)); return d; };
  await put();
  await store.listVersions();   // 흡수한 뒤 빈 옛 폴더는 지워집니다
  (await put()).failRemove = `${id}.json`;
  await assert.rejects(store.deleteVersion(id), /삭제를 취소/);
  assert.equal((await store.listVersions()).some(item => item.id === id), true);
});

test('동시 추가에서 기록을 잃지 않음', async () => {
  const {store} = setup();
  await Promise.all(Array.from({length: 20}, (_, i) => store.addVersion({summary: String(i), data: graph(i)})));
  assert.equal((await store.listVersions()).length, 20);
});


test('pool round trips data and stores repeated objects once', async () => {
  const {store, root} = setup();
  const data = {nodes: [{id: 'same', nested: {value: 1}}], edges: [], settings: {color: '#fff'}};
  const one = await store.addVersion({summary: 'one', data});
  const two = await store.addVersion({summary: 'two', data: structuredClone(data)});
  const dir = hist(root), bundleName = [...dir.files.keys()].find(name => !/^\d{8}T/.test(name));
  const bundle = JSON.parse(dir.files.get(bundleName));
  assert.equal(bundle.format, 'causal-editor-history');
  assert.deepEqual(bundle.items[0].data.nodes, bundle.items[1].data.nodes);
  assert.equal(bundle.pool.filter(value => JSON.stringify(value) === JSON.stringify(data.nodes[0])).length, 1);
  const expanded = await store.listVersions();
  assert.equal(JSON.stringify(expanded.find(v => v.id === one.id).data), JSON.stringify(data));
  assert.equal(JSON.stringify(expanded.find(v => v.id === two.id).data), JSON.stringify(data));
  expanded.find(v => v.id === one.id).data.nodes[0].nested.value = 9;
  assert.equal(expanded.find(v => v.id === two.id).data.nodes[0].nested.value, 1);
});

test('deleting a version drops unused pool values', async () => {
  const {store, root} = setup();
  const one = await store.addVersion({summary: 'one', data: graph('one')});
  await store.addVersion({summary: 'two', data: graph('two')});
  await store.deleteVersion(one.id);
  const dir = hist(root), bundleName = [...dir.files.keys()].find(name => !/^\d{8}T/.test(name));
  assert.deepEqual(JSON.parse(dir.files.get(bundleName)).pool, [{id: 'two'}]);
});

test('bad pool reference is rejected without rewriting bundle or loose files', async () => {
  const {store, root} = setup();
  await store.addVersion({summary: 'seed', data: graph('seed')});
  const dir = [...root.dirs.values()][0], bundleName = [...dir.files.keys()].find(name => !/^\d{8}T/.test(name));
  const filename = '20260101T000000Z_abc123.json';
  const bundle = {format: 'causal-editor-history', version: 1, pool: [], items: [{id: filename.slice(0,-5), at: '2026', summary: '', data: {nodes: [4], edges: []}}]};
  const raw = JSON.stringify(bundle);
  dir.files.set(bundleName, raw);
  dir.files.set(filename, loose('abc123'));
  await assert.rejects(store.listVersions(), /변경이력\.json/);
  assert.equal(dir.files.get(bundleName), raw);
  assert.equal(dir.files.has(filename), true);
});

test('empty history listing does not create a bundle file', async () => {
  const {store, root} = setup();
  assert.equal((await store.listVersions()).length, 0);
  assert.equal([...root.dirs.values()][0].files.size, 0);
});

test('unchanged listings do not rewrite bundle and conflicting loose files remain', async () => {
  const {store, root} = setup();
  const saved = await store.addVersion({summary: 'kept', data: graph('original')});
  const dir = hist(root), writes = dir.writeCount;
  await store.listVersions();
  await store.listVersions();
  assert.equal(dir.writeCount, writes);
  const filename = saved.id + '.json';
  const old = await root.getDirectoryHandle('변경이력', {create: true});
  old.files.set(filename, JSON.stringify({id: saved.id, at: saved.at, summary: saved.summary, data: graph('different')}));
  await store.listVersions();
  assert.equal(old.files.has(filename), true);
  await assert.rejects(store.deleteVersion(saved.id));
  assert.equal((await store.listVersions()).some(item => item.id === saved.id), true);
  assert.equal(old.files.has(filename), true);
});


test('legacy graph is copied, verified, and removed', async () => {
  const {store, root} = setup(); const old = await root.getDirectoryHandle('내부데이터', {create:true}); old.files.set('그래프.json', JSON.stringify(graph('old')));
  assert.equal(JSON.stringify(await store.readGraph()), JSON.stringify({ok:true, data:graph('old')}));
  assert.equal(root.dirs.has('내부데이터'), false); assert.equal(root.dirs.get('편집기데이터').files.has('그래프.json'), true);
});

test('new graph wins over differing legacy graph; broken legacy is kept and tolerated', async () => {
  const {store, root} = setup(); const current=await root.getDirectoryHandle('편집기데이터',{create:true}); current.files.set('그래프.json',JSON.stringify(graph('new'))); const old=await root.getDirectoryHandle('내부데이터',{create:true}); old.files.set('그래프.json',JSON.stringify(graph('old')));
  assert.equal(JSON.stringify(await store.readGraph()), JSON.stringify({ok:true,data:graph('new')})); assert.equal(old.files.has('그래프.json'),true);
  current.files.delete('그래프.json'); old.files.set('그래프.json','{broken'); assert.equal(JSON.stringify(await store.readGraph()), JSON.stringify({ok:true,data:null})); assert.equal(old.files.get('그래프.json'),'{broken');
});

test('legacy loose history is absorbed and empty folder removed; nonempty folder remains', async () => {
  const {store,root}=setup(); const old=await root.getDirectoryHandle('변경이력',{create:true}); old.files.set('20260101T000000Z_legacy.json',loose('legacy'));
  assert.equal((await store.listVersions())[0].id,'20260101T000000Z_legacy'); assert.equal(root.dirs.has('변경이력'),false); assert.equal(root.dirs.get('편집기데이터').files.has('변경이력.json'),true);
  const another=await root.getDirectoryHandle('변경이력',{create:true}); another.files.set('invalid.json','keep'); await store.listVersions(); assert.equal(root.dirs.get('변경이력'),another); assert.equal(another.files.has('invalid.json'),true);
});

test('no legacy data creates no legacy folders', async () => {
  const {store,root}=setup(); assert.equal(JSON.stringify(await store.readGraph()),JSON.stringify({ok:true,data:null})); assert.equal(JSON.stringify(await store.listVersions()),"[]"); assert.equal(root.dirs.has('내부데이터'),false); assert.equal(root.dirs.has('변경이력'),false);
});

test('옛 폴더의 파일 삭제에 실패하면 어떤 경로로 삭제해도 되살아나지 않음', async () => {
  const {store, root} = setup(); const old = await root.getDirectoryHandle('변경이력', {create: true});
  const id = '20260101T000000Z_stuck1', name = id + '.json';
  old.files.set(name, loose('stuck1'));
  old.removeEntry = async () => { throw Error('remove failed'); };
  await store.listVersions();
  await assert.rejects(store.deleteVersion(id), /삭제를 취소/);
  assert.equal((await store.listVersions()).some(v => v.id === id), true);
});

test('같은 내용의 옛 그래프 파일은 지움', async () => {
  const {store, root} = setup(); const text = JSON.stringify(graph('same'));
  (await root.getDirectoryHandle('편집기데이터', {create: true})).files.set('그래프.json', text);
  (await root.getDirectoryHandle('내부데이터', {create: true})).files.set('그래프.json', text);
  await store.readGraph();
  assert.equal(root.dirs.has('내부데이터'), false);
});

test('읽기 없이 먼저 저장해도 옛 그래프 파일을 옮김', async () => {
  const {store, root} = setup();
  (await root.getDirectoryHandle('내부데이터', {create: true})).files.set('그래프.json', JSON.stringify(graph('old')));
  await store.writeGraph(graph('new'));
  assert.equal(root.dirs.has('내부데이터'), false);
  assert.equal(JSON.stringify((await store.readGraph()).data), JSON.stringify(graph('new')));
});
