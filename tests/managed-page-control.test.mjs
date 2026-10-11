import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';

const session = '11111111-1111-4111-8111-111111111111', epoch = '22222222-2222-4222-8222-222222222222';
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const activity = createActivityFixture(), context = vm.createContext({ AbortController, barrier: activity.barrier, activity: activity.registry, session });
  vm.runInContext(compile(source('src/canvas/lib/managed-page-control.ts') + '\nglobalThis.control = new ManagedPageControl(session, barrier, activity);'), context);
  let sequence = 0;
  return { ...activity, context, control: context.control,
    request: (op, requestEpoch = op === 'probe' ? null : epoch) => context.control.accept({ protocol: 1, session, sequence: sequence++, op, epoch: requestEpoch }) };
}
test('managed page pause drains real old task children and storage; local acknowledgement never permits installation', async () => {
  const f = fixture(), task = deferred(), save = deferred();
  f.barrier.registerFlush(() => save.promise);
  const running = f.runTaskActivity('canvas', async scope => { await task.promise; await scope.runChild('storage', async () => {}); });
  const paused = f.request('pause');
  await assert.rejects(f.runTaskActivity('canvas', async () => { throw Error('must not start'); }), /quiescing/);
  const probe = await f.request('probe'); assert.equal(probe.phase, 'draining'); assert.equal(probe.counts.canvas, 1);
  task.resolve(); await running; await tick(); assert.equal(f.registry.snapshot().storage, 1);
  save.resolve(); const reply = await paused;
  assert.equal(reply.phase, 'paused'); assert.equal(reply.acknowledged, true);
  assert.equal(reply.installAllowed, false); assert.equal(reply.fullRootCoverage, false);
  assert.equal((await f.request('assert')).acknowledged, true);
  const release = f.registry.acquire('storage'); release();
  assert.equal((await f.request('assert')).acknowledged, false, 'zero-count ABA invalidates acknowledgement');
  await f.request('resume'); f.control.dispose(); f.barrier.dispose();
});
test('matching resume can overtake a pending drain but never cancels the actual business request', async () => {
  const f = fixture(), finished = deferred(); let completed = false;
  const running = f.runTaskActivity('canvas', async () => { await finished.promise; completed = true; });
  const paused = f.request('pause'); await f.request('resume');
  assert.equal((await paused).acknowledged, false); assert.equal(completed, false); assert.equal(f.registry.snapshot().canvas, 1);
  assert.equal(await f.runTaskActivity('canvas', async () => 7), 7);
  finished.resolve(); await running; assert.equal(completed, true);
  f.control.dispose(); f.barrier.dispose();
});
test('failed flush, wrong epoch, disconnect and lifecycle changes do not resume roots or preserve acknowledgements', async () => {
  const f = fixture(); let fail = true;
  f.barrier.registerFlush(async () => { if (fail) throw Error('private storage error must not leak'); });
  const reply = await f.request('pause'); assert.equal(reply.phase, 'blocked'); assert.equal(reply.error, 'managed_page_flush_unconfirmed');
  assert.doesNotMatch(JSON.stringify(reply), /private storage/);
  assert.equal((await f.request('resume', session)).error, 'managed_page_epoch_mismatch');
  await assert.rejects(f.runTaskActivity('canvas', async () => {}), /quiescing/);
  await f.request('resume'); fail = false;
  assert.equal((await f.request('pause')).acknowledged, true);
  f.control.invalidate(); assert.equal((await f.request('assert')).acknowledged, false);
  f.control.dispose(); await assert.rejects(f.runTaskActivity('canvas', async () => {}), /quiescing/);
  f.barrier.dispose();
});
test('controller rejects unknown operations, credentials, replay and foreign session before touching the barrier', async () => {
  const f = fixture(), request = { protocol: 1, session, sequence: 0, op: 'probe', epoch: null };
  for (const bad of [{ ...request, token: 'not-a-real-token' }, { ...request, op: 'install' }, { ...request, session: epoch }, { ...request, sequence: 3 }, { ...request, op: 'pause' }]) {
    await assert.rejects(f.control.accept(bad), /request_invalid/);
  }
  assert.equal(await f.runTaskActivity('canvas', async () => 9), 9);
  assert.equal((await f.control.accept(request)).phase, 'active');
  await assert.rejects(f.control.accept(request), /request_invalid/);
  f.control.dispose(); f.barrier.dispose();
});
test('dispose during a persistence flush waits for the actual write and never acknowledges or reopens roots', async () => {
  const f = fixture(), saving = deferred(); let persisted = false;
  f.barrier.registerFlush(async () => { await saving.promise; persisted = true; });
  const paused = f.request('pause'); await tick(); f.control.dispose();
  assert.equal(f.registry.snapshot().storage, 1); assert.equal(persisted, false);
  saving.resolve(); const reply = await paused; assert.equal(persisted, true); assert.equal(reply.acknowledged, false);
  await assert.rejects(f.runTaskActivity('canvas', async () => {}), /quiescing/); f.barrier.dispose();
});
test('actual app relay uses a bounded MessagePort, fixed Origin and exact handshake; no window install/commands', async t => {
  const f = fixture(), listeners = new Map();
  const window = { location: { origin: 'http://127.0.0.1:5174' }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name), postMessage() {} };
  Object.assign(f.context, { window, frontendActivity: f.registry, frontendTaskBarrier: f.barrier, APP_VERSION: '1.0.4' });
  vm.runInContext(compile('(function () {\n' + source('src/canvas/services/managed-page-relay.ts') + '\nglobalThis.stopRelay = startManagedPageRelay();\n})();'), f.context);
  const channel = new MessageChannel(); t.after(() => { f.context.stopRelay(); channel.port1.close(); channel.port2.close(); f.barrier.dispose(); });
  const event = { data: { type: 'guan-managed-page-v1', protocol: 1, session }, ports: [channel.port2], origin: window.location.origin, source: window };
  listeners.get('message')({ ...event, origin: 'https://example.invalid' });
  const ready = once(channel.port1, 'message'); listeners.get('message')(event);
  assert.equal((await ready)[0].installAllowed, false);
  const response = once(channel.port1, 'message'); channel.port1.postMessage({ protocol: 1, session, sequence: 0, op: 'probe', epoch: null });
  const value = (await response)[0]; assert.equal(value.phase, 'active'); assert.equal(value.version, '1.0.4'); assert.equal(value.fullRootCoverage, false);
  const paused = once(channel.port1, 'message'); channel.port1.postMessage({ protocol: 1, session, sequence: 1, op: 'pause', epoch });
  assert.equal((await paused)[0].acknowledged, true);
  listeners.get('pagehide')();
  const invalidated = once(channel.port1, 'message'); channel.port1.postMessage({ protocol: 1, session, sequence: 2, op: 'assert', epoch });
  assert.equal((await invalidated)[0].acknowledged, false);
});
