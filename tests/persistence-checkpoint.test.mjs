import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createPersistenceFixture } from './helpers/persistence-checkpoint.mjs';
import { createActivityFixture } from './helpers/frontend-activity.mjs';
import { createRecoveryFixture } from './helpers/recovery-read.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function load(file, bindings, expose) {
  bindings.createRecoveryReadGate = createRecoveryFixture(bindings);
  const source = readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
  const ctx = vm.createContext(bindings);
  vm.runInContext(ts.transpileModule(source + '\nglobalThis.api = ' + expose, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return ctx.api;
}

test('pending writes and newly submitted writes finish before checkpoint flush', async () => {
  const { createPersistenceCheckpoint } = createPersistenceFixture(), a = deferred(), b = deferred();
  const p = createPersistenceCheckpoint();
  const first = p.run('set:a', () => a.promise);
  let finished = false;
  const flushing = p.flush().then(() => { finished = true; });
  const second = p.run('set:b', () => b.promise);
  a.resolve('a'); await first; await tick(); assert.equal(finished, false);
  b.resolve('b'); assert.equal(await second, 'b'); await flushing; assert.equal(finished, true);
});

test('failure stays after settlement; unrelated success cannot clear it; explicit retry can', async () => {
  const p = createPersistenceFixture().createPersistenceCheckpoint(), secret = Error('private fixture data');
  await assert.rejects(p.run('set:a', () => Promise.reject(secret)), error => error === secret);
  assert.equal(await p.run('set:b', () => 7), 7);
  await assert.rejects(p.flush(), error => error.message === 'Persistence checkpoint incomplete');
  await p.run('set:a', () => 'saved'); await p.flush();
});

test('overlapping success cannot erase a failed sibling, regardless of completion order', async () => {
  for (const failFirst of [true, false]) {
    const p = createPersistenceFixture().createPersistenceCheckpoint(), a = deferred(), b = deferred();
    const first = p.run('set:a', () => a.promise), second = p.run('set:a', () => b.promise);
    const rejected = assert.rejects(first);
    if (failFirst) { a.reject(Error('failed')); await rejected; b.resolve(); await second; }
    else { b.resolve(); await second; a.reject(Error('failed')); await rejected; }
    await assert.rejects(p.flush());
    await p.run('set:a', () => undefined); await p.flush();
  }
});

test('flush drains successful siblings before reporting failure and does not automatically retry', async () => {
  const f = createPersistenceFixture(), p = f.createPersistenceCheckpoint(), q = f.createPersistenceCheckpoint(), slow = deferred();
  let calls = 0, finished = false;
  await assert.rejects(p.run('set:a', () => { calls++; throw Error('failed'); }));
  const writing = q.run('set:b', () => slow.promise);
  const flushing = assert.rejects(f.flushStorageCheckpoints()).then(() => { finished = true; });
  await tick(); assert.equal(finished, false); assert.equal(calls, 1);
  slow.resolve(); await writing; await flushing;
});

test('bounded capacity overflow remains blocked and does not silently evict failures', async () => {
  const { PersistenceCheckpoint } = createPersistenceFixture(), p = new PersistenceCheckpoint(1);
  await assert.rejects(p.run('set:a', () => Promise.reject(Error('failed'))));
  assert.equal(await p.run('set:b', () => 9), 9);
  await p.run('set:a', () => undefined); await assert.rejects(p.flush());
  const f = createPersistenceFixture();
  for (let i = 0; i < 257; i++) f.createPersistenceCheckpoint();
  await assert.rejects(f.flushStorageCheckpoints());
});

test('a late write to an already flushed store is rechecked after a slow sibling', async () => {
  const f = createPersistenceFixture(), p = f.createPersistenceCheckpoint(), q = f.createPersistenceCheckpoint(), slow = deferred();
  const writing = q.run('set:b', () => slow.promise);
  const flushing = f.flushStorageCheckpoints();
  const rejected = assert.rejects(flushing, /incomplete/);
  await tick();
  await assert.rejects(p.run('set:a', () => Promise.reject(Error('late failure'))));
  slow.resolve(); await writing; await rejected;
});

test('topology changes invalidate a flush and observers cannot break storage registration', async () => {
  const f = createPersistenceFixture(), slow = deferred();
  f.subscribePersistenceCheckpoints(() => { throw Error('observer'); });
  const writing = f.createPersistenceCheckpoint().run('set:a', () => slow.promise);
  const flushing = assert.rejects(f.flushStorageCheckpoints());
  f.createPersistenceCheckpoint(); slow.resolve(); await writing; await flushing;
  await f.flushStorageCheckpoints();
});

test('actual adapter tracks callback exceptions and failed dropInstance is not cleared by other options', async () => {
  const f = createPersistenceFixture(), a = createActivityFixture();
  const backend = {
    setItem(key, value, callback) { assert.equal(this, backend); callback(null, value); return Promise.resolve(value); },
    dropInstance(options) { return options.fail ? Promise.reject(Error('disk')) : Promise.resolve(); },
  };
  const observe = load('lib/activity-storage.ts', { ...f, ...a }, 'observeStorageWrites');
  const store = observe(backend);
  await assert.rejects(store.setItem('a', 'value', () => { throw Error('callback'); }));
  await store.setItem('a', 'value', () => {}); await f.flushStorageCheckpoints();
  await assert.rejects(store.dropInstance({ name: 'one', fail: true }));
  await store.dropInstance({ name: 'two' }); await assert.rejects(f.flushStorageCheckpoints());
  assert.equal(a.registry.snapshot().storage, 0);
});

test('configuration JSON storage preserves envelope/read semantics and captures serialization/quota failures', async () => {
  const f = createPersistenceFixture(), a = createActivityFixture(), values = new Map();
  let fail = false;
  const backend = { getItem: key => values.get(key) ?? null, setItem(key, value) { if (fail) throw Error('quota'); values.set(key, value); }, removeItem: key => { values.delete(key); } };
  const create = load('lib/checkpoint-json-storage.ts', { ...f, frontendActivity: a.registry }, 'createCheckpointJsonStorage');
  const store = create(() => backend), envelope = { state: { config: { model: 'fixture' } }, version: 0 };
  assert.equal(store.getItem('config'), null);
  store.setItem('config', envelope); assert.equal(values.get('config'), JSON.stringify(envelope));
  assert.equal(JSON.stringify(store.getItem('config')), JSON.stringify(envelope));
  const circular = {}; circular.self = circular;
  assert.throws(() => store.setItem('config', circular)); await assert.rejects(f.flushStorageCheckpoints());
  assert.equal(values.get('config'), JSON.stringify(envelope), 'failed serialization keeps prior disk config');
  store.setItem('config', envelope); await f.flushStorageCheckpoints();
  fail = true; assert.throws(() => store.setItem('config', envelope), /quota/);
  await assert.rejects(f.flushStorageCheckpoints()); assert.equal(a.registry.snapshot().storage, 0);
  fail = false; store.setItem('config', envelope); await f.flushStorageCheckpoints();
  store.removeItem('config'); assert.equal(store.getItem('config'), null);
});

test('unavailable config storage keeps existing behavior but blocks confirmation; no defaults are written', async () => {
  const f = createPersistenceFixture(), a = createActivityFixture();
  const create = load('lib/checkpoint-json-storage.ts', { ...f, frontendActivity: a.registry }, 'createCheckpointJsonStorage');
  assert.equal(create(() => { throw Error('disabled'); }), undefined);
  await assert.rejects(f.flushStorageCheckpoints()); assert.equal(a.registry.snapshot().storage, 0);
});

test('real page barrier refuses receipt after a settled storage failure and succeeds after explicit retry', async () => {
  const f = createPersistenceFixture(), a = createActivityFixture(), p = f.createPersistenceCheckpoint();
  a.barrier.registerFlush(f.flushStorageCheckpoints);
  f.subscribePersistenceCheckpoints(() => a.barrier.invalidateCheckpoint());
  await assert.rejects(a.observeActivity('storage', () => p.run('set:a', () => Promise.reject(Error('disk')))));
  const epoch = '11111111-1111-4111-8111-111111111111';
  await assert.rejects(a.barrier.drain(epoch), /Persistence flush failed/);
  await assert.rejects(a.runTaskActivity('workbench', () => {}), /quiescing/);
  a.barrier.resume(epoch);
  await a.observeActivity('storage', () => p.run('set:a', () => undefined));
  const receipt = await a.barrier.drain(epoch); assert.equal(a.barrier.isAcknowledged(receipt), true);
  f.createPersistenceCheckpoint(); assert.equal(a.barrier.isAcknowledged(receipt), false);
  a.barrier.resume(epoch); a.barrier.dispose();
  const config = readFileSync(new URL('../src/canvas/stores/use-config-store.ts', import.meta.url), 'utf8');
  const admission = readFileSync(new URL('../src/canvas/services/task-admission.ts', import.meta.url), 'utf8');
  assert.match(config, /storage: createCheckpointJsonStorage\(\(\) => localStorage\)/);
  assert.match(admission, /registerFlush\(flushStorageCheckpoints\)/);
});
