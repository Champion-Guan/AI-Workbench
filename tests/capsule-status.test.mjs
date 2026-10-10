import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/shared/data-contract/index.js', import.meta.url), 'utf8');
const start = source.indexOf('function readCanvasCapsuleStatus(');
const end = source.indexOf('\nfunction renderHeaderControls(', start);
const read = vm.runInNewContext(`${source.slice(start, end)}; readCanvasCapsuleStatus`);
function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}
const publish = (store, status, startedAt = 1, updatedAt = 1) => store.setItem('guan-canvas-status:p', JSON.stringify({ status, taskId: 'n', startedAt, updatedAt }));
test('opening a notified canvas clears status after switching away and reloading', () => {
  for (const status of ['success', 'error']) {
    const store = storage();
    publish(store, status);
    assert.equal(read('p', false, store), status);
    assert.equal(read('p', true, store), 'idle');
    assert.equal(read('p', false, store), 'idle');
    publish(store, status, 1, 100);
    assert.equal(read('p', false, store), 'idle');
  }
});
test('viewing an ongoing task never hides its indicator after switching away', () => {
  const store = storage();
  publish(store, 'loading');
  assert.equal(read('p', true, store), 'loading');
  assert.equal(read('p', false, store), 'loading');
  store.setItem('guan-canvas-status-seen:p', JSON.stringify(['loading', 'n', 1]));
  assert.equal(read('p', false, store), 'loading');
});
test('a new task or task transition can notify again', () => {
  const store = storage();
  publish(store, 'loading');
  read('p', true, store);
  publish(store, 'success');
  assert.equal(read('p', false, store), 'success');
  read('p', true, store);
  publish(store, 'success', 2);
  assert.equal(read('p', false, store), 'success');
});
test('a task completing in the open canvas stays colored until the canvas is reopened', () => {
  const store = storage();
  publish(store, 'loading');
  read('p', true, store);
  publish(store, 'error');
  assert.equal(read('p', true, store, true, false), 'error');
  publish(store, 'success', 2);
  assert.equal(read('p', true, store, true, false), 'success');
  assert.equal(read('p', true, store), 'idle');
});
test('a hidden window does not acknowledge and other products remain untouched', () => {
  const store = storage();
  publish(store, 'error');
  read('p', true, store, false);
  assert.equal(read('p', false, store), 'error');
  read('other', true, store);
  assert.equal(read('p', false, store), 'error');
});
test('legacy payloads and unavailable or malformed storage are safe', () => {
  const store = storage();
  store.setItem('guan-canvas-status:p', JSON.stringify({ status: 'success' }));
  read('p', true, store);
  assert.equal(read('p', false, store), 'idle');
  store.setItem('guan-canvas-status:p', '{');
  assert.equal(read('p', false, store), 'idle');
  assert.equal(read('p', true, { getItem() { throw Error('denied'); } }), 'idle');
});
