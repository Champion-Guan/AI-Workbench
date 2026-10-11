import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { BrowserActivityReports } from '../src/server/browser-activity.mjs';
import { createPersistenceFixture } from './helpers/persistence-checkpoint.mjs';
import { journalFixture } from './helpers/remote-task-journal.mjs';

function load(file, bindings = {}, expose = '') {
  const source = readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/\bexport /g, '');
  const context = vm.createContext({ setTimeout, clearTimeout, Headers, Blob, TextEncoder, btoa, AbortSignal, AbortController, ...bindings });
  vm.runInContext(ts.transpileModule(body + '\n' + expose, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context;
}
function registry() { return load('lib/update-activity.ts', {}, 'globalThis.registry = new FrontendActivityRegistry();').registry; }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('activity leases begin synchronously, preserve results/errors, tolerate observers and release only once', async () => {
  const r = registry();
  r.subscribe(() => { throw Error('observer failure'); });
  const release = r.acquire('storage');
  assert.equal(r.snapshot().storage, 1);
  const copy = r.snapshot(); copy.storage = 999;
  assert.equal(r.snapshot().storage, 1);
  release(); release();
  assert.equal(r.snapshot().storage, 0);
  const body = deferred();
  const running = r.run('canvas', () => body.promise);
  assert.equal(r.snapshot().canvas, 1);
  body.resolve('unchanged result');
  assert.equal(await running, 'unchanged result');
  const failure = Error('business error');
  await assert.rejects(r.run('canvas', () => { throw failure; }), error => error === failure);
  assert.equal(r.snapshot().canvas, 0);
});

test('one parallel rejection does not erase unfinished sibling operations', async () => {
  const r = registry(), slow = deferred();
  const sibling = r.run('webdav', () => slow.promise);
  await assert.rejects(r.run('webdav', () => Promise.all([sibling, r.run('webdav', () => Promise.reject(Error('failed')))])));
  assert.equal(r.snapshot().webdav, 1);
  slow.resolve(); await sibling;
  assert.equal(r.snapshot().webdav, 0);
});

test('disabled lifecycle preserves synchronous callbacks and completion failures cannot rewrite business success', async () => {
  const r = registry(); let changed = false;
  const plain = r.run('storage', () => { changed = true; return 'saved'; });
  assert.equal(changed, true); assert.equal(await plain, 'saved');
  const remove = r.setLifecycle({ begin: () => null, complete: () => { throw Error('lost acknowledgement'); } });
  changed = false;
  const guarded = r.runNetwork('storage', () => { changed = true; return 'saved'; });
  assert.equal(changed, true); assert.equal(await guarded, 'saved');
  assert.equal(r.snapshot().storage, 0); remove();
  const pending = deferred(); let called = false;
  r.setLifecycle({ begin: () => pending.promise, complete: () => {} });
  const write = r.runNetwork('canvas', () => { called = true; return 'generated'; });
  assert.equal(called, false); pending.reject(Error('cannot record intent'));
  await assert.rejects(write, /cannot record intent/); assert.equal(called, false);
  assert.equal(r.snapshot().canvas, 0);
});

test('explicit storage adapter preserves receivers, generic/callback arguments and failed writes', async () => {
  const r = registry(), pending = deferred();
  const backend = {
    marker: 'original receiver',
    getItem(key) { assert.equal(this, backend); return Promise.resolve(key); },
    setItem(key, value, callback) { assert.equal(this, backend); assert.equal(key, 'key'); callback(null, value); return pending.promise; },
    removeItem() { assert.equal(this, backend); return Promise.reject(Error('disk full')); },
  };
  const persistence = createPersistenceFixture();
  const ctx = load('lib/activity-storage.ts', { ...persistence, observeActivity: (domain, fn) => r.run(domain, fn) });
  const store = ctx.observeStorageWrites(backend);
  let callbackValue;
  const result = store.setItem('key', { id: 1 }, (_error, value) => { callbackValue = value; });
  assert.equal(callbackValue.id, 1);
  assert.equal(r.snapshot().storage, 1);
  assert.equal(await store.getItem('read'), 'read');
  assert.equal(r.snapshot().storage, 1, 'reads do not change mutation counts');
  pending.resolve('saved'); assert.equal(await result, 'saved');
  await assert.rejects(store.removeItem('key'), /disk full/);
  assert.equal(r.snapshot().storage, 0);
  await assert.rejects(persistence.flushStorageCheckpoints(), /incomplete/);
});

test('Agent JSON request remains busy while the response body is still being read', async () => {
  const r = registry(), body = deferred();
  const ctx = load('services/api/canvas-agent.ts', {
    observeActivity: (domain, fn) => r.run(domain, fn), i18n: { t: key => key },
    fetch: async () => ({ ok: true, json: () => body.promise }),
  });
  const request = ctx.fetchAgentJson('http://example.invalid', 'fixture', '/task');
  await tick();
  assert.equal(r.snapshot().agent, 1);
  body.resolve({ ok: true }); await request;
  assert.equal(r.snapshot().agent, 0);
});

function durableAgentFixture() {
  const r = registry(), durable = journalFixture(r, { domain: 'agent', namespace: 'agent' });
  let response = {}, failure;
  const ctx = load('services/api/canvas-agent.ts', {
    observeActivity: (domain, fn) => r.run(domain, fn), remoteAgentJournal: durable.journal, crypto: webcrypto, i18n: { t: key => key },
    fetch: async () => { if (failure) throw failure; return { ok: true, json: async () => response }; },
  });
  return { r, durable, ctx, response: value => { response = value; }, failure: value => { failure = value; },
    create: (token = 'fixture-token', messageId = 'fixture-message') => ctx.fetchAgentJson('http://example.invalid', token, '/agent/codex/turn', { method: 'POST', body: JSON.stringify({ messageId, prompt: 'private user text' }) }),
    history: (token = 'fixture-token') => ctx.fetchAgentJson('http://example.invalid', token, '/agent/codex/threads/fixture-thread') };
}
test('Agent pre-request journal survives response loss and HTTP accepted/ready never clears it', async () => {
  const f = durableAgentFixture(); f.failure(Error('lost accepted response'));
  await assert.rejects(f.create(), /lost accepted response/); assert.equal(f.r.snapshot().agent, 1);
  assert.equal(f.durable.rows.size, 1); assert.ok(!JSON.stringify([...f.durable.rows]).includes('fixture-token'));
  assert.ok(!JSON.stringify([...f.durable.rows]).includes('private user text'));
  const cold = registry(), restored = journalFixture(cold, { rows: f.durable.rows, domain: 'agent', namespace: 'agent' });
  restored.journal.restore(); assert.equal(cold.snapshot().agent, 1);
  f.failure(undefined); f.response({ ok: true, conversation: { status: 'ready' }, messages: [], settledTurnIds: [] });
  await f.history(); assert.equal(f.r.snapshot().agent, 1);
});
test('only explicit settled history with correlated user message releases the matching Agent account', async () => {
  const f = durableAgentFixture(); await f.create();
  const history = { ok: true, settledTurnIds: ['turn-1'], messages: [{ role: 'user', turnId: 'turn-1', clientMessageId: 'fixture-message' }] };
  f.response({ ...history, messages: [{ ...history.messages[0], role: 'assistant' }] }); await f.history(); assert.equal(f.r.snapshot().agent, 1);
  f.response({ ...history, settledTurnIds: [] }); await f.history(); assert.equal(f.r.snapshot().agent, 1);
  f.response(history); await f.history('different-fixture-account'); assert.equal(f.r.snapshot().agent, 1);
  await f.history(); assert.equal(f.r.snapshot().agent, 0); assert.equal(f.durable.rows.size, 0);
});
test('never-used/unconnected Agent has no durable blocker and invalid request identity does not dispatch', async () => {
  const f = durableAgentFixture(); f.durable.journal.restore(); assert.equal(f.r.snapshot().agent, 0);
  await f.ctx.fetchAgentJson('http://example.invalid', 'fixture-token', '/agent/codex/models'); assert.equal(f.r.snapshot().agent, 0);
  await assert.rejects(f.create('fixture-token', ''), /请求标识/); assert.equal(f.durable.rows.size, 0);
});

test('WebDAV download holds a lease after headers and even after body timeout until settlement', async () => {
  const r = registry(), body = deferred();
  const timers = new Map(); let next = 0;
  const ctx = load('services/webdav-sync.ts', {
    observeActivity: (domain, fn) => r.run(domain, fn), i18n: { t: key => key }, withLocalProxy: url => url,
    window: { setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } },
    fetch: async () => ({ status: 200, ok: true, blob: () => body.promise }),
  });
  const request = ctx.downloadWebdavFile({ url: 'http://example.invalid', directory: '' }, 'image.png');
  const rejected = assert.rejects(request, /downloadTimeout/);
  await tick();
  assert.equal(r.snapshot().webdav, 2, 'outer operation and in-flight body');
  for (const fn of timers.values()) fn();
  await rejected;
  assert.equal(r.snapshot().webdav, 1, 'timeout is not proof the underlying body stopped');
  body.resolve(new Blob(['image'])); await tick();
  assert.equal(r.snapshot().webdav, 0);
});

test('browser observations retain stale pages and reject forged, incomplete, out-of-order and oversized counts', () => {
  let now = 0;
  const reports = new BrowserActivityReports({ now: () => now, maxPages: 2 });
  const payload = { protocol: 1, pageId: '11111111-1111-4111-8111-111111111111', sequence: 0,
    counts: { canvas: 1, workbench: 0, agent: 0, webdav: 0, storage: 0 } };
  reports.accept(payload);
  payload.counts.canvas = 0;
  assert.equal(reports.status().counts.canvas, 1, 'copy reports before storing');
  assert.throws(() => reports.accept(payload), /Stale/);
  assert.throws(() => reports.accept({ ...payload, pageId: '-'.repeat(36), sequence: 1 }), /Invalid/);
  assert.throws(() => reports.accept({ ...payload, sequence: 1, canInstall: true }), /Invalid/);
  assert.throws(() => reports.accept({ ...payload, sequence: 1, counts: { canvas: 0 } }), /Invalid/);
  assert.throws(() => reports.accept({ ...payload, sequence: 1, counts: { ...payload.counts, storage: -1 } }), /Invalid/);
  assert.throws(() => reports.accept({ ...payload, sequence: 1, counts: { ...payload.counts, storage: 1000001 } }), /Invalid/);
  now = 15001;
  assert.equal(reports.status().stalePages, 1);
  assert.equal(reports.status().counts.canvas, 1, 'no TTL garbage collection can erase a busy page');
  assert.equal(reports.status().inventoryVerified, false);
  reports.accept({ ...payload, sequence: 1 });
  assert.equal(reports.status().stalePages, 0);
  assert.equal(reports.status().counts.canvas, 0);
  reports.accept({ ...payload, pageId: '22222222-2222-4222-8222-222222222222' });
  assert.throws(() => reports.accept({ ...payload, pageId: '33333333-3333-4333-8333-333333333333' }), /capacity/);
});

test('reporter observes Agent/task lifetimes without resetting on disconnect, truncation or unload', async () => {
  const r = registry();
  function store(initial) {
    let state = initial; const listeners = new Set();
    return { getState: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      set(next) { state = next; for (const fn of listeners) fn(state); } };
  }
  const idle = { sending: false, waiting: false, pendingTool: null, pendingApprovals: [], connected: false, conversation: { status: 'idle' } };
  const agent = store(idle), tasks = store({ tasks: [] }), canvasSave = store({ status: 'saved' });
  const reports = [], events = new Map(), intervals = new Set(), timers = new Map();
  let nextTimer = 0;
  const flushTimers = () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); };
  const ctx = load('services/update-activity-reporter.ts', {
    frontendActivity: r, remoteVideoJournal: journalFixture(r).journal,
    remoteAgentJournal: journalFixture(r, { domain: 'agent', namespace: 'agent' }).journal,
    useAgentStore: agent, useWorkbenchAgentStore: tasks, useCanvasSaveStore: canvasSave, crypto: webcrypto,
    window: { setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); },
      setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
      addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } },
    fetch: async (_url, init) => { reports.push(JSON.parse(init.body)); return { text: async () => '' }; },
  });
  const stop = ctx.startUpdateActivityReporter();
  await tick();
  canvasSave.set({ status: 'saving' });
  assert.equal(r.snapshot().storage, 1);
  canvasSave.set({ status: 'error' });
  assert.equal(r.snapshot().storage, 1, 'failed canvas persistence is not safe idle');
  canvasSave.set({ status: 'saved' });
  assert.equal(r.snapshot().storage, 0);
  agent.set({ ...idle, connected: true, conversation: { status: 'running' } });
  assert.equal(r.snapshot().agent, 1);
  agent.set(idle);
  assert.equal(r.snapshot().agent, 1, 'disconnect cannot prove remote completion');
  agent.set({ ...idle, connected: true, conversation: { status: 'ready' } });
  assert.equal(r.snapshot().agent, 0);
  tasks.set({ tasks: [{ id: 'job', status: 'queued' }] });
  assert.equal(r.snapshot().workbench, 1);
  tasks.set({ tasks: [] });
  assert.equal(r.snapshot().workbench, 1, 'truncated history must not erase unresolved tasks');
  tasks.set({ tasks: [{ id: 'job', status: 'succeeded' }] });
  assert.equal(r.snapshot().workbench, 0);
  assert.equal(timers.size, 1, 'bursty activity changes coalesce into one report');
  flushTimers();
  await tick();
  assert.ok(reports.length > 1);
  assert.ok(reports.every(item => Object.keys(item).sort().join(',') === 'counts,pageId,protocol,sequence'));
  assert.ok(reports.every((item, index) => index === 0 || item.sequence > reports[index - 1].sequence));
  tasks.set({ tasks: [{ id: 'unfinished', status: 'running' }] });
  flushTimers();
  stop(); await tick();
  const last = reports.at(-1);
  assert.equal(last.counts.workbench, 1, 'no fake zero-count shutdown report');
  assert.equal(intervals.size, 0);
  assert.equal(events.size, 0);
  assert.equal(timers.size, 0);
});
