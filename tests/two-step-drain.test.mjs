import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';
import { createPersistenceFixture } from './helpers/persistence-checkpoint.mjs';
import { createRecoveryFixture } from './helpers/recovery-read.mjs';

const epoch = '11111111-1111-4111-8111-111111111111';
const otherEpoch = '22222222-2222-4222-8222-222222222222';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function load(file, bindings, selected, expose) {
  const source = readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const statements = ast.statements.filter(node => !ts.isImportDeclaration(node) && (!selected ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => selected.includes(declaration.name.getText(ast)))) ||
    (ts.isFunctionDeclaration(node) && selected.includes(node.name?.text))));
  const body = statements.map(node => node.getText(ast)).join('\n').replace(/\bexport /g, '');
  const ctx = vm.createContext({ AbortController, ...bindings });
  vm.runInContext(ts.transpileModule(body + '\n' + expose, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return ctx;
}
function page() {
  const activity = createActivityFixture();
  const ctx = load('lib/page-drain-barrier.ts', { activity: activity.registry }, null, 'globalThis.barrier = new PageDrainBarrier(activity);');
  return { ...activity, barrier: ctx.barrier };
}

test('page closes new roots synchronously while existing roots retain child request and write access', async () => {
  const { registry, barrier } = page(), proceed = deferred(), saved = deferred();
  let scope, flushed = false;
  barrier.registerFlush(async () => { flushed = true; });
  const old = barrier.runRoot('canvas', async value => { scope = value; await proceed.promise; return value.runChild('storage', () => saved.promise); });
  const drained = barrier.drain(epoch);
  await assert.rejects(barrier.runRoot('canvas', () => { throw Error('must not execute'); }), /update_quiescing/);
  await tick(); assert.equal(flushed, false);
  proceed.resolve(); await tick(); assert.equal(registry.snapshot().storage, 1);
  saved.resolve('result'); assert.equal(await old, 'result');
  const receipt = await drained;
  assert.equal(barrier.isAcknowledged(receipt), true);
  await assert.rejects(scope.runChild('storage', async () => {}), /closed/);
  assert.throws(() => barrier.resume(otherEpoch), /epoch/);
  barrier.resume(epoch);
  assert.equal(barrier.isAcknowledged(receipt), false);
  assert.equal(await barrier.runRoot('canvas', async () => 7), 7);
  barrier.dispose();
});

test('flush failure waits for all started siblings, blocks acknowledgement and preserves error secrecy', async () => {
  const { registry, barrier } = page(), slow = deferred();
  barrier.registerFlush(async () => { throw Error('private-backend-detail'); });
  barrier.registerFlush(() => slow.promise);
  let ended = false;
  const drained = barrier.drain(epoch).finally(() => { ended = true; });
  const rejection = assert.rejects(drained, error => error.message === 'Persistence flush failed');
  await tick(); assert.equal(ended, false); assert.equal(registry.snapshot().storage, 1);
  slow.resolve(); await rejection;
  await assert.rejects(barrier.runRoot('canvas', async () => {}), /quiescing/);
  barrier.resume(epoch); barrier.dispose();
});

test('late activity invalidates receipts even when counts return to zero (ABA)', async () => {
  const { registry, barrier } = page();
  const receipt = await barrier.drain(epoch);
  const release = registry.acquire('storage');
  assert.equal(barrier.isAcknowledged(receipt), false);
  release(); assert.equal(barrier.isAcknowledged(receipt), false);
  const replacement = await barrier.drain(epoch);
  assert.equal(barrier.isAcknowledged(replacement), true);
  assert.equal(barrier.isAcknowledged({ ...replacement }), false, 'forged receipts are not accepted');
  barrier.resume(epoch); barrier.dispose();
});

test('abort during a flush does not detach a still-running write or reopen root admission', async () => {
  const { registry, barrier } = page(), write = deferred(), controller = new AbortController();
  barrier.registerFlush(() => write.promise);
  let ended = false;
  const drained = barrier.drain(epoch, controller.signal).finally(() => { ended = true; });
  const rejection = assert.rejects(drained, /invalidated/);
  await tick(); controller.abort(); await tick();
  assert.equal(ended, false); assert.equal(registry.snapshot().storage, 1);
  write.resolve(); await rejection;
  await assert.rejects(barrier.runRoot('canvas', async () => {}), /quiescing/);
  barrier.resume(epoch); barrier.dispose();
});

test('resume or dispose interrupts idle waits without retiring unresolved task leases', async () => {
  for (const action of ['resume', 'dispose']) {
    const { registry, barrier } = page();
    const release = registry.acquire('canvas');
    const drained = barrier.drain(epoch), rejected = assert.rejects(drained, /aborted/);
    await tick(); action === 'resume' ? barrier.resume(epoch) : barrier.dispose();
    await rejected;
    assert.equal(registry.snapshot().canvas, 1);
    release(); barrier.dispose();
  }
});

test('unmount during flush and concurrent or mismatched drain requests cannot produce an acknowledgement', async () => {
  const { barrier } = page(), write = deferred();
  const unregister = barrier.registerFlush(() => write.promise);
  const drained = barrier.drain(epoch), rejected = assert.rejects(drained, /invalidated/);
  await tick();
  await assert.rejects(barrier.drain(epoch), /pending/);
  await assert.rejects(barrier.drain(otherEpoch), /epoch/);
  assert.throws(() => barrier.registerFlush(async () => {}), /quiescing/);
  unregister(); write.resolve(); await rejected;
  barrier.resume(epoch); barrier.dispose();
});

function storage() {
  const activity = createActivityFixture(), persistence = createPersistenceFixture();
  const createRecoveryReadGate = createRecoveryFixture({ ...persistence, frontendActivity: activity.registry });
  let state;
  const writes = [];
  const saveStore = { getState: () => state, setState: next => { state = { ...state, ...next }; } };
  const ctx = load('stores/canvas/use-canvas-store.ts', {
    canvasReadGate: createRecoveryReadGate(),
    create: fn => { state = fn(); return saveStore; }, filterRecycledProjects: projects => projects,
    localForageStorage: { setItem() { const value = deferred(); writes.push(value); return value.promise; }, removeItem() { const value = deferred(); writes.push(value); return value.promise; } },
  }, ['queuedPersistState', 'useCanvasSaveStore', 'saveRevision', 'pendingCanvasPersistence', 'recordCanvasPersistence', 'flushCanvasPersistence', 'canvasStorage'], 'globalThis.storage = canvasStorage;');
  const value = () => ({ state: { projects: [], deletedProjects: [] }, version: 8 });
  return { ctx, writes, saveStore, value };
}

test('canvas drain waits for actual persistence and includes a newer write submitted during the wait', async () => {
  const { ctx, writes, saveStore, value } = storage();
  ctx.storage.setItem('fixture', value());
  let ended = false;
  const drained = ctx.flushCanvasPersistence().then(() => { ended = true; });
  ctx.storage.setItem('fixture', value());
  writes[0].resolve(); await tick();
  assert.equal(ended, false); assert.equal(saveStore.getState().status, 'saving');
  writes[1].resolve(); await drained;
  assert.equal(saveStore.getState().status, 'saved');
});

test('failed canvas writes reject explicit drains and the same snapshot can retry without clearing data', async () => {
  const { ctx, writes, saveStore, value } = storage(), snapshot = value();
  ctx.storage.setItem('fixture', snapshot);
  writes[0].reject(Error('private-storage-error')); await tick();
  assert.equal(saveStore.getState().status, 'error');
  await assert.rejects(ctx.flushCanvasPersistence(), error => error.message === 'Canvas persistence failed');
  ctx.storage.setItem('fixture', snapshot);
  assert.equal(writes.length, 2, 'deduplication must not hide a failed snapshot');
  writes[1].resolve(); await ctx.flushCanvasPersistence();
  assert.equal(saveStore.getState().status, 'saved');
});

test('serialization failure is a failed persistence receipt, not an uncaught error or successful drain', async () => {
  const { ctx, writes, saveStore, value } = storage(), snapshot = value();
  snapshot.state.projects.push(snapshot);
  ctx.storage.setItem('fixture', snapshot);
  assert.equal(writes.length, 0); assert.equal(saveStore.getState().status, 'error');
  await assert.rejects(ctx.flushCanvasPersistence(), /failed/);
});

test('a newer successful full snapshot can supersede an older failure but not a pending write', async () => {
  const { ctx, writes, saveStore, value } = storage();
  ctx.storage.setItem('fixture', value());
  const drained = ctx.flushCanvasPersistence();
  ctx.storage.setItem('fixture', value());
  writes[0].reject(Error('old failure')); await tick();
  assert.equal(saveStore.getState().status, 'saving');
  writes[1].resolve(); await drained;
  assert.equal(saveStore.getState().status, 'saved');
});

test('explicit canvas persistence removal is also awaited and failures block drains', async () => {
  const { ctx, writes, saveStore } = storage();
  const removal = ctx.storage.removeItem('fixture');
  const rejected = assert.rejects(removal, /failed/);
  let ended = false;
  const drained = ctx.flushCanvasPersistence().finally(() => { ended = true; });
  const drainRejected = assert.rejects(drained, /failed/);
  await tick(); assert.equal(ended, false); assert.equal(saveStore.getState().status, 'saving');
  writes[0].reject(Error('private-removal-failure')); await rejected; await drainRejected;
  assert.equal(saveStore.getState().status, 'error');
});

test('detached child writes remain counted after their parent returns', async () => {
  const { registry, barrier } = page(), child = deferred();
  let pending;
  await barrier.runRoot('canvas', async scope => { pending = scope.runChild('storage', () => child.promise); });
  const drained = barrier.drain(epoch);
  await tick(); assert.equal(registry.snapshot().storage, 1);
  child.resolve(); await pending;
  const receipt = await drained;
  assert.equal(barrier.isAcknowledged(receipt), true);
  barrier.resume(epoch); barrier.dispose();
});

test('invalid epochs do not close admission and an already-aborted drain cannot acknowledge', async () => {
  const { barrier } = page();
  await assert.rejects(barrier.drain('-'.repeat(36)), /epoch/);
  assert.equal(await barrier.runRoot('canvas', async () => 1), 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(barrier.drain(epoch, controller.signal), /aborted/);
  await assert.rejects(barrier.runRoot('canvas', async () => 1), /quiescing/);
  barrier.resume(epoch); barrier.dispose();
});
