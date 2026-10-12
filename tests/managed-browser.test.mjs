import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { ManagedBrowserObservation } from '../src/server/managed-browser-observation.mjs';

const session = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const snapshot = () => ({ protocol: 1, op: 'inventory', session, sequence: 0, revision: 0,
  windows: [{ tabId: 1, windowId: 2, incognito: false, discarded: false, foreignFrames: 0,
    frames: [{ frameId: 0, parentFrameId: -1, documentId, active: true }] }] });
test('native browser observer is bounded, immutable, monotonic and never grants full inventory or installation', () => {
  let now = 0; const observation = new ManagedBrowserObservation({ now: () => now }); const input = snapshot();
  const status = observation.accept(input); assert.equal(status.tabs, 1); assert.equal(status.unknown, false);
  input.windows.length = 0; assert.equal(observation.status().tabs, 1);
  assert.equal(status.inventoryVerified, false); assert.equal(status.profileOnly, true); assert.equal(status.installAllowed, false);
  assert.throws(() => observation.accept(snapshot()), /report_stale/);
  now = 6001; assert.equal(observation.status().unknown, true); assert.equal(observation.status().tabs, 1, 'expired heartbeat does not erase a window');
  const next = { ...snapshot(), sequence: 1, revision: 1, windows: [] }; observation.accept(next);
  assert.equal(observation.status().inventoryVerified, false, 'zero Chrome tabs is not global inventory proof');
});
test('changed document topology without epoch revision, duplicate frames and self-reported tasks are rejected', () => {
  const observation = new ManagedBrowserObservation(); observation.accept(snapshot());
  const changed = snapshot(); changed.sequence = 1; changed.windows[0].tabId = 3;
  assert.throws(() => observation.accept(changed), /topology_invalid/);
  changed.revision = 1; changed.windows[0].frames.push({ ...changed.windows[0].frames[0] });
  assert.throws(() => observation.accept(changed), /report_invalid/);
  assert.throws(() => observation.accept({ ...snapshot(), sequence: 1, counts: { canvas: 0 } }), /report_invalid/);
  assert.throws(() => observation.accept({ ...snapshot(), sequence: 1, session: '33333333-3333-4333-8333-333333333333' }), /report_stale/);
});
test('incognito/discarded, missing document ids, foreign frames and explicit unknown all remain blocked', () => {
  for (const edit of [v => { v.windows[0].incognito = true; }, v => { v.windows[0].discarded = true; },
    v => { v.windows[0].foreignFrames = 1; }, v => { v.windows[0].frames[0].active = false; }, v => { v.windows[0].frames[0].documentId = null; }]) {
    const value = snapshot(); edit(value); assert.equal(new ManagedBrowserObservation().accept(value).unknown, true);
  }
  const observation = new ManagedBrowserObservation(); observation.accept({ protocol: 1, op: 'unknown', session, sequence: 0, revision: 0 });
  assert.equal(observation.status().unknown, true);
});
function frame(value) { const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]); }
test('real native messaging process accepts bounded stdio inventory only; no exec/install/path operation or credentials', () => {
  const entry = fileURLToPath(new URL('../scripts/run-browser-bridge.mjs', import.meta.url)), origin = 'chrome-extension://' + 'a'.repeat(32) + '/';
  const result = spawnSync(process.execPath, [entry, origin], { input: frame(snapshot()), maxBuffer: 8192, timeout: 3000 });
  assert.equal(result.status, 0); const size = result.stdout.readUInt32LE(), value = JSON.parse(result.stdout.subarray(4, size + 4));
  assert.equal(value.tabs, 1); assert.equal(value.installAllowed, false); assert.ok(!result.stdout.toString().includes(documentId));
  for (const input of [frame({ op: 'exec', command: 'arbitrary' }), frame({ ...snapshot(), token: 'not-a-real-token' }), Buffer.from([255, 255, 255, 255])]) {
    const bad = spawnSync(process.execPath, [entry, origin], { input, maxBuffer: 8192, timeout: 3000 });
    assert.equal(bad.status, 1); assert.equal(bad.stdout.length, 0);
  }
  const badOrigin = spawnSync(process.execPath, [entry, 'http://127.0.0.1:8888'], { input: frame(snapshot()), timeout: 3000 }); assert.equal(badOrigin.status, 1);
});
test('actual extension uses existing-profile fixed Origin, filtered Chrome inventory and strips unrelated URL/title/content', async () => {
  const sent = [], queries = [], created = [], badges = []; let timer, onReply;
  let frameDocument = documentId.replaceAll('-', '').toUpperCase();
  const event = () => ({ addListener() {} });
  const native = { postMessage: value => sent.push(value), onMessage: { addListener: fn => { onReply = fn; } }, onDisconnect: event() };
  const chrome = { tabs: { onCreated: event(), onRemoved: event(), onReplaced: event(), onUpdated: event(),
    query: async input => { queries.push(input); return [{ id: 1, windowId: 2, url: 'http://127.0.0.1:8888/private?key=not-a-real-key', title: 'private title' }]; } },
    webNavigation: { onCommitted: event(), onHistoryStateUpdated: event(), onErrorOccurred: event(), getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: frameDocument, documentLifecycle: 'active', url: 'http://127.0.0.1:8888/private' }, { frameId: 1, parentFrameId: 0, url: 'https://example.invalid/private' }] },
    action: { setBadgeText: async value => { badges.push(value.text); }, setBadgeBackgroundColor: async () => {}, onClicked: event() },
    windows: { create: async value => created.push(value) }, runtime: { connectNative: name => { assert.equal(name, 'com.guanaiworkbench.browser'); return native; }, onConnect: event(), onStartup: event(), onInstalled: event() } };
  const context = vm.createContext({ chrome, crypto: webcrypto, URL, TextEncoder, setInterval: fn => { timer = fn; return 1; }, clearInterval() {} });
  vm.runInContext(readFileSync(new URL('../browser/managed-workbench/background.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1); assert.equal(queries[0].url, 'http://127.0.0.1:8888/*');
  assert.equal(sent[0].windows[0].foreignFrames, 1); assert.equal(sent[0].windows[0].frames.length, 1);
  assert.equal(sent[0].windows[0].frames[0].documentId, documentId, 'actual Chrome hex UUID format is canonicalized before the native bridge');
  assert.doesNotMatch(JSON.stringify(sent), /private|example.invalid|title|not-a-real-key/);
  const observed = new ManagedBrowserObservation().accept(JSON.parse(JSON.stringify(sent[0])));
  assert.equal(observed.installAllowed, false);
  onReply(observed); await new Promise(resolve => setImmediate(resolve));
  assert.equal(badges.at(-1), '?', 'unknown frames do not display a blue valid-inventory count');
  timer(); await new Promise(resolve => setImmediate(resolve)); assert.equal(sent.length, 2);
  for (const invalid of ['-', '2'.repeat(31), '2'.repeat(33), '22-222222222222222222222222222222', 'g'.repeat(32)]) {
    frameDocument = invalid; timer(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.at(-1).windows[0].frames[0].documentId, null, 'malformed identities become explicit unknown, never a fabricated document');
    assert.equal(new ManagedBrowserObservation().accept(JSON.parse(JSON.stringify(sent.at(-1)))).unknown, true);
  }
  const manifest = JSON.parse(readFileSync(new URL('../browser/managed-workbench/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:8888/*', 'http://127.0.0.1:5174/*']); assert.ok(!manifest.permissions.includes('tabs'));
  assert.deepEqual(manifest.content_scripts, [{ matches: ['http://127.0.0.1:8888/*', 'http://127.0.0.1:5174/*'], js: ['page-relay.js'], all_frames: true, run_at: 'document_start', world: 'ISOLATED' }]);
  assert.ok(!manifest.externally_connectable);
});
