const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appDir = fs.readdirSync(path.join(__dirname, '..')).find(name => fs.existsSync(path.join(__dirname, '..', name, 'app.js')));
const app = fs.readFileSync(path.join(__dirname, '..', appDir, 'app.js'), 'utf8');
const declaration = app.match(/function visibleSets\(\) \{[\s\S]*?\n\}/)?.[0];
assertDeclaration(declaration);
function assertDeclaration(value) { if (!value) throw new Error('visibleSets declaration not found'); }

test('status view excludes nonmatching nodes and every touching edge', () => {
  const nodes = [{id: 'a', status: 'completed'}, {id: 'b', status: 'stopped'}, {id: 'c', status: 'completed'}];
  const edges = [{id: 'ab', from: 'a', to: 'b'}, {id: 'ac', from: 'a', to: 'c'}, {id: 'bc', from: 'b', to: 'c'}];
  const context = vm.createContext({
    S: {nodes, edges},
    node: id => nodes.find(item => item.id === id),
    edge: id => edges.find(item => item.id === id),
    pushTo: (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); },
    focusMode: false, focusNodeId: null, focusCreatedNodeIds: new Set(), focusCreatedEdgeIds: new Set(),
    sel: {type: null, id: null}, connMode: false, connNodeId: null, connDepth: 1, connCreatedIds: new Set(),
    connActive: () => false, statusFilter: 'completed', statusCreatedNodeIds: new Set()
  });
  const visible = vm.runInContext(`(${declaration})()`, context);
  assert.deepEqual([...visible.visibleNodeIds], ['a', 'c']);
  assert.deepEqual([...visible.visibleEdgeIds], ['ac']);
});

