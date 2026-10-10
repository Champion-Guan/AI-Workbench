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
function execute(text, bindings, expression) {
  const ctx = vm.createContext({ Error, performance, ...bindings });
  vm.runInContext(ts.transpileModule(text + '\nglobalThis.result = ' + expression, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return ctx.result;
}
function named(file, name) {
  const text = source(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer;
    if (ts.isFunctionDeclaration(node) && node.name?.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(found, name); return found.getText(ast);
}
function effect(file, includes) {
  const text = source(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let found;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes(includes)) found = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(found, includes); return found.getText(ast);
}
function storeFixture(activity) {
  function create(factory) {
    let state;
    const set = value => { state = { ...state, ...(typeof value === 'function' ? value(state) : value) }; };
    state = factory(set); const store = () => {}; store.getState = () => state; return store;
  }
  return execute(source('stores/use-workbench-agent-store.ts').replace(/^import .*;$/gm, '').replace(/export /g, ''), { create, ...activity }, '{ store: useWorkbenchAgentStore, available: assertWorkbenchCommandAvailable }');
}
function common() { return { setElapsedMs() {}, setRunning() {}, setPreviewLog() {}, setResults() {}, setStartedAt() {}, nanoid: () => 'fixture', t: key => key, message: { success() {}, warning() {}, error() {} } }; }

test('queued command blocks drain; an owned single consumption survives pause through persistence', async () => {
  const activity = createActivityFixture(), command = Object.freeze({ nonce: 1 }), saved = deferred();
  activity.workbenchTaskHandoff.admit(command); assert.equal(activity.registry.snapshot().workbench, 1);
  const draining = activity.barrier.drain(epoch); let drained = false; void draining.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  await assert.rejects(activity.runWorkbenchTask({ ...command }, async () => {}), /Invalid task handoff/);
  const running = activity.runWorkbenchTask(command, () => saved.promise);
  await assert.rejects(activity.runWorkbenchTask(command, async () => {}), /Invalid task handoff/);
  assert.throws(() => activity.workbenchTaskHandoff.cancelBeforeStart(command), /Invalid task handoff/);
  await assert.rejects(activity.runWorkbenchTask(undefined, async () => {}), /quiescing/);
  saved.resolve(); await running; assert.equal(activity.barrier.isAcknowledged(await draining), true);
  await assert.rejects(activity.runWorkbenchTask(command, async () => {}), /Invalid task handoff/);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('bounded handoffs never expire pending work, but explicit rejection before start releases only its own root', async () => {
  const activity = createActivityFixture(), commands = Array.from({ length: 16 }, () => ({}));
  for (const command of commands) activity.workbenchTaskHandoff.admit(command);
  assert.throws(() => activity.workbenchTaskHandoff.assertCanAdmit(), /unavailable/);
  assert.equal(activity.registry.snapshot().workbench, 16);
  for (const command of commands) activity.workbenchTaskHandoff.cancelBeforeStart(command);
  await tick(); assert.equal(activity.registry.snapshot().workbench, 0);
  assert.throws(() => activity.workbenchTaskHandoff.cancelBeforeStart(commands[0]), /Invalid task handoff/);
  activity.barrier.dispose();
});

test('actual command store preserves the pending immutable command, rejects overwrites and ignores stale clears', async () => {
  const activity = createActivityFixture(), { store } = storeFixture(activity);
  const id = store.getState().dispatchImage({ run: true, prompt: 'first' }), first = store.getState().imageCommand;
  assert.equal(first.taskId, id); assert.equal(Object.isFrozen(first), true);
  assert.throws(() => store.getState().dispatchImage({ run: true, prompt: 'lost' }), /already pending/);
  assert.equal(store.getState().imageCommand, first); assert.equal(store.getState().tasks.length, 1);
  store.getState().clearImageCommand(first.nonce + 1); assert.equal(store.getState().imageCommand, first);
  store.getState().clearImageCommand(first.nonce); assert.equal(store.getState().imageCommand, null);
  assert.equal(activity.registry.snapshot().workbench, 1, 'clearing a UI slot does not erase pending admission');
  await activity.runWorkbenchTask(first, async () => {}); await tick(); assert.equal(activity.registry.snapshot().workbench, 0); activity.barrier.dispose();
});

test('actual Agent site tools reject before configuration, navigation or command publication during pause', async () => {
  const activity = createActivityFixture(), { store, available } = storeFixture(activity), mutations = [];
  const tools = execute(named('lib/agent/agent-site-tools.ts', 'runImageWorkbench') + '\n' + named('lib/agent/agent-site-tools.ts', 'runVideoWorkbench'), {
    assertWorkbenchCommandAvailable: available, useWorkbenchAgentStore: store,
    useConfigStore: { getState: () => ({ config: {}, updateConfig: (...args) => mutations.push(args) }) },
  }, '{ image: runImageWorkbench, video: runVideoWorkbench }');
  const receipt = await activity.barrier.drain(epoch);
  for (const run of Object.values(tools)) assert.throws(() => run({ size: '800x500', run: false }, () => mutations.push('navigate')), /quiescing/);
  assert.deepEqual(mutations, []); assert.equal(store.getState().tasks.length, 0); assert.equal(activity.barrier.isAcknowledged(receipt), true);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('actual site tool admits the command before navigation and rejects a second command before modifying settings', async () => {
  const activity = createActivityFixture(), { store, available } = storeFixture(activity), log = [];
  const run = execute(named('lib/agent/agent-site-tools.ts', 'runImageWorkbench'), {
    assertWorkbenchCommandAvailable: available, useWorkbenchAgentStore: store,
    useConfigStore: { getState: () => ({ config: {}, updateConfig: (...args) => log.push(args) }) }, siteText: key => key,
  }, 'runImageWorkbench');
  const result = run({ prompt: 'fixture', size: '800x500' }, () => { assert.ok(store.getState().imageCommand); assert.equal(activity.registry.snapshot().workbench, 1); });
  assert.equal(result.taskId, store.getState().imageCommand.taskId); assert.equal(log.length, 1);
  assert.throws(() => run({ size: '900x1200' }, () => {}), /already pending/); assert.equal(log.length, 1);
  const command = store.getState().imageCommand; store.getState().clearImageCommand(command.nonce); activity.workbenchTaskHandoff.cancelBeforeStart(command); await tick(); activity.barrier.dispose();
});

test('actual image/video effects retain commands through render handoff and do not execute a repeated auto effect twice', async () => {
  for (const kind of ['image', 'video']) {
    const activity = createActivityFixture(), { store } = storeFixture(activity), state = store.getState(), cap = kind[0].toUpperCase() + kind.slice(1);
    state['dispatch' + cap]({ run: true, prompt: 'fixture' }); const command = store.getState()[kind + 'Command'];
    const agentCommandRef = { current: undefined }, processedCommandRef = { current: 0 }; let token = 0, starts = 0;
    const file = 'pages/' + kind + '/index.tsx';
    const bindings = { ...activity, ...common(), [kind + 'Command']: command, ['clear' + cap + 'Command']: state['clear' + cap + 'Command'],
      processedCommandRef, agentCommandRef, running: false, setPrompt() {}, setAutoRunToken: update => { token = update(token); }, updateAgentTask: state.updateTask,
      generate: value => { starts++; return activity.runWorkbenchTask(value, async () => { state['clear' + cap + 'Command'](value.nonce); }); },
    };
    const consume = execute('const consume = ' + effect(file, kind + 'Command.nonce'), bindings, 'consume');
    consume(); consume(); assert.equal(token, 1); assert.equal(store.getState()[kind + 'Command'], command);
    assert.equal(activity.registry.snapshot().workbench, 1);
    const draining = activity.barrier.drain(epoch);
    const auto = execute('const auto = ' + effect(file, 'if (!autoRunToken)'), { ...bindings, autoRunToken: token }, 'auto');
    auto(); auto(); await tick(); assert.equal(starts, 1); assert.equal(activity.barrier.isAcknowledged(await draining), true);
    activity.barrier.resume(epoch); activity.barrier.dispose();
  }
});

test('actual busy and configuration-only effects release only commands with no generation started', async () => {
  for (const kind of ['image', 'video']) for (const run of [true, false]) {
    const activity = createActivityFixture(), { store } = storeFixture(activity), state = store.getState(), cap = kind[0].toUpperCase() + kind.slice(1);
    state['dispatch' + cap]({ run, prompt: 'fixture' }); const command = store.getState()[kind + 'Command'];
    const consume = execute('const consume = ' + effect('pages/' + kind + '/index.tsx', kind + 'Command.nonce'), {
      ...activity, ...common(), [kind + 'Command']: command, ['clear' + cap + 'Command']: state['clear' + cap + 'Command'],
      processedCommandRef: { current: 0 }, agentCommandRef: { current: undefined }, running: true, setPrompt() {}, setAutoRunToken() { throw Error('Must not generate'); }, updateAgentTask: state.updateTask,
    }, 'consume');
    consume(); await tick(); assert.equal(activity.registry.snapshot().workbench, 0); assert.equal(store.getState()[kind + 'Command'], null);
    if (run) assert.equal(store.getState().tasks[0].status, 'failed'); activity.barrier.dispose();
  }
});

test('actual image command remains admitted across route delay and generation until history persistence completes', async () => {
  const activity = createActivityFixture(), { store } = storeFixture(activity), state = store.getState(), generated = deferred(), saved = deferred();
  state.dispatchImage({ prompt: 'fixture', run: true }); const command = store.getState().imageCommand;
  const generate = execute('const generate = ' + named('pages/image/index.tsx', 'generate'), {
    ...activity, ...common(), clearImageCommand: state.clearImageCommand, updateAgentTask: state.updateTask,
    prompt: 'fixture', effectiveConfig: {}, model: 'fixture', isAiConfigReady: () => true,
    buildRequestSnapshot: () => ({ config: {}, references: [] }), generationCount: 1, runGenerationSlot: () => generated.promise,
    saveLog: () => saved.promise, buildLog: value => value,
  }, 'generate');
  const draining = activity.barrier.drain(epoch), running = generate(command);
  assert.equal(store.getState().imageCommand, null); assert.equal(store.getState().tasks[0].status, 'running');
  generated.resolve({ id: 'fixture-image' }); await tick(); assert.ok(activity.registry.snapshot().workbench > 0);
  assert.equal(store.getState().tasks[0].status, 'running'); saved.resolve(); await running;
  assert.equal(store.getState().tasks[0].status, 'succeeded'); assert.equal(activity.barrier.isAcknowledged(await draining), true);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('actual video generation awaits the poll lifecycle rather than returning after task creation', async () => {
  const activity = createActivityFixture(), { store } = storeFixture(activity), state = store.getState(), polled = deferred();
  state.dispatchVideo({ prompt: 'fixture', run: true }); const command = store.getState().videoCommand;
  const generate = execute('const generate = ' + named('pages/video/index.tsx', 'generate'), {
    ...activity, ...common(), clearVideoCommand: state.clearVideoCommand, updateAgentTask: state.updateTask,
    buildRequestSnapshot: () => ({ text: 'fixture', config: {}, references: [] }), model: 'fixture',
    createVideoGenerationTask: async () => ({ id: 'fixture' }), buildLog: value => value, saveLog: async () => {}, pollGenerationLog: () => polled.promise,
  }, 'generate');
  const draining = activity.barrier.drain(epoch), running = generate(command); let finished = false; void running.then(() => { finished = true; });
  await tick(); assert.equal(finished, false); assert.ok(activity.registry.snapshot().workbench > 0);
  polled.resolve(); await running; assert.equal(activity.barrier.isAcknowledged(await draining), true);
  activity.barrier.resume(epoch); activity.barrier.dispose();
});

test('actual video poll cannot report Agent success until final history save completes', async () => {
  const activity = createActivityFixture(), saved = deferred(), statuses = [];
  const poll = execute('const poll = ' + named('pages/video/index.tsx', 'pollGenerationLog'), {
    ...activity, ...common(), activeLogIdsRef: { current: new Set() }, effectiveConfig: {}, buildVideoConfig: value => value,
    pollVideoGenerationTask: async () => ({ status: 'completed', result: {} }), storeGeneratedVideo: async () => ({ url: 'fixture', storageKey: 'fixture' }),
    saveLog: () => saved.promise, updateAgentTask: (_id, value) => statuses.push(value.status),
  }, 'poll');
  const running = poll({ id: 'fixture', task: {}, createdAt: Date.now() }, {}, 'agent'); await tick();
  assert.deepEqual(statuses, []); assert.ok(activity.registry.snapshot().workbench > 0);
  saved.resolve(); await running; assert.deepEqual(statuses, ['succeeded']); assert.equal(activity.registry.snapshot().workbench, 0); activity.barrier.dispose();
});
