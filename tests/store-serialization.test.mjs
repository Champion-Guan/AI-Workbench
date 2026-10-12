import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createStore } from '../src/canvas/node_modules/zustand/esm/vanilla.mjs';
import { persist, createJSONStorage } from '../src/canvas/node_modules/zustand/esm/middleware.mjs';
import { createActivityFixture } from './helpers/frontend-activity.mjs';
import { createPersistenceFixture } from './helpers/persistence-checkpoint.mjs';
import { createRecoveryFixture } from './helpers/recovery-read.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function load(file, bindings, expose) {
    const source = readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/\bexport /g, '');
    const context = vm.createContext({ setTimeout, clearTimeout, ...bindings });
    vm.runInContext(ts.transpileModule(body + '\nglobalThis.exposed = ' + expose, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context.exposed;
}
function fixture() {
    const activity = createActivityFixture(), persistence = createPersistenceFixture(), values = new Map();
    const localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
        removeItem: key => { values.delete(key); },
    };
    const bindings = { ...activity, ...persistence, frontendActivity: activity.registry, localStorage, createJSONStorage,
        persist: (creator, options) => persist(creator, { ...options, storage: options.storage && {
            ...options.storage, getItem: name => { const value = options.storage.getItem(name); return value && typeof value.then === 'function' ? Promise.resolve(value) : value; },
        } }), create: initializer => initializer ? createStore(initializer) : createStore, window: { addEventListener() {} }, i18n: { t: key => key } };
    bindings.window.parent = bindings.window;
    bindings.createRecoveryReadGate = createRecoveryFixture(bindings);
    bindings.createCheckpointJsonStorage = load('lib/checkpoint-json-storage.ts', bindings, 'createCheckpointJsonStorage');
    bindings.createCheckpointAsyncJsonStorage = load('lib/checkpoint-async-json-storage.ts', bindings, 'createCheckpointAsyncJsonStorage');
    bindings.checkpointLocalStorageWrite = load('lib/checkpoint-local-storage.ts', bindings, 'checkpointLocalStorageWrite');
    return { ...activity, ...persistence, bindings, localStorage, values };
}

test('async JSON adapter serializes immediately, preserves receiver/envelope, and awaits real asynchronous writes', async () => {
    const f = fixture(), gate = deferred();
    let received;
    const backend = {
        getItem() { assert.equal(this, backend); return Promise.resolve(null); },
        setItem(name, value) { assert.equal(this, backend); received = [name, value]; return gate.promise; },
        removeItem() { assert.equal(this, backend); return Promise.resolve(); },
    };
    const storage = f.bindings.createCheckpointAsyncJsonStorage(() => backend);
    const envelope = { state: { assets: [{ id: 'fixture' }] }, version: 0 };
    const writing = storage.setItem('assets', envelope); assert.deepEqual(received, ['assets', JSON.stringify(envelope)]);
    assert.equal(f.registry.snapshot().storage, 1);
    let done = false; const flushing = f.flushStorageCheckpoints().then(() => { done = true; });
    await tick(); assert.equal(done, false); assert.equal(await storage.getItem('assets'), null);
    gate.resolve(); await writing; await flushing; assert.equal(f.registry.snapshot().storage, 0);
});

test('circular values and throwing toJSON fail synchronously before storage and keep confirmation blocked', async () => {
    const f = fixture(); let writes = 0;
    const storage = f.bindings.createCheckpointAsyncJsonStorage(() => ({ getItem: async () => null, setItem: async () => { writes++; }, removeItem: async () => {} }));
    const cycle = {}; cycle.self = cycle;
    assert.throws(() => storage.setItem('a', cycle)); assert.equal(writes, 0);
    await assert.rejects(f.flushStorageCheckpoints());
    const failure = Error('fixture serializer');
    assert.throws(() => storage.setItem('a', { toJSON() { throw failure; } }), error => error === failure);
    assert.equal(writes, 0); assert.equal(f.registry.snapshot().storage, 0);
    await storage.setItem('a', { state: {} }); await f.flushStorageCheckpoints(); assert.equal(writes, 1);
});

test('asynchronous persistence/remove failures remain caller-visible and require matching successful operations', async () => {
    const f = fixture(); let failed = true;
    const storage = f.bindings.createCheckpointAsyncJsonStorage(() => ({ getItem: async () => null,
        setItem: async () => { if (failed) throw Error('write'); }, removeItem: async () => { if (failed) throw Error('remove'); } }));
    await assert.rejects(storage.setItem('a', { state: {} }), /write/);
    await assert.rejects(storage.removeItem('a'), /remove/); await assert.rejects(f.flushStorageCheckpoints());
    failed = false; await storage.setItem('a', { state: {} }); await assert.rejects(f.flushStorageCheckpoints());
    await storage.removeItem('a'); await f.flushStorageCheckpoints();
});

test('async reader retains Zustand null, JSON parsing and asynchronous read error behavior', async () => {
    const f = fixture(); let value = null, failure = null;
    const storage = f.bindings.createCheckpointAsyncJsonStorage(() => ({ getItem: async () => { if (failure) throw failure; return value; }, setItem: async () => {}, removeItem: async () => {} }));
    assert.equal(await storage.getItem('a'), null);
    value = '{"state":{"plugins":[]},"version":0}';
    assert.equal(JSON.stringify(await storage.getItem('a')), value);
    value = 'invalid-json'; await assert.rejects(storage.getItem('a'));
    failure = Error('read'); await assert.rejects(storage.getItem('a'), error => error === failure);
});

test('unavailable async storage does not write defaults and cannot confirm persistence', async () => {
    const f = fixture();
    assert.equal(f.bindings.createCheckpointAsyncJsonStorage(() => { throw Error('disabled'); }), undefined);
    await assert.rejects(f.flushStorageCheckpoints()); assert.equal(f.values.size, 0);
});

test('real asset store retains custom hydration and partialize while catching pre-queue serialization failure', async () => {
    const f = fixture(), values = new Map();
    const localForageStorage = { getItem: async key => values.get(key) ?? null,
        setItem: async (key, value) => { values.set(key, value); }, removeItem: async key => { values.delete(key); } };
    const { store, storage } = load('stores/use-asset-store.ts', { ...f.bindings, localForageStorage, nanoid: () => 'test-id' }, '{ store: useAssetStore, storage: assetStorage }');
    await store.persist.rehydrate(); await f.flushStorageCheckpoints();
    assert.equal(store.getState().hydrated, true);
    const asset = { id: 'a', kind: 'text', title: 'fixture', coverUrl: '', tags: [], data: { content: 'saved' } };
    store.getState().replaceAssets([asset]); await f.flushStorageCheckpoints();
    const prior = values.get('infinite-canvas:asset_store');
    assert.deepEqual(Object.keys(JSON.parse(prior).state), ['assets']);
    const circular = {}; circular.self = circular;
    assert.throws(() => store.getState().replaceAssets([{ ...asset, metadata: circular }]));
    assert.equal(values.get('infinite-canvas:asset_store'), prior); await assert.rejects(f.flushStorageCheckpoints());
    store.getState().replaceAssets([asset]); await f.flushStorageCheckpoints();
    await storage.removeItem('infinite-canvas:asset_store'); assert.equal(values.size, 0);
});

test('real plugin store keeps original key and actions but serializing invalid source metadata blocks confirmation', async () => {
    const f = fixture(), values = new Map();
    const localForageStorage = { getItem: async key => values.get(key) ?? null,
        setItem: async (key, value) => { values.set(key, value); }, removeItem: async key => { values.delete(key); } };
    const store = load('stores/canvas/use-plugin-store.ts', { ...f.bindings, localForageStorage }, 'usePluginStore');
    await store.persist.rehydrate();
    store.getState().upsert({ id: 'p', name: 'fixture', version: '1', source: '', url: '', enabled: false });
    await f.flushStorageCheckpoints(); const prior = values.get('infinite-canvas:plugin_store');
    const circular = {}; circular.self = circular;
    assert.throws(() => store.getState().upsert({ id: 'p', metadata: circular }));
    assert.equal(values.get('infinite-canvas:plugin_store'), prior); await assert.rejects(f.flushStorageCheckpoints());
    store.getState().remove('p'); await f.flushStorageCheckpoints();
    assert.equal(JSON.parse(values.get('infinite-canvas:plugin_store')).state.plugins.length, 0);
});

test('real theme store preserves persisted theme/default and original envelope; quota failure does not reset disk', async () => {
    const f = fixture();
    f.values.set('infinite-canvas:theme_store', '{"state":{"theme":"light"},"version":0}');
    const store = load('stores/use-theme-store.ts', f.bindings, 'useThemeStore');
    assert.equal(store.getState().theme, 'light');
    const saved = f.localStorage.setItem;
    f.localStorage.setItem = () => { throw Error('quota'); };
    assert.throws(() => store.getState().setTheme('dark'), /quota/);
    assert.equal(JSON.parse(f.values.get('infinite-canvas:theme_store')).state.theme, 'light');
    assert.equal(store.getState().theme, 'dark'); await assert.rejects(f.flushStorageCheckpoints());
    f.localStorage.setItem = saved; store.getState().setTheme('dark'); await f.flushStorageCheckpoints();
    assert.equal(f.values.get('infinite-canvas:theme_store'), '{"state":{"theme":"dark"},"version":0}');
});

test('real prompt source store preserves saved source merge/schedule and partialize without startup overwrite', async () => {
    const f = fixture(), key = 'infinite-canvas:prompt_source_store_v2';
    const saved = { state: { sources: [{ id: 'builtin', builtIn: true, enabled: false }, { id: 'custom', enabled: true }], schedule: { intervalMinutes: 60, lastFetchedAt: 'fixture' } }, version: 0 };
    f.values.set(key, JSON.stringify(saved));
    const store = load('stores/use-prompt-source-store.ts', { ...f.bindings, DEFAULT_PROMPT_SOURCES: [{ id: 'builtin', builtIn: true, enabled: true }], createPromptSource: source => ({ ...source }) }, 'usePromptSourceStore');
    assert.equal(store.getState().sources[0].enabled, false); assert.equal(store.getState().sources[1].id, 'custom');
    assert.equal(store.getState().schedule.intervalMinutes, 60); assert.equal(f.values.get(key), JSON.stringify(saved));
    const circular = {}; circular.self = circular;
    assert.throws(() => store.getState().saveSource({ id: 'broken', metadata: circular })); await assert.rejects(f.flushStorageCheckpoints());
    store.getState().removeSource('broken'); await f.flushStorageCheckpoints();
    assert.deepEqual(Object.keys(JSON.parse(f.values.get(key)).state), ['sources', 'schedule']);
});

test('real sidebar store preserves write-before-state/timer semantics, and unrelated preferences cannot clear failures', async () => {
    const f = fixture(), timers = [];
    const store = load('stores/use-canvas-side-panel-store.ts', { ...f.bindings, setTimeout: fn => { timers.push(fn); } }, 'useCanvasSidePanelStore');
    const saved = f.localStorage.setItem;
    f.localStorage.setItem = (key, value) => { if (key === 'canvas-generation-history-sorted') throw Error('quota'); saved(key, value); };
    assert.throws(() => store.getState().toggleHistorySorted(), /quota/); assert.equal(store.getState().historySorted, false);
    store.getState().closePanel(); assert.equal(store.getState().panelClosing, true);
    assert.equal(f.values.get('canvas-side-panel-open'), '0'); await assert.rejects(f.flushStorageCheckpoints());
    timers.shift()(); assert.equal(store.getState().panelMounted, false);
    f.localStorage.setItem = saved; store.getState().toggleHistorySorted(); await f.flushStorageCheckpoints();
    assert.equal(f.values.get('canvas-generation-history-sorted'), '1');
});

test('real Agent connection store does not enable connection if token saving fails; explicit retry keeps same keys', async () => {
    const f = fixture();
    const store = load('stores/use-agent-store.ts', { ...f.bindings, URL }, 'useAgentStore');
    const reference = 'guan-vault:11111111-1111-4111-8111-111111111111';
    store.setState({ url: 'http://example.invalid/', token: reference });
    const saved = f.localStorage.setItem;
    f.localStorage.setItem = (key, value) => { if (key === 'canvas-agent-token') throw Error('quota'); saved(key, value); };
    assert.throws(() => store.getState().connectAgent(), /quota/); assert.equal(store.getState().enabled, false);
    assert.equal(f.values.get('canvas-agent-url'), 'http://example.invalid'); await assert.rejects(f.flushStorageCheckpoints());
    f.localStorage.setItem = saved; store.getState().connectAgent(); await f.flushStorageCheckpoints();
    assert.equal(store.getState().enabled, true); assert.equal(f.values.get('canvas-agent-token'), reference);
    assert.equal(f.registry.snapshot().storage, 0);
});

test('synchronous direct preference writes invalidate prior receipts and keep original exceptions', async () => {
    const f = fixture(), epoch = '11111111-1111-4111-8111-111111111111';
    f.barrier.registerFlush(f.flushStorageCheckpoints);
    const receipt = await f.barrier.drain(epoch); assert.equal(f.barrier.isAcknowledged(receipt), true);
    const failure = Error('quota'); f.localStorage.setItem = () => { throw failure; };
    assert.throws(() => f.bindings.checkpointLocalStorageWrite('preference', '1'), error => error === failure);
    assert.equal(f.barrier.isAcknowledged(receipt), false); await assert.rejects(f.flushStorageCheckpoints());
    f.barrier.resume(epoch); f.barrier.dispose();
});
