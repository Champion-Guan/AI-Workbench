import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreBrowserStorage } from '../src/shared/data-contract/port-migration.mjs';
function setup(session = {}) {
  const storage = values => {
    const entries = new Map(Object.entries(values));
    return { get length() { return entries.size; }, key: n => [...entries.keys()][n],
      getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  };
  globalThis.location = { origin: 'http://127.0.0.1:8888' };
  globalThis.localStorage = storage({}); globalThis.sessionStorage = storage(session);
  globalThis.indexedDB = { databases: async () => [] };
  return { app: 'guan-ai-workbench', kind: 'full-browser-backup', format: 1,
    origin: 'http://127.0.0.1:5174', databases: [], localStorage: { canvas: 'saved' },
    sessionStorage: { __imt_handshake_page_id: 'source-page', client: 'saved-client' } };
}
test('extension handshake does not prevent empty destination migration or get overwritten', async () => {
  const snapshot = setup({ __imt_handshake_page_id: 'destination-page' });
  await restoreBrowserStorage(snapshot);
  assert.equal(sessionStorage.getItem('__imt_handshake_page_id'), 'destination-page');
  assert.equal(sessionStorage.getItem('client'), 'saved-client');
  assert.equal(localStorage.getItem('canvas'), 'saved');
  await assert.rejects(restoreBrowserStorage(snapshot), /已有数据/);
});
test('any existing business session still refuses before writing', async () => {
  const snapshot = setup({ __imt_handshake_page_id: 'page', client: 'existing-client' });
  await assert.rejects(restoreBrowserStorage(snapshot), /已有数据/);
  assert.equal(localStorage.length, 0); assert.equal(sessionStorage.getItem('client'), 'existing-client');
});
test('existing local configuration still refuses even with only extension session', async () => {
  const snapshot = setup({ __imt_handshake_page_id: 'page' }); localStorage.setItem('canvas', 'existing');
  await assert.rejects(restoreBrowserStorage(snapshot), /已有数据/);
  assert.equal(localStorage.getItem('canvas'), 'existing');
});
