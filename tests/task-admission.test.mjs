import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';

const epoch = '11111111-1111-4111-8111-111111111111';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function callback(file, name) {
  const source = readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = node.initializer; ts.forEachChild(node, visit); }
  visit(ast); return (ts.isCallExpression(result) ? result.arguments[0] : result).getText(ast);
}
function execute(source, bindings) {
  const ctx = vm.createContext({ useCallback: fn => fn, ...bindings });
  vm.runInContext(ts.transpileModule('globalThis.run = ' + source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return ctx.run;
}

test('every connected actual generation root rejects before mutating state or starting a request during drain', async () => {
  const activity = createActivityFixture();
  const receipt = await activity.barrier.drain(epoch);
  const targets = {
    'pages/canvas/project.tsx': ['handleGenerateNode', 'handleRetryNode', 'generateAllConfigNodes', 'completeAndGenerateAll', 'maskEditImageNode', 'upscaleImageNode', 'generateAngleNode'],
    'pages/image/index.tsx': ['generate', 'retryResult'],
    'pages/video/index.tsx': ['generate'],
  };
  for (const [file, names] of Object.entries(targets)) for (const name of names) {
    const run = execute(callback(file, name), { ...activity });
    await assert.rejects(run(), error => error.message === 'update_quiescing', name);
  }
  assert.equal(activity.barrier.isAcknowledged(receipt), true, 'denied roots have no business or storage effects');
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('actual three-worker batch continues remaining cards with the original scope after new roots are paused', async () => {
  const activity = createActivityFixture(), releases = [], executed = [], saved = deferred();
  const nodes = Array.from({ length: 5 }, (_, id) => ({ id: String(id), type: 'config', metadata: {} }));
  const handleGenerateNode = (id, _mode, _prompt, parent) => activity.runTaskActivity('canvas', async scope => {
    assert.equal(scope, parent);
    executed.push(id);
    await new Promise(resolve => releases.push(resolve));
  }, parent);
  activity.barrier.registerFlush(() => saved.promise);
  const runningRef = { current: false };
  const run = execute(callback('pages/canvas/project.tsx', 'generateAllConfigNodes'), {
    ...activity, nodesRef: { current: nodes }, CanvasNodeType: { Config: 'config' }, NODE_STATUS_LOADING: 'loading',
    batchGenerationRunning: runningRef, handleGenerateNode, message: { info() {}, warning() {} },
  });
  const running = run(); assert.equal(executed.length, 3);
  const draining = activity.barrier.drain(epoch);
  await assert.rejects(run(), /quiescing/);
  while (executed.length < 5) { releases.shift()(); await tick(); }
  for (const release of releases.splice(0)) release();
  await running; assert.equal(runningRef.current, false); assert.equal(executed.join(','), '0,1,2,3,4');
  await tick(); assert.equal(activity.registry.snapshot().storage, 1, 'actual batch ended but flush is still pending');
  saved.resolve(); const receipt = await draining;
  assert.equal(activity.barrier.isAcknowledged(receipt), true);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('actual combined completion action propagates its live scope into the batch rather than opening a second root', async () => {
  const activity = createActivityFixture(), started = deferred(), finish = deferred();
  let completion = 0;
  const run = execute(callback('pages/canvas/project.tsx', 'completeAndGenerateAll'), {
    ...activity, completeAndGenerateRunning: { current: false },
    addGenerationConfigsForPromptNodes() { completion++; }, message: { error() {} },
    generateAllConfigNodes(parent) { return activity.runTaskActivity('canvas', async () => { started.resolve(); await finish.promise; }, parent); },
  });
  const running = run(); await started.promise;
  const draining = activity.barrier.drain(epoch);
  await assert.rejects(run(), /quiescing/); assert.equal(completion, 1);
  finish.resolve(); await running;
  const receipt = await draining; assert.equal(activity.barrier.isAcknowledged(receipt), true);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('foreign, forged and expired scopes are rejected while owned live children can finish during drain', async () => {
  const a = createActivityFixture(), b = createActivityFixture(), finish = deferred();
  let owned;
  const running = a.runTaskActivity('canvas', async scope => { owned = scope; await finish.promise; });
  assert.equal(Object.isFrozen(owned), true);
  await assert.rejects(b.runTaskActivity('canvas', async () => {}, owned), /Invalid task scope/);
  await assert.rejects(a.runTaskActivity('canvas', async () => {}, { runChild: async () => 'forged' }), /Invalid task scope/);
  const draining = a.barrier.drain(epoch);
  assert.equal(await a.runTaskActivity('storage', async () => 7, owned), 7);
  finish.resolve(); await running; await draining;
  await assert.rejects(a.runTaskActivity('canvas', async () => {}, owned), /Invalid task scope/);
  a.barrier.resume(epoch); a.barrier.dispose(); b.barrier.dispose();
});

test('topology invalidation cancels acknowledgement, never silently authorizes an empty or changed canvas inventory', async () => {
  const activity = createActivityFixture(), saved = deferred();
  activity.barrier.registerFlush(() => saved.promise);
  const draining = activity.barrier.drain(epoch), rejected = assert.rejects(draining, /invalidated/);
  await tick(); activity.barrier.invalidateCheckpoint(); saved.resolve(); await rejected;
  await assert.rejects(activity.runTaskActivity('canvas', async () => {}), /quiescing/);
  activity.barrier.resume(epoch);
  const receipt = await activity.barrier.drain(epoch);
  activity.barrier.invalidateCheckpoint(); assert.equal(activity.barrier.isAcknowledged(receipt), false);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});
