import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';

const epoch = '11111111-1111-4111-8111-111111111111';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function source(file) { return readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8'); }
function named(file, name) {
  const text = source(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(found, name); return found.getText(ast);
}
function execute(text, bindings, expression) {
  const ctx = vm.createContext({ ...bindings });
  vm.runInContext(ts.transpileModule(text + '\nglobalThis.result = ' + expression, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return ctx.result;
}
function bridgeFixture(activity, generate) {
  const counts = { mutations: 0 }, nodesRef = { current: [{ id: 'a', metadata: { prompt: 'saved prompt' } }] };
  const bindings = {
    ...activity, projectId: 'project', projectTitle: 'title', nodesRef, connectionsRef: { current: [] },
    selectedNodeIdsRef: { current: new Set() }, viewportRef: { current: { x: 0, y: 0, k: 1 } }, generateNodeRef: { current: generate },
    applyCanvasAgentOps(snapshot) { counts.mutations++; return snapshot; },
    setAgentUndoSnapshot() {}, setNodes() {}, setConnections() {}, setSelectedNodeIds() {}, setSelectedConnectionId() {}, setViewport() {}, setContextMenu() {},
  };
  return { run: execute('const run = ' + named('pages/canvas/hooks/use-agent-bridge.ts', 'applyAgentOps'), bindings, 'run'), counts, nodesRef };
}
function pluginFactory(activity) {
  const text = source('lib/canvas/plugin-task-host.ts').replace(/^import .*;$/gm, '').replace(/export /g, '');
  return execute(text, { ...activity, assertTaskAdmission: parent => activity.barrier.assertTaskAllowed(parent) }, 'createPluginTaskHost');
}
function capabilities(log, overrides = {}) {
  return {
    getNode: () => null, getNodes: () => [], getConnections: () => [], getUpstream: () => [], getDownstream: () => [],
    updateNode: () => log.push('node'), updateMetadata: () => log.push('metadata'),
    applyOps: async () => { log.push('ops'); }, openPanel() {}, closePanel() {},
    ai: { generateImage: async () => { log.push('image'); return { images: [] }; }, generateVideo: async () => { log.push('video'); return { url: 'local' }; }, generateText: async () => { log.push('text'); return { text: 'ok' }; }, listModels: () => [], defaultModel: () => 'fixture' },
    ...overrides,
  };
}

test('actual Agent apply callback rejects new roots before mutation during drain', async () => {
  const activity = createActivityFixture(), bridge = bridgeFixture(activity, async () => {});
  const receipt = await activity.barrier.drain(epoch);
  await assert.rejects(bridge.run([{ type: 'run_generation', nodeId: 'a' }]), /quiescing/);
  assert.equal(bridge.counts.mutations, 0); assert.equal(activity.barrier.isAcknowledged(receipt), true);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('actual Agent microtask starts generation with its original live scope and waits for save', async () => {
  const activity = createActivityFixture(), saved = deferred(); let started = false;
  const bridge = bridgeFixture(activity, (id, mode, prompt, parent) => activity.runTaskActivity('canvas', async () => {
    assert.equal(id, 'a'); assert.equal(mode, 'image'); assert.equal(prompt, 'saved prompt'); started = true; await saved.promise;
  }, parent));
  const running = bridge.run([{ type: 'run_generation', nodeId: 'a' }]);
  const draining = activity.barrier.drain(epoch); await tick();
  assert.equal(started, true); assert.ok(activity.registry.snapshot().agent > 0);
  let done = false; void running.then(() => { done = true; }); await tick(); assert.equal(done, false);
  bridge.nodesRef.current = [...bridge.nodesRef.current, { id: 'generated-result' }];
  saved.resolve(); const result = await running; assert.equal(result.projectId, 'project');
  assert.equal(result.nodes.at(-1).id, 'generated-result', 'returned snapshot must include results created while awaiting');
  assert.equal(activity.barrier.isAcknowledged(await draining), true);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('Agent branch failure drains its sibling and missing generation capability is not reported as success', async () => {
  const activity = createActivityFixture(), sibling = deferred();
  const bridge = bridgeFixture(activity, (id, _mode, _prompt, parent) => activity.runTaskActivity('canvas', async () => {
    if (id === 'a') throw Error('fixture failure'); await sibling.promise;
  }, parent));
  const running = bridge.run([{ type: 'run_generation', nodeId: 'a' }, { type: 'run_generation', nodeId: 'b' }]);
  const rejected = assert.rejects(running, /fixture failure/); await tick();
  assert.ok(activity.registry.snapshot().agent > 0); sibling.resolve(); await rejected;
  await assert.rejects(bridgeFixture(activity, null).run([{ type: 'run_generation', nodeId: 'a' }]), /unavailable/);
  assert.equal(activity.registry.snapshot().agent, 0); activity.barrier.dispose();
});

test('actual tool response awaits canvas operations and state delivery before posting success', async () => {
  const activity = createActivityFixture(), applied = deferred(), delivered = deferred(), log = [];
  const run = execute('const run = ' + named('components/agent/local-agent-panel.tsx', 'runToolCall'), {
    ...activity, isSiteTool: () => false, addEventLog() {}, toolName: value => value, rt: value => value,
    canvasContextRef: { current: { applyOps: async () => { await applied.promise; log.push('applied'); return { projectId: 'fixture' }; } } },
    clientIdRef: { current: 'fixture' }, postState: async () => { await delivered.promise; log.push('state'); return true; },
    postToolResult: async (_endpoint, _token, _clientId, result) => { log.push(result.error ? 'error' : 'success'); },
  }, 'run');
  const running = run('local', 'fixture', { requestId: 'fixture', name: 'canvas_apply_ops', input: { ops: [] } });
  await tick(); assert.deepEqual(log, []); applied.resolve(); await tick(); assert.deepEqual(log, ['applied']);
  delivered.resolve(); await running; assert.deepEqual(log, ['applied', 'state', 'success']); activity.barrier.dispose();
});

test('failed Agent state delivery reports failure without silently posting tool success or undoing local results', async () => {
  const activity = createActivityFixture(), results = []; let applied = false;
  const run = execute('const run = ' + named('components/agent/local-agent-panel.tsx', 'runToolCall'), {
    ...activity, isSiteTool: () => false, addEventLog() {}, toolName: value => value, rt: value => value,
    canvasContextRef: { current: { applyOps: async () => { applied = true; return { projectId: 'fixture' }; } } },
    clientIdRef: { current: 'fixture' }, postState: async () => false,
    postToolResult: async (_endpoint, _token, _clientId, result) => { results.push(result); },
  }, 'run');
  await run('local', 'fixture', { requestId: 'fixture', name: 'canvas_apply_ops', input: { ops: [] } });
  assert.equal(applied, true); assert.equal(results.length, 1); assert.equal(results[0].error, 'conversationSyncFailed');
  assert.equal(results[0].result, undefined); assert.equal(activity.registry.snapshot().agent, 0); activity.barrier.dispose();
});

test('all actual plugin host generation roots and synchronous mutations reject before capability calls', async () => {
  const activity = createActivityFixture(), log = [], errors = [];
  const host = pluginFactory(activity)(capabilities(log), error => errors.push(error));
  const receipt = await activity.barrier.drain(epoch);
  for (const method of ['generateImage', 'generateVideo', 'generateText']) await assert.rejects(host.ai[method]('fixture'), /quiescing/);
  await assert.rejects(host.applyOps([]), /quiescing/); await assert.rejects(host.runTask(async () => log.push('task')), /quiescing/);
  assert.throws(() => host.updateNode('a', {}), /quiescing/); assert.throws(() => host.updateMetadata('a', {}), /quiescing/);
  assert.deepEqual(log, []); assert.equal(errors.length, 5); assert.equal(activity.barrier.isAcknowledged(receipt), true);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('explicit multi-step plugin scope survives pause and expires at completion without ambient leakage', async () => {
  const activity = createActivityFixture(), log = [], gate = deferred(), host = pluginFactory(activity)(capabilities(log));
  let captured;
  const running = host.runTask(async scoped => {
    captured = scoped; await gate.promise;
    await scoped.ai.generateImage('fixture'); await scoped.ai.generateText('fixture');
    await scoped.applyOps([]); scoped.updateMetadata('a', {});
    return 'finished';
  });
  const draining = activity.barrier.drain(epoch);
  await assert.rejects(host.ai.generateImage('unrelated'), /quiescing/);
  gate.resolve(); assert.equal(await running, 'finished');
  assert.deepEqual(log, ['image', 'text', 'ops', 'metadata']);
  assert.equal(activity.barrier.isAcknowledged(await draining), true);
  await assert.rejects(captured.ai.generateText('expired'), /Invalid task scope/);
  assert.throws(() => captured.updateMetadata('a', {}), /Invalid task scope/);
  activity.barrier.resume(epoch); await host.ai.generateVideo('new'); assert.equal(log.at(-1), 'video'); activity.barrier.dispose();
});

test('node context runTask binds scoped host, preserving node identity and plugin storage namespace', async () => {
  const activity = createActivityFixture(), log = [], host = pluginFactory(activity)(capabilities(log));
  const text = source('lib/canvas/plugin-node-context.ts').replace(/^import .*;$/gm, '').replace(/export /g, '');
  const storage = {};
  const build = execute(text, { createPluginStorage: () => storage, getNodePluginId: () => 'fixture', emitCanvasEvent() {}, onCanvasEvent() {} }, 'buildNodeContext');
  const node = { id: 'a', type: 'fixture:node' }, context = build(host, node, {}, 1.25, true), gate = deferred();
  const running = context.runTask(async scoped => {
    assert.equal(scoped.node, node); assert.equal(scoped.scale, 1.25); assert.equal(scoped.isSelected, true); assert.equal(scoped.storage, storage);
    await gate.promise; await scoped.ai.generateText('fixture'); scoped.updateNode({ title: 'fixture' });
  });
  const draining = activity.barrier.drain(epoch); gate.resolve(); await running; await draining;
  assert.deepEqual(log, ['text', 'node']); activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('plugin applyOps passes an owned scope into the actual Agent bridge and waits for generation', async () => {
  const activity = createActivityFixture(), finish = deferred(), log = [];
  const bridge = bridgeFixture(activity, (_id, _mode, _prompt, parent) => activity.runTaskActivity('canvas', () => finish.promise, parent));
  const host = pluginFactory(activity)(capabilities(log, { applyOps: bridge.run }));
  const running = host.runTask(scoped => scoped.applyOps([{ type: 'run_generation', nodeId: 'a' }]));
  const draining = activity.barrier.drain(epoch); await tick(); assert.ok(activity.registry.snapshot().agent > 0);
  finish.resolve(); await running; assert.equal(activity.barrier.isAcknowledged(await draining), true);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('actual plugin hook publishes the wrapped host, retaining synchronous updates and scoping generated operations', async () => {
  const activity = createActivityFixture(), log = [], nodesRef = { current: [{ id: 'a', title: 'before', metadata: {} }] };
  const bridge = bridgeFixture(activity, async () => {});
  const factory = execute('const factory = ' + named('pages/canvas/hooks/use-plugin-host.tsx', 'pluginHost'), {
    createPluginTaskHost: pluginFactory(activity), nodesRef, connectionsRef: { current: [] },
    setNodes: update => { nodesRef.current = update(nodesRef.current); }, setDialogNodeId() {},
    applyAgentOps: bridge.run, pluginAi: capabilities(log).ai, message: { error() {} }, t: key => key,
  }, 'factory');
  const host = factory(); host.updateNode('a', { title: 'after' }); assert.equal(nodesRef.current[0].title, 'after');
  await host.applyOps([]); assert.equal(bridge.counts.mutations, 1);
  await activity.barrier.drain(epoch);
  assert.throws(() => host.updateNode('a', { title: 'blocked' }), /quiescing/);
  await assert.rejects(host.applyOps([]), /quiescing/); await assert.rejects(host.ai.generateText('blocked'), /quiescing/);
  assert.equal(nodesRef.current[0].title, 'after'); assert.equal(bridge.counts.mutations, 1); assert.deepEqual(log, []);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});
