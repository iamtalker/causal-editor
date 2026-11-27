const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync(require('node:path').join(__dirname, '../크롬확장/app.js'), 'utf8');
const declaration = app.match(/function normalizeAutoInterval\(hours, minutes\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(declaration, '정규화 함수 선언을 찾음');
const normalize = vm.runInNewContext(`(() => { const AUTO_HOURS_DEFAULT = 24, AUTO_HOURS_MAX = 720; ${declaration}; return normalizeAutoInterval; })()`);

test('자동 저장 간격을 분 단위로 정규화', () => {
  assert.deepEqual({...normalize('', '')}, {hours: 24, minutes: 0});
  assert.deepEqual({...normalize('0', '0')}, {hours: 0, minutes: 1});
  assert.deepEqual({...normalize('0', '25')}, {hours: 0, minutes: 25});
  assert.deepEqual({...normalize('x', '25')}, {hours: 0, minutes: 25});
  assert.deepEqual({...normalize('2', '59')}, {hours: 2, minutes: 59});
  assert.deepEqual({...normalize('720', '59')}, {hours: 720, minutes: 0});
  assert.deepEqual({...normalize('-1', '0')}, {hours: 0, minutes: 1});
  assert.deepEqual({...normalize('1.5', '2')}, {hours: 0, minutes: 2});
});
