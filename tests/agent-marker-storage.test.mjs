import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';
import { createPersistenceFixture } from './helpers/persistence-checkpoint.mjs';

const read = file => readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8');
const panelFile = 'components/agent/local-agent-panel.tsx';
const panelAst = ts.createSourceFile(panelFile, read(panelFile), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
    let result;
    function visit(node) { if (!result && predicate(node)) result = node; ts.forEachChild(node, visit); }
    visit(panelAst); assert.ok(result, 'actual panel callback exists'); return result;
}
function callback(name) {
    const node = find(node => (ts.isVariableDeclaration(node) || ts.isJsxAttribute(node)) && node.name?.getText(panelAst) === name);
    return (ts.isJsxAttribute(node) ? node.initializer.expression : node.initializer).getText(panelAst);
}
function effectWith(text) {
    return find(node => ts.isCallExpression(node) && node.expression.getText(panelAst) === 'useEffect' && node.arguments[0]?.getText(panelAst).includes(text)).arguments[0];
}
function run(body, bindings, expose) {
    const context = vm.createContext({ ...bindings });
    vm.runInContext(ts.transpileModule(body + '\nglobalThis.api = ' + expose, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context.api;
}
function load(file, bindings, expose) {
    const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    return run(ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/\bexport /g, ''), bindings, expose);
}
function fixture() {
    const activity = createActivityFixture(), persistence = createPersistenceFixture(), values = new Map(), writes = [];
    let failureKey, removeFailure;
    const localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem(key, value) { writes.push(['set', key]); if (key === failureKey) throw Error('fixture quota'); values.set(key, value); },
        removeItem(key) { writes.push(['remove', key]); if (removeFailure) throw Error('fixture remove'); values.delete(key); },
    };
    const bindings = { ...activity, ...persistence, frontendActivity: activity.registry, localStorage };
    Object.assign(bindings, load('lib/checkpoint-local-storage.ts', bindings, '{ checkpointLocalStorageWrite, checkpointLocalStorageRemove }'));
    return { ...activity, ...persistence, bindings, values, writes, failSet: key => { failureKey = key; }, failRemove: flag => { removeFailure = flag; } };
}
const models = [{ model: 'fixture-model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];

test('actual inline Agent model/effort callbacks keep keys, order and state updates', async () => {
    const f = fixture(), states = [];
    const changeModel = run('const change = ' + callback('onModelChange'), { ...f.bindings, models, setAgentState: state => states.push(state) }, 'change');
    changeModel('missing'); assert.equal(f.writes.length, 0);
    changeModel('fixture-model'); assert.deepEqual(f.writes, [['set', 'canvas-agent-model'], ['set', 'canvas-agent-reasoning-effort']]);
    assert.equal(states[0].model, 'fixture-model'); assert.equal(states[0].reasoningEffort, 'high');
    const changeEffort = run('const change = ' + callback('onReasoningEffortChange'), { ...f.bindings, setAgentState: state => states.push(state) }, 'change');
    changeEffort('low'); assert.equal(f.values.get('canvas-agent-reasoning-effort'), 'low'); assert.equal(states[1].reasoningEffort, 'low');
    await f.flushStorageCheckpoints(); assert.equal(f.registry.snapshot().storage, 0);
});

test('actual model second-write failure does not commit state or hide failed persistence, explicit success recovers', async () => {
    const f = fixture(); let states = 0;
    const change = run('const change = ' + callback('onModelChange'), { ...f.bindings, models, setAgentState: () => { states++; } }, 'change');
    f.failSet('canvas-agent-reasoning-effort'); assert.throws(() => change('fixture-model'), /quota/);
    assert.equal(states, 0); assert.equal(f.values.get('canvas-agent-model'), 'fixture-model');
    await assert.rejects(f.flushStorageCheckpoints()); assert.equal(f.registry.snapshot().storage, 0);
    f.failSet(undefined); change('fixture-model'); await f.flushStorageCheckpoints(); assert.equal(states, 1);
});

test('actual effort and permission failures remain blocked, full permission still requires confirmation', async () => {
    const f = fixture(); let confirmed, states = 0;
    const bindings = { ...f.bindings, setAgentState: () => { states++; }, rt: key => key, t: key => key, modal: { confirm: options => { confirmed = options; } } };
    const effort = run('const change = ' + callback('onReasoningEffortChange'), bindings, 'change');
    f.failSet('canvas-agent-reasoning-effort'); assert.throws(() => effort('low')); await assert.rejects(f.flushStorageCheckpoints());
    const permission = run('const change = ' + callback('changePermissionMode'), bindings, 'change');
    permission('full'); assert.ok(confirmed); assert.equal(f.writes.length, 1); assert.equal(states, 0);
    f.failSet('canvas-agent-permission-mode'); assert.throws(() => confirmed.onOk()); await assert.rejects(f.flushStorageCheckpoints());
    f.failSet(undefined); permission('safe'); await assert.rejects(f.flushStorageCheckpoints());
    effort('high'); await f.flushStorageCheckpoints(); assert.equal(states, 2);
});

test('actual connection effect prefix preserves guards and rejects Token write before connecting', async () => {
    const f = fixture(); let connects = 0;
    const effect = effectWith('checkpointLocalStorageWrite("canvas-agent-url"');
    const statements = effect.body.statements;
    const stop = statements.findIndex(node => node.getText(panelAst).startsWith('const clientId ='));
    assert.ok(stop > 0);
    // Execute actual statements before EventSource setup, with a sentinel for the next step.
    const body = statements.slice(0, stop).map(node => node.getText(panelAst)).join('\n');
    const invoke = enabled => run('const effect = () => { ' + body + '\nconnect(); }', { ...f.bindings, clientReady: true, enabled, token: 'guan-vault:11111111-1111-4111-8111-111111111111', endpoint: 'http://127.0.0.1:9', connect: () => { connects++; } }, 'effect')();
    invoke(false); assert.equal(f.writes.length, 0);
    f.failSet('canvas-agent-token'); assert.throws(() => invoke(true)); assert.equal(connects, 0);
    assert.equal(f.values.get('canvas-agent-url'), 'http://127.0.0.1:9'); await assert.rejects(f.flushStorageCheckpoints());
    f.failSet(undefined); invoke(true); await f.flushStorageCheckpoints(); assert.equal(connects, 1);
});

test('actual async model-list effect catches business error without erasing save failure', async () => {
    const f = fixture(); let states = 0, errors = 0, finish;
    const effect = effectWith('checkpointLocalStorageWrite("canvas-agent-model", current.model)').getText(panelAst);
    const invoke = () => run('const effect = ' + effect, { ...f.bindings, connected: true, endpoint: '', token: '',
        AGENT_REASONING_EFFORTS: new Set(['high']), fetchAgentJson: () => Promise.resolve({ data: [{ ...models[0], displayName: 'fixture', isDefault: true }] }),
        useAgentStore: { getState: () => ({ model: '', reasoningEffort: '' }) }, setAgentState: () => { states++; finish(); }, rt: key => key,
        addEventLog: () => { errors++; finish(); },
    }, 'effect')();
    f.failSet('canvas-agent-reasoning-effort'); await new Promise(resolve => { finish = resolve; invoke(); });
    assert.equal(errors, 1); assert.equal(states, 0); await assert.rejects(f.flushStorageCheckpoints());
    f.failSet(undefined); await new Promise(resolve => { finish = resolve; invoke(); });
    await f.flushStorageCheckpoints(); assert.equal(states, 1);
});

function bridgeFixture() {
    const f = fixture(), records = new Map(), events = [], replies = []; let listener, deleted = 0, replaced = 0;
    const project = { id: 'fixture-project', title: 'fixture', nodes: [], connections: [] };
    const storeKey = 'infinite-canvas:canvas_store', archiveKey = 'infinite-canvas:product-recycle:fixture-recycle';
    records.set(storeKey, JSON.stringify({ state: { projects: [project], deletedProjects: [] }, version: 0 }));
    records.set(archiveKey, JSON.stringify({ project }));
    const parent = { postMessage: data => replies.push(data) };
    const window = { parent, addEventListener: (_event, callback) => { listener = callback; }, dispatchEvent: event => events.push(event.type) };
    const state = { hydrated: true, openProject: () => project, deleteProjects: () => { deleted++; }, replaceProjects: () => { replaced++; } };
    const markers = load('lib/canvas/product-recycle-markers.js', f.bindings, '{ recycleMarkerKey, filterRecycledProjects }');
    const init = load('services/product-recycle-bridge.ts', { ...f.bindings, ...markers, window, location: { origin: 'http://fixture.invalid' },
        CustomEvent: class { constructor(type) { this.type = type; } }, useCanvasStore: { getState: () => state }, canvasTaskSummary: () => ({ status: 'idle' }),
        localForageStorage: { getItem: async key => records.get(key), setItem: async (key, value) => { records.set(key, value); } },
    }, 'initProductRecycleBridge');
    init();
    const request = (type, eventOverrides = {}) => listener({ origin: 'http://fixture.invalid', source: parent, data: { type, projectId: project.id, recycleId: 'fixture-recycle', requestId: 'fixture-request' }, ...eventOverrides });
    return { ...f, request, records, replies, events, storeKey, archiveKey, deleted: () => deleted, replaced: () => replaced, marker: markers.recycleMarkerKey(project.id) };
}

test('actual recycle marker failure retains archive and original canvas, reports error and blocks save confirmation', async () => {
    const f = bridgeFixture(), original = f.records.get(f.storeKey);
    f.failSet(f.marker); await f.request('guan-product-recycle');
    assert.equal(f.deleted(), 0); assert.equal(f.records.get(f.storeKey), original); assert.ok(f.records.has(f.archiveKey)); assert.equal(f.replies.at(-1).ok, false);
    await assert.rejects(f.flushStorageCheckpoints());
    f.failSet(undefined); await f.request('guan-product-recycle'); await f.flushStorageCheckpoints();
    assert.equal(f.deleted(), 1); assert.equal(f.values.get(f.marker), 'deleted'); assert.equal(f.replies.at(-1).ok, true);
});

test('actual restore marker failure does not replace canvas or clear archive, successful restore recovers its own failure', async () => {
    const f = bridgeFixture(), original = f.records.get(f.storeKey);
    f.values.set(f.marker, 'deleted'); f.failRemove(true); await f.request('guan-product-restore');
    assert.equal(f.replaced(), 0); assert.equal(f.records.get(f.storeKey), original); assert.ok(f.records.has(f.archiveKey)); assert.equal(f.replies.at(-1).ok, false);
    await assert.rejects(f.flushStorageCheckpoints());
    f.failRemove(false); await f.request('guan-product-restore'); await f.flushStorageCheckpoints();
    assert.equal(f.replaced(), 1); assert.equal(f.values.has(f.marker), false); assert.equal(f.replies.at(-1).project.id, 'fixture-project');
});

test('these paths have no remaining unobserved direct writes; rejected foreign messages never mutate', async () => {
    for (const file of [panelFile, 'services/product-recycle-bridge.ts']) assert.doesNotMatch(read(file), /localStorage\.(?:setItem|removeItem)\(/);
    const f = bridgeFixture(); await f.request('irrelevant-message');
    await f.request('guan-product-recycle', { origin: 'http://foreign.invalid' });
    await f.request('guan-product-recycle', { source: {} });
    assert.equal(f.writes.length, 0); assert.equal(f.replies.length, 0); await f.flushStorageCheckpoints();
});
