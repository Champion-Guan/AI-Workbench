import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createStore } from '../src/canvas/node_modules/zustand/esm/vanilla.mjs';
import { persist, createJSONStorage } from '../src/canvas/node_modules/zustand/esm/middleware.mjs';
import { createActivityFixture } from './helpers/frontend-activity.mjs';
import { createPersistenceFixture } from './helpers/persistence-checkpoint.mjs';
import { createRecoveryFixture } from './helpers/recovery-read.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function source(file) { return readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8'); }
function run(body, bindings, expose) {
    const context = vm.createContext({ setTimeout, clearTimeout, ...bindings });
    vm.runInContext(ts.transpileModule(body.replace(/\bexport /g, '') + '\nglobalThis.api = ' + expose, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context.api;
}
function load(file, bindings, expose) {
    const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
    return run(ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n'), bindings, expose);
}
function expression(file, name) {
    const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let result;
    const visit = node => { if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.name?.getText(ast) === name) result = node.initializer; ts.forEachChild(node, visit); };
    visit(ast); if (!result) throw Error('Missing callback ' + name);
    return result.getText(ast);
}
function functions(file, names) {
    const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
    return ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
}
function fixture() {
    const activity = createActivityFixture(), persistence = createPersistenceFixture(), values = new Map();
    const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
    const bindings = { ...activity, ...persistence, frontendActivity: activity.registry, localStorage, persist, createJSONStorage,
        create: initializer => initializer ? createStore(initializer) : createStore };
    bindings.createRecoveryReadGate = createRecoveryFixture(bindings);
    bindings.assetReadGate = bindings.createRecoveryReadGate();
    bindings.schedulePersistenceTask = load('lib/scheduled-persistence.ts', bindings, 'schedulePersistenceTask');
    Object.assign(bindings, load('lib/checkpoint-local-storage.ts', bindings, '{ checkpointLocalStorageWrite, checkpointLocalStorageJsonWrite, checkpointLocalStorageRemove }'));
    bindings.createCheckpointAsyncJsonStorage = load('lib/checkpoint-async-json-storage.ts', bindings, 'createCheckpointAsyncJsonStorage');
    return { ...activity, ...persistence, bindings, localStorage, values };
}

test('scheduled persistence stays busy before the timer fires and through operation completion; duplicate callback is ignored', async () => {
    const f = fixture(), gate = deferred(); let start, calls = 0;
    const running = f.bindings.schedulePersistenceTask('cleanup', fn => { start = fn; }, async () => { calls++; await gate.promise; return 7; });
    assert.equal(f.registry.snapshot().storage, 1); let done = false;
    const flushing = f.flushStorageCheckpoints().then(() => { done = true; }); await tick(); assert.equal(done, false);
    start(); start(); await tick(); assert.equal(calls, 1); assert.equal(f.registry.snapshot().storage, 1);
    gate.resolve(); assert.equal(await running, 7); await flushing; assert.equal(f.registry.snapshot().storage, 0);
});

test('scheduled failure stays blocked, does not replay itself, and only a later explicit success recovers', async () => {
    const f = fixture(); let calls = 0;
    await assert.rejects(f.bindings.schedulePersistenceTask('cleanup', fn => fn(), () => { calls++; throw Error('failed'); }));
    await assert.rejects(f.flushStorageCheckpoints()); await tick(); assert.equal(calls, 1);
    await f.bindings.schedulePersistenceTask('cleanup', fn => fn(), () => { calls++; });
    await f.flushStorageCheckpoints(); assert.equal(calls, 2);
});

test('scheduler failure before start prevents a late callback; after start it waits for already launched work', async () => {
    const f = fixture(); let late, calls = 0;
    await assert.rejects(f.bindings.schedulePersistenceTask('before', fn => { late = fn; throw Error('scheduler'); }, () => { calls++; }));
    late(); await tick(); assert.equal(calls, 0);
    const gate = deferred(); let finished = false;
    const rejected = assert.rejects(f.bindings.schedulePersistenceTask('after', fn => { fn(); throw Error('scheduler'); }, () => gate.promise), /scheduler/).then(() => { finished = true; });
    await tick(); assert.equal(finished, false); assert.equal(f.registry.snapshot().storage, 1);
    gate.resolve(); await rejected; assert.equal(f.registry.snapshot().storage, 0); await assert.rejects(f.flushStorageCheckpoints());
});

test('aborting a page drain never retires a queued persistence timer', async () => {
    const f = fixture(), controller = new AbortController(); let start;
    f.barrier.registerFlush(f.flushStorageCheckpoints);
    const running = f.bindings.schedulePersistenceTask('cleanup', fn => { start = fn; }, () => undefined);
    const epoch = '11111111-1111-4111-8111-111111111111';
    const rejected = assert.rejects(f.barrier.drain(epoch, controller.signal));
    controller.abort(); await rejected; assert.equal(f.registry.snapshot().storage, 1);
    start(); await running; assert.equal(f.registry.snapshot().storage, 0);
    f.barrier.resume(epoch); f.barrier.dispose();
});

test('actual asset cleanup is busy when scheduled and waits sequential image/media cleanup using current assets', async () => {
    const f = fixture(), timers = [], images = deferred(), media = deferred(), calls = [];
    let assets = ['initial'];
    const body = expression('stores/use-asset-store.ts', 'cleanupImages').replace('await import("@/stores/canvas/use-canvas-store")', 'await loadCanvas()');
    const cleanup = run('const cleanup = ' + body, { ...f.bindings, window: { setTimeout: fn => { timers.push(fn); } },
        get: () => ({ assets }), loadCanvas: async () => ({ useCanvasStore: { getState: () => ({ projects: ['project'] }) } }),
        cleanupUnusedImages: data => { calls.push(['images', data]); return images.promise; },
        cleanupUnusedMedia: data => { calls.push(['media', data]); return media.promise; },
    }, 'cleanup');
    cleanup('extra'); assert.equal(f.registry.snapshot().storage, 1); assets = ['latest'];
    const flushing = f.flushStorageCheckpoints(); timers.shift()(); await tick();
    assert.equal(calls.length, 1); assert.deepEqual(calls[0][1].assets, ['latest']);
    images.resolve(); await tick(); assert.equal(calls.length, 2); assert.equal(f.registry.snapshot().storage, 1);
    media.resolve(); await flushing; assert.equal(f.registry.snapshot().storage, 0);
});

test('failed actual asset cleanup does not run the subsequent media cleanup or automatically retry', async () => {
    const f = fixture(); let start, mediaCalls = 0;
    const body = expression('stores/use-asset-store.ts', 'cleanupImages').replace('await import("@/stores/canvas/use-canvas-store")', 'await loadCanvas()');
    const cleanup = run('const cleanup = ' + body, { ...f.bindings, window: { setTimeout: fn => { start = fn; } }, get: () => ({ assets: [] }),
        loadCanvas: async () => ({ useCanvasStore: { getState: () => ({ projects: [] }) } }),
        cleanupUnusedImages: async () => { throw Error('failed'); }, cleanupUnusedMedia: async () => { mediaCalls++; },
    }, 'cleanup');
    cleanup(); start(); await assert.rejects(f.flushStorageCheckpoints()); await tick();
    assert.equal(mediaCalls, 0); assert.equal(f.registry.snapshot().storage, 0);
});

test('actual asset restore waits all started siblings and preview lookup before reporting a branch failure', async () => {
    const f = fixture(), preview = deferred(); let ended = false;
    const storage = run('const storage = ' + expression('stores/use-asset-store.ts', 'assetStorage'), { ...f.bindings,
        assetRecovery: f.createPersistenceCheckpoint(), assetPersistence: {},
        localForageStorage: { getItem: async () => JSON.stringify({ state: { assets: [
            { kind: 'video', data: { storageKey: 'video:1', url: '' } }, { kind: 'image', coverUrl: '', data: { storageKey: 'image:1', dataUrl: '' } },
        ] } }) }, resolveMediaUrl: async () => { throw Error('video branch'); }, ensureImagePreview: () => preview.promise, resolveImageUrl: async () => 'resolved',
    }, 'storage');
    const rejected = assert.rejects(storage.getItem('assets'), /video branch/).then(() => { ended = true; });
    await tick(); assert.equal(ended, false); assert.ok(f.registry.snapshot().storage > 0);
    preview.resolve(); await rejected; assert.equal(f.registry.snapshot().storage, 0); await assert.rejects(f.flushStorageCheckpoints());
});

test('failed real Zustand asset hydration leaves original disk untouched instead of saving an empty default', async () => {
    const f = fixture(), key = 'infinite-canvas:asset_store'; let stored = 'corrupt-fixture', writes = 0;
    const localForageStorage = { getItem: async () => stored, setItem: async (_key, value) => { writes++; stored = value; }, removeItem: async () => {} };
    // Zustand uses instanceof Promise. Source callbacks run in vm realms;
    // bridge only that realm boundary so real middleware sees browser-equivalent promises.
    const asyncPersist = (creator, options) => persist(creator, { ...options, storage: {
        ...options.storage, getItem: name => Promise.resolve(options.storage.getItem(name)),
    } });
    const store = load('stores/use-asset-store.ts', { ...f.bindings, persist: asyncPersist, localForageStorage, nanoid: () => 'test-id' }, 'useAssetStore');
    await tick(); assert.equal(store.getState().hydrated, false); assert.equal(writes, 0); assert.equal(stored, 'corrupt-fixture');
    await assert.rejects(f.flushStorageCheckpoints());
    stored = JSON.stringify({ state: { assets: [{ id: 'a', kind: 'text', data: { content: 'original' } }] }, version: 0 });
    await store.persist.rehydrate(); await f.flushStorageCheckpoints();
    assert.equal(store.getState().hydrated, true); assert.equal(store.getState().assets[0].data.content, 'original'); assert.equal(writes, 1);
    assert.match(source('stores/use-asset-store.ts'), /name: ASSET_STORE_KEY/); assert.equal(key, 'infinite-canvas:asset_store');
});

test('actual image/media deletions wait unfinished siblings before releasing their outer activity', async () => {
    for (const kind of ['image', 'media']) {
        const f = fixture(), gate = deferred(); let done = false;
        const file = `services/${kind === 'image' ? 'image' : 'file'}-storage.ts`;
        const name = kind === 'image' ? 'deleteStoredImages' : 'deleteStoredMedia';
        const deletion = run(functions(file, [name, name + 'Impl']), { ...f.bindings, objectUrls: new Map(), URL: { revokeObjectURL() {} },
            deleteImagePreview: async () => {}, store: { removeItem: key => key === 'failed' ? Promise.reject(Error('failed')) : gate.promise },
        }, name);
        const rejected = assert.rejects(deletion(['failed', 'slow']), /failed/).then(() => { done = true; });
        await tick(); assert.equal(done, false); assert.equal(f.registry.snapshot().storage, 1);
        gate.resolve(); await rejected; assert.equal(f.registry.snapshot().storage, 0);
    }
});

test('falsey rejection reasons cannot mark failed asset recovery as successful or save defaults', async () => {
    for (const error of [undefined, null, false, 0, '']) {
        const f = fixture(); let writes = 0;
        const localForageStorage = { getItem: () => Promise.reject(error), setItem: async () => { writes++; }, removeItem: async () => {} };
        const asyncPersist = (creator, options) => persist(creator, { ...options, storage: { ...options.storage, getItem: name => Promise.resolve(options.storage.getItem(name)) } });
        const store = load('stores/use-asset-store.ts', { ...f.bindings, persist: asyncPersist, localForageStorage }, 'useAssetStore');
        await tick(); assert.equal(store.getState().hydrated, false); assert.equal(writes, 0);
        await assert.rejects(f.flushStorageCheckpoints());
    }
});

test('image cleanup waits history-index siblings before failing and does not start deletion on unreadable index', async () => {
    const f = fixture(), gate = deferred(); let done = false, deletions = 0;
    const cleanup = run(functions('services/image-storage.ts', ['cleanupUnusedImages', 'cleanupUnusedImagesImpl']), { ...f.bindings,
        collectImageStorageKeys: () => new Set(), imageLogStore: { iterate: async () => { throw Error('index'); } }, videoLogStore: { iterate: () => gate.promise },
        store: { iterate: async () => { deletions++; } }, previewStore: {}, deleteStoredImages: async () => { deletions++; },
    }, 'cleanupUnusedImages');
    const rejected = assert.rejects(cleanup({}), /index/).then(() => { done = true; }); await tick();
    assert.equal(done, false); assert.equal(deletions, 0); assert.equal(f.registry.snapshot().storage, 1);
    gate.resolve(); await rejected; assert.equal(deletions, 0);
});

test('direct JSON/removal persistence retains failures, keys and original serialization/deletion behavior', async () => {
    const f = fixture(), { checkpointLocalStorageJsonWrite: save, checkpointLocalStorageRemove: remove } = f.bindings;
    save('tools', { ids: ['fixture'] }); assert.equal(f.values.get('tools'), '{"ids":["fixture"]}');
    const circular = {}; circular.self = circular;
    assert.throws(() => save('tools', circular)); await assert.rejects(f.flushStorageCheckpoints());
    save('tools', {}); await f.flushStorageCheckpoints();
    const original = f.localStorage.removeItem; f.localStorage.removeItem = () => { throw Error('quota'); };
    assert.throws(() => remove('tools'), /quota/); await assert.rejects(f.flushStorageCheckpoints());
    f.localStorage.removeItem = original; remove('tools'); await f.flushStorageCheckpoints(); assert.equal(f.values.size, 0);
});

test('actual width resize callbacks save existing keys and preserve clamping/event cleanup order', async () => {
    for (const kind of ['canvas', 'agent']) {
        const f = fixture(), listeners = new Map(), events = [];
        const resize = run('const resize = ' + expression(`components/${kind}/${kind === 'canvas' ? 'canvas-side-panel' : 'agent-panel'}.tsx`, 'startResize'), { ...f.bindings,
            width: 400, CANVAS_SIDE_PANEL_MIN_WIDTH: 220, CANVAS_SIDE_PANEL_MAX_WIDTH: 480,
            window: { addEventListener: (name, fn) => { listeners.set(name, fn); }, removeEventListener: name => { listeners.delete(name); events.push(name); } },
            setWidth: value => events.push(value), setAgentState: patch => events.push(patch.width), setResizing: value => events.push(value),
        }, 'resize');
        resize({ preventDefault() {}, clientX: 200 }); listeners.get('pointermove')({ clientX: kind === 'canvas' ? 800 : -800 }); listeners.get('pointerup')();
        assert.equal(f.values.get(`canvas-${kind === 'canvas' ? 'side' : 'agent'}-panel-width`), kind === 'canvas' ? '480' : '760');
        assert.equal(listeners.size, 0); assert.equal(events.at(-1), false); await f.flushStorageCheckpoints();
    }
});

test('actual title callback still renames on storage failure but checkpoint refuses confirmation', async () => {
    const f = fixture(), renamed = [], window = { dispatchEvent() {} }; window.parent = window;
    const rename = run('const rename = ' + expression('pages/canvas/project.tsx', 'finishTitleEditing'), { ...f.bindings,
        useCallback: fn => fn, titleDraft: ' product ', workbenchProductId: 'product', projectId: 'canvas',
        renameProject: (...args) => renamed.push(args), setTitleEditing() {}, window, CustomEvent: class {},
    }, 'rename');
    const write = f.localStorage.setItem; f.localStorage.setItem = () => { throw Error('quota'); };
    rename(); assert.deepEqual(renamed[0], ['canvas', 'product']); await assert.rejects(f.flushStorageCheckpoints());
    f.localStorage.setItem = write; rename(); await f.flushStorageCheckpoints(); assert.equal(f.values.get('guan-canvas-title:product'), 'product');
});
