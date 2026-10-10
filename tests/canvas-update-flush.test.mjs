import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function load(file, bindings, expose) {
  const source = readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/\bexport /g, '');
  const ctx = vm.createContext(bindings);
  vm.runInContext(ts.transpileModule(body + '\n' + expose, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return ctx;
}
function fixture() {
  const activity = createActivityFixture(), requested = [];
  const ctx = load('lib/render-commit-checkpoint.ts', { activity: activity.registry, request: ticket => requested.push(ticket) }, 'globalThis.checkpoint = new RenderCommitCheckpoint(activity, request);');
  ctx.checkpoint.mount();
  return { ...activity, checkpoint: ctx.checkpoint, requested };
}

test('canvas flush waits for a requested React commit and then actual persistence, including viewport', async () => {
  const { registry, checkpoint, requested } = fixture(), write = deferred();
  const old = { nodes: ['old'], viewport: { x: 0, y: 0, k: 1 } };
  const latest = { nodes: ['latest'], viewport: { x: 30, y: 20, k: 0.8 } };
  checkpoint.commit(0, old, true);
  let persisted;
  const flushed = checkpoint.flush(async snapshot => { persisted = snapshot; await write.promise; });
  assert.equal(persisted, undefined); assert.equal(registry.snapshot().storage, 1);
  checkpoint.commit(requested[0], latest, true); await tick();
  assert.equal(persisted, latest); assert.equal(registry.snapshot().storage, 1);
  write.resolve(); await flushed; assert.equal(registry.snapshot().storage, 0);
  checkpoint.unmount();
});

test('not-ready canvas cannot write a snapshot or acknowledge; newer commit invalidates pending flush', async () => {
  const { checkpoint, requested } = fixture();
  let writes = 0;
  const notReady = checkpoint.flush(async () => { writes++; });
  const rejected = assert.rejects(notReady, /not ready/);
  checkpoint.commit(requested[0], {}, false); await rejected; assert.equal(writes, 0);
  const pending = checkpoint.flush(async () => { writes++; });
  const stale = assert.rejects(pending, /invalidated/);
  checkpoint.commit(requested[1], {}, true);
  checkpoint.commit(requested[1], {}, true);
  await stale; assert.equal(writes, 0); checkpoint.unmount();
});

test('new committed edits, persistence failure or unmount during saving reject confirmation', async () => {
  for (const mode of ['edit', 'failure', 'unmount']) {
    const { registry, checkpoint, requested } = fixture(), write = deferred(), snapshot = {};
    const flushed = checkpoint.flush(() => write.promise);
    const rejected = assert.rejects(flushed);
    checkpoint.commit(requested[0], snapshot, true); await tick();
    if (mode === 'edit') checkpoint.commit(requested[0], {}, true);
    if (mode === 'unmount') checkpoint.unmount();
    mode === 'failure' ? write.reject(Error('fixture')) : write.resolve();
    await rejected; assert.equal(registry.snapshot().storage, 0); checkpoint.unmount();
  }
});

test('StrictMode unmount/remount cannot let a previous commit request save data', async () => {
  const { checkpoint, requested } = fixture();
  let writes = 0;
  const old = checkpoint.flush(async () => { writes++; });
  const rejected = assert.rejects(old, /invalidated/);
  checkpoint.unmount(); checkpoint.mount();
  checkpoint.commit(requested[0], {}, true); await rejected; assert.equal(writes, 0);
  const fresh = checkpoint.flush(async () => { writes++; });
  checkpoint.commit(requested[1], {}, true); await fresh; assert.equal(writes, 1);
  checkpoint.unmount();
});

test('canvas requests remain bounded and unavailable render scheduling cannot leak leases', async () => {
  const { registry, checkpoint } = fixture();
  const pending = Array.from({ length: 32 }, () => assert.rejects(checkpoint.flush(async () => {}), /invalidated/));
  await assert.rejects(checkpoint.flush(async () => {}), /unavailable/);
  checkpoint.unmount(); await Promise.all(pending); assert.equal(registry.snapshot().storage, 0);
  const ctx = load('lib/render-commit-checkpoint.ts', { activity: registry }, 'globalThis.checkpoint = new RenderCommitCheckpoint(activity, () => { throw Error("private"); });');
  ctx.checkpoint.mount(); await assert.rejects(ctx.checkpoint.flush(async () => {}), error => error.message === 'Canvas commit unavailable');
  assert.equal(registry.snapshot().storage, 0); ctx.checkpoint.unmount();
});

test('local canvas registry waits for sibling failures and invalidates topology changes, without claiming global inventory', async () => {
  const ctx = load('services/canvas-update-flush.ts', {}, 'globalThis.registry = new CanvasFlushRegistry();');
  const r = ctx.registry, slow = deferred();
  await assert.rejects(r.flushAll(), /empty/);
  const removeFailure = r.register(async () => { throw Error('private'); });
  const removeSlow = r.register(() => slow.promise);
  let ended = false;
  const flushed = r.flushAll().finally(() => { ended = true; });
  const rejection = assert.rejects(flushed, error => error.message === 'Canvas flush unconfirmed');
  await tick(); assert.equal(ended, false);
  removeFailure(); slow.resolve(); await rejection;
  removeSlow(); removeSlow(); assert.equal(r.count(), 0);
  let remove;
  remove = r.register(async () => { remove(); });
  await assert.rejects(r.flushAll(), /unconfirmed/);
  r.register(async () => {}); await r.flushAll();
});

test('actual canvas hook captures committed render fields, rejects wrong project, and saves before retiring viewport timer', () => {
  const source = readFileSync(new URL('../src/canvas/pages/canvas/project.tsx', import.meta.url), 'utf8');
  assert.match(source, /updateFlushSnapshot = useMemo\(\(\) => \(\{ projectId, nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, viewport \}\)/);
  assert.match(source, /restoredProjectIdRef.current === projectId/);
  const start = source.indexOf('useCanvasUpdateFlush(updateFlushSnapshot');
  const end = source.indexOf('const flushForRecycle', start);
  const hook = source.slice(start, end);
  assert.ok(hook.indexOf('await flushCanvasPersistence()') < hook.indexOf('clearTimeout(viewportSaveTimerRef.current)'));
  assert.match(hook, /viewportRef.current === snapshot.viewport/);
  assert.match(hook, /snapshot.nodes !== nodeTransactionRef.current/);
});

test('readiness changes invalidate an in-progress save even without a new snapshot object', async () => {
  const { checkpoint, requested } = fixture(), write = deferred(), snapshot = {};
  const flushed = checkpoint.flush(() => write.promise), rejected = assert.rejects(flushed, /changed/);
  checkpoint.commit(requested[0], snapshot, true); await tick();
  checkpoint.commit(requested[0], snapshot, false);
  write.resolve(); await rejected; checkpoint.unmount();
});

test('actual canvas persist callback retains the viewport timer on failure and saves before cancelling it', async () => {
  const source = readFileSync(new URL('../src/canvas/pages/canvas/project.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('project.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) { if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useCanvasUpdateFlush') callback = node.arguments[2]; ts.forEachChild(node, visit); }
  visit(ast);
  for (const mode of ['success', 'failure', 'new-viewport']) {
    const write = deferred(), nodes = [], viewport = {}, cancelled = [], saved = [];
    let releases = 0;
    const ctx = vm.createContext({
      restoredProjectIdRef: { current: 'fixture' }, nodeTransactionRef: { current: nodes },
      useCanvasStore: { getState: () => ({ projects: [{ id: 'fixture' }] }) },
      updateProject: (id, patch) => saved.push({ id, patch }), flushCanvasPersistence: () => write.promise,
      viewportRef: { current: viewport }, viewportSaveTimerRef: { current: 42 }, viewportSaveReleaseRef: { current: () => { releases++; } },
      clearTimeout: id => cancelled.push(id),
    });
    vm.runInContext(ts.transpileModule('globalThis.persist = ' + callback.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
    const pending = ctx.persist({ projectId: 'fixture', nodes, viewport });
    const outcome = mode === 'failure' ? assert.rejects(pending) : pending;
    assert.equal(cancelled.length, 0); assert.equal(releases, 0); assert.equal(saved[0].patch.viewport, viewport);
    if (mode === 'new-viewport') ctx.viewportRef.current = {};
    mode === 'failure' ? write.reject(Error('fixture')) : write.resolve();
    await outcome;
    assert.equal(cancelled.length, mode === 'success' ? 1 : 0);
    assert.equal(releases, mode === 'success' ? 1 : 0);
  }
});
