import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { webcrypto } from 'node:crypto';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';

const ORIGIN = 'http://127.0.0.1:5174', extension = 'a'.repeat(32), documentId = 'B'.repeat(32);
const code = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const moduleCode = file => code(file).replace(/^import .*;$/gm, '').replace(/export /g, '');
const compile = value => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const event = () => { const callbacks = []; return { addListener: fn => callbacks.push(fn), emit: value => callbacks.forEach(fn => fn(value)) }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } throw Error('relay did not settle'); }

function fixture(t, { supported = true, senderOrigin = ORIGIN, senderId = extension } = {}) {
  const activity = createActivityFixture(), listeners = new Map(), sent = [], channels = [], timers = [];
  const window = { location: { origin: ORIGIN }, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    postMessage(data, origin, ports = []) { queueMicrotask(() => { for (const fn of listeners.get('message') || []) fn({ data, origin, ports, source: window }); }); } };
  const onConnect = event(), nativeMessages = [];
  const native = { postMessage: value => nativeMessages.push(value), onMessage: event(), onDisconnect: event(), disconnect() {} };
  const backgroundChrome = { tabs: { onCreated: event(), onRemoved: event(), onReplaced: event(), onUpdated: event(), query: async () => [] },
    webNavigation: { onCommitted: event(), onHistoryStateUpdated: event(), onErrorOccurred: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event() },
    runtime: { id: extension, onConnect, connectNative: () => native, onStartup: event(), onInstalled: event() } };
  const timersApi = { setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {} };
  const background = vm.createContext({ chrome: backgroundChrome, crypto: webcrypto, URL, TextEncoder, ...timersApi });
  vm.runInContext(code('browser/managed-workbench/background.js'), background);
  let closed = false;
  const contentPort = { onMessage: event(), onDisconnect: event(), postMessage(value) { sent.push(value); queueMicrotask(() => serverPort.onMessage.emit(JSON.parse(JSON.stringify(value)))); },
    disconnect() { if (closed) return; closed = true; queueMicrotask(() => { contentPort.onDisconnect.emit(); serverPort.onDisconnect.emit(); }); } };
  const serverPort = { name: 'guan-managed-page-v1', sender: { id: senderId, url: senderOrigin + '/canvas/qa', documentId, frameId: 0, tab: { id: 1 } },
    onMessage: event(), onDisconnect: event(), postMessage: value => queueMicrotask(() => contentPort.onMessage.emit(JSON.parse(JSON.stringify(value)))), disconnect: () => contentPort.disconnect() };
  const app = vm.createContext({ window, AbortController, frontendActivity: activity.registry, frontendTaskBarrier: activity.barrier, APP_VERSION: '1.0.4' });
  vm.runInContext(compile(moduleCode('src/canvas/lib/managed-page-control.ts')), app);
  const startApp = () => vm.runInContext(compile('(function () {\n' + moduleCode('src/canvas/services/managed-page-relay.ts') + '\nglobalThis.stopRelay = startManagedPageRelay();\n})();'), app);
  if (supported) startApp();
  const content = vm.createContext({ window, location: window.location, document: { readyState: 'complete' },
    chrome: { runtime: { connect() { queueMicrotask(() => onConnect.emit(serverPort)); return contentPort; } } },
    MessageChannel: class { constructor() { const channel = new MessageChannel(); channels.push(channel); return channel; } }, crypto: webcrypto, ...timersApi });
  vm.runInContext(code('browser/managed-workbench/page-relay.js'), content);
  const state = () => vm.runInContext('[...pages.values()][0]?.state', background);
  const command = (op, epoch = null) => vm.runInContext(`sendPageCommand([...pages.values()][0], ${JSON.stringify(op)}, ${JSON.stringify(epoch)})`, background);
  t.after(() => { contentPort.disconnect(); app.stopRelay?.(); activity.barrier.dispose(); channels.forEach(c => { c.port1.close(); c.port2.close(); }); });
  return { ...activity, app, content, background, sent, nativeMessages, timers, listeners, state, command, startApp,
    deliver: value => serverPort.onMessage.emit(value), closed: () => closed };
}
test('actual isolated content relay and actual background bind Chrome document identity and drain real page barrier', async t => {
  const f = fixture(t), epoch = '22222222-2222-4222-8222-222222222222';
  await until(() => f.state()?.phase === 'active');
  assert.equal(f.state().installAllowed, false); assert.equal(f.state().fullRootCoverage, false);
  assert.equal(vm.runInContext('[...pages.keys()][0]', f.background), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  f.command('pause', epoch); await until(() => f.state()?.phase === 'paused');
  assert.equal(f.state().acknowledged, true); await assert.rejects(f.runTaskActivity('canvas', async () => {}), /quiescing/);
  f.command('resume', epoch); await until(() => f.state()?.phase === 'active');
  assert.equal(await f.runTaskActivity('canvas', async () => 8), 8);
  assert.doesNotMatch(JSON.stringify(f.sent), /canvas\/qa|127\.0\.0\.1|token|prompt|private/);
  assert.ok(f.nativeMessages.every(value => value.op === 'inventory'), 'read-only native host is not silently turned into an installation controller');
});
test('discovery retries until app listener exists; an old unsupported page never reports ready or safe idle', async t => {
  const f = fixture(t, { supported: false });
  await tick(); assert.equal(f.sent.length, 0);
  f.startApp(); f.timers.at(-1)(); await until(() => f.state()?.phase === 'active');
  assert.equal(f.state().fullRootCoverage, false);
});
test('foreign Origin and extension identity are rejected by background before any control is sent', async t => {
  for (const options of [{ senderOrigin: 'https://example.invalid' }, { senderId: 'b'.repeat(32) }]) {
    const f = fixture(t, options); await until(f.closed);
    assert.equal(vm.runInContext('pages.size', f.background), 0);
    assert.equal(await f.runTaskActivity('canvas', async () => 3), 3);
  }
});
test('page lifecycle closes relay and retains unknown; no unload idle or implicit resume is sent', async t => {
  const f = fixture(t), epoch = '22222222-2222-4222-8222-222222222222';
  await until(() => f.state()?.phase === 'active'); f.command('pause', epoch); await until(() => f.state()?.phase === 'paused');
  for (const fn of f.listeners.get('pagehide')) fn(); await until(f.closed);
  assert.equal(vm.runInContext('[...pages.values()][0].unknown', f.background), true);
  await assert.rejects(f.runTaskActivity('canvas', async () => {}), /quiescing/);
  assert.equal(f.sent.at(-1).phase, 'paused', 'unload does not fabricate an idle response');
});
test('late pause response cannot overwrite a newer checkpoint observation', async t => {
  const f = fixture(t), epoch = '22222222-2222-4222-8222-222222222222';
  await until(() => f.state()?.phase === 'active');
  vm.runInContext(`(() => {
    const entry = [...pages.values()][0];
    entry.sequence = 2; entry.pending.set(1, { op: 'pause', epoch: '${epoch}' });
    entry.pending.set(2, { op: 'probe', epoch: null });
  })()`, f.background);
  const base = JSON.parse(JSON.stringify(f.sent.at(-1)));
  f.deliver({ ...base, sequence: 2, revision: 4, phase: 'paused', epoch, acknowledged: false });
  f.deliver({ ...base, sequence: 1, revision: 3, phase: 'paused', epoch, acknowledged: true });
  assert.equal(f.state().acknowledged, false); assert.equal(f.state().revision, 4);
  assert.equal(vm.runInContext('[...pages.values()][0].unknown', f.background), false);
});
test('pending drain continues heartbeat probes without repeating pause; old task and storage keep real leases', async t => {
  const f = fixture(t), epoch = '22222222-2222-4222-8222-222222222222';
  let finish; const task = f.runTaskActivity('canvas', () => new Promise(resolve => { finish = resolve; }));
  await until(() => f.state()?.phase === 'active'); f.command('pause', epoch);
  await tick(); f.timers[0]();
  await until(() => f.state()?.phase === 'draining');
  assert.equal(f.state().counts.canvas, 1); assert.equal(f.state().acknowledged, false);
  assert.equal(vm.runInContext('[...pages.values()][0].pending.size', f.background), 1, 'only original pause remains pending');
  finish(); await task; await until(() => f.sent.some(value => value.phase === 'paused'));
  f.command('probe'); await until(() => f.state()?.acknowledged === true);
  assert.equal(f.state().installAllowed, false);
});
