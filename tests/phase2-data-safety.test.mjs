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
const read = file => readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function load(file, bindings, expose, names) {
    const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const body = ast.statements.filter(node => !ts.isImportDeclaration(node) && (!names || ts.isFunctionDeclaration(node) && names.includes(node.name?.text))).map(node => node.getText(ast)).join('\n').replace(/\bexport /g, '');
    const context = vm.createContext(bindings);
    vm.runInContext(ts.transpileModule(body + '\nglobalThis.api = ' + expose, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context.api;
}
function fixture() {
    const activity = createActivityFixture(), persistence = createPersistenceFixture();
    const bindings = { ...activity, ...persistence, frontendActivity: activity.registry, createJSONStorage,
        create: creator => creator ? createStore(creator) : createStore,
        // Bridge VM Promise identity only; use actual Zustand persistence.
        persist: (creator, options) => persist(creator, { ...options, storage: {
            ...options.storage, getItem: name => { const value = options.storage.getItem(name); return value && typeof value.then === 'function' ? Promise.resolve(value) : value; },
        } }), nanoid: () => 'fixture-id', i18n: { t: key => key }, filterRecycledProjects: projects => projects,
    };
    bindings.createRecoveryReadGate = createRecoveryFixture(bindings);
    bindings.createCheckpointAsyncJsonStorage = load('lib/checkpoint-async-json-storage.ts', bindings, 'createCheckpointAsyncJsonStorage');
    bindings.createCheckpointJsonStorage = load('lib/checkpoint-json-storage.ts', bindings, 'createCheckpointJsonStorage');
    return { ...activity, ...persistence, bindings };
}

test('failed synchronous restore preserves original rejection and blocks writes until a confirmed read', async () => {
    const f = fixture(), gate = f.bindings.createRecoveryReadGate(), error = Error('fixture-read');
    assert.throws(() => gate.read('config', () => { throw error; }), failure => failure === error);
    assert.throws(() => gate.assertWritable('config'), /recovery incomplete/); gate.assertWritable('other');
    await assert.rejects(f.flushStorageCheckpoints());
    assert.equal(gate.read('config', () => 7), 7); gate.assertWritable('config'); await f.flushStorageCheckpoints();
});

test('pending async restore stays busy and cannot be overwritten, including falsey failures', async () => {
    for (const reason of [undefined, null, false, 0, '']) {
        const f = fixture(), gate = f.bindings.createRecoveryReadGate(), pending = deferred();
        const reading = gate.read('assets', () => pending.promise);
        assert.equal(f.registry.snapshot().storage, 1); assert.throws(() => gate.assertWritable('assets'));
        const rejected = assert.rejects(reading, error => error === reason); pending.reject(reason); await rejected;
        assert.equal(f.registry.snapshot().storage, 0); assert.throws(() => gate.assertWritable('assets')); await assert.rejects(f.flushStorageCheckpoints());
        await gate.read('assets', async () => null); gate.assertWritable('assets'); await f.flushStorageCheckpoints();
    }
});

test('throwing then accessor does not leak a restore lease or permit overwriting unread data', async () => {
    const f = fixture(), gate = f.bindings.createRecoveryReadGate();
    const value = Object.defineProperty({}, 'then', { get() { throw Error('fixture-accessor'); } });
    assert.throws(() => gate.read('config', () => value), /fixture-accessor/);
    assert.equal(f.registry.snapshot().storage, 0);
    assert.throws(() => gate.assertWritable('config')); await assert.rejects(f.flushStorageCheckpoints());
    gate.read('config', () => null); gate.assertWritable('config'); await f.flushStorageCheckpoints();
});

test('preview decode or persistence failure cannot be cached as a valid negative preview', async () => {
    const f = fixture(), writes = []; let decodeFails = true, saveFails = false;
    const save = load('services/image-storage.ts', { ...f.bindings,
        previewCheckpoint: f.createPersistenceCheckpoint(), IMAGE_PREVIEW_VERSION: 1,
        createImageThumbnail: async () => { if (decodeFails) throw Error('fixture-decode'); return undefined; },
        previewStore: { setItem: async (key, value) => { if (saveFails) throw Error('fixture-save'); writes.push([key, value]); } },
        cacheImagePreview: () => { throw Error('unexpected cache'); },
    }, 'storeImagePreview', ['storeImagePreview']);
    await save('image:kept', {}); assert.equal(writes.length, 0); await assert.rejects(f.flushStorageCheckpoints());
    decodeFails = false; saveFails = true;
    await assert.rejects(save('image:kept', {}), /fixture-save/); await assert.rejects(f.flushStorageCheckpoints());
    saveFails = false; await save('image:kept', {}); await f.flushStorageCheckpoints();
    assert.equal(writes.length, 1); assert.equal(writes[0][1].version, 1); assert.equal(writes[0][1].blob, undefined);
});

test('overlapping successful read cannot erase an earlier failed read; explicit non-overlapping retry recovers', async () => {
    const f = fixture(), gate = f.bindings.createRecoveryReadGate(), a = deferred(), b = deferred();
    const failed = assert.rejects(gate.read('canvas', () => a.promise)), succeeded = gate.read('canvas', () => b.promise);
    a.reject(Error('fixture')); await failed; b.resolve('valid'); await succeeded;
    assert.throws(() => gate.assertWritable('canvas')); await assert.rejects(f.flushStorageCheckpoints());
    await gate.read('canvas', async () => 'valid'); gate.assertWritable('canvas'); await f.flushStorageCheckpoints();
});

test('real synchronous JSON adapter never replaces or deletes a damaged private record', async () => {
    const f = fixture(); let value = '{damaged-fixture', writes = 0, removals = 0;
    const storage = f.bindings.createCheckpointJsonStorage(() => ({ getItem: () => value, setItem: (_key, next) => { writes++; value = next; }, removeItem: () => { removals++; value = null; } }));
    assert.throws(() => storage.getItem('config')); assert.throws(() => storage.setItem('config', { state: {} }));
    assert.throws(() => storage.removeItem('config')); assert.equal(value, '{damaged-fixture'); assert.equal(writes + removals, 0);
    await assert.rejects(f.flushStorageCheckpoints());
    value = '{"state":{"model":"restored"},"version":0}'; assert.equal(storage.getItem('config').state.model, 'restored');
    storage.setItem('config', { state: { model: 'restored' }, version: 0 }); await assert.rejects(f.flushStorageCheckpoints(), 'a previously denied remove is not silently replayed');
    storage.removeItem('config'); await f.flushStorageCheckpoints(); assert.equal(writes, 1); assert.equal(removals, 1);
});

test('real async JSON adapter refuses early save while hydration is pending, then permits explicit save', async () => {
    const f = fixture(), pending = deferred(); let writes = 0;
    const storage = f.bindings.createCheckpointAsyncJsonStorage(() => ({ getItem: () => pending.promise, setItem: async () => { writes++; }, removeItem: async () => {} }));
    const reading = storage.getItem('plugins'); assert.throws(() => storage.setItem('plugins', { state: { plugins: [] } })); assert.equal(writes, 0);
    pending.resolve('{"state":{"plugins":[{"id":"kept"}]},"version":0}'); assert.equal((await reading).state.plugins[0].id, 'kept');
    await storage.setItem('plugins', { state: { plugins: [{ id: 'kept' }] }, version: 0 }); await f.flushStorageCheckpoints(); assert.equal(writes, 1);
});

test('real canvas Zustand recovery never marks damaged state loaded or persists an empty replacement', async () => {
    const f = fixture(); let value = 'damaged-fixture', writes = 0;
    const api = load('stores/canvas/use-canvas-store.ts', { ...f.bindings, localForageStorage: {
        getItem: async () => value, setItem: async (_key, next) => { writes++; value = next; }, removeItem: async () => {},
    } }, '{ store: useCanvasStore, flush: flushCanvasPersistence, storage: canvasStorage }');
    await tick(); assert.equal(api.store.getState().hydrated, false); assert.equal(writes, 0); await assert.rejects(f.flushStorageCheckpoints());
    api.store.getState().createProject('unrestored-edit'); await assert.rejects(api.flush()); assert.equal(writes, 0); assert.equal(value, 'damaged-fixture');
    value = JSON.stringify({ state: { projects: [{ id: 'original', title: 'kept', nodes: [], connections: [], imageInfoDefaultVersion: 1 }], deletedProjects: [] }, version: 0 });
    await api.store.persist.rehydrate(); assert.equal(api.store.getState().hydrated, true); assert.equal(api.store.getState().projects[0].id, 'original');
    api.store.getState().updateProject('original', { title: 'verified' }); await api.flush(); await f.flushStorageCheckpoints();
    assert.equal(JSON.parse(value).state.projects[0].title, 'verified');
});

test('real asset Zustand edit after failed restore cannot erase the existing asset record', async () => {
    const f = fixture(); let value = 'damaged-fixture', writes = 0;
    const store = load('stores/use-asset-store.ts', { ...f.bindings, localForageStorage: {
        getItem: async () => value, setItem: async (_key, next) => { writes++; value = next; }, removeItem: async () => {},
    } }, 'useAssetStore');
    await tick(); assert.equal(store.getState().hydrated, false);
    assert.throws(() => store.getState().replaceAssets([]), /recovery incomplete/); assert.equal(value, 'damaged-fixture'); assert.equal(writes, 0);
    await assert.rejects(f.flushStorageCheckpoints());
    value = JSON.stringify({ state: { assets: [{ id: 'original', kind: 'text', data: { content: 'kept' } }] }, version: 0 });
    await store.persist.rehydrate(); await f.flushStorageCheckpoints(); assert.equal(store.getState().assets[0].id, 'original');
});

test('automatic media cleanup preserves videos in history/recycled products and newly saved media', async () => {
    const f = fixture(), originals = new Map([['video:history', 'history'], ['video:recycled', 'recycled'], ['audio:new', 'pending']]); let removals = 0;
    const cleanup = load('services/file-storage.ts', { ...f.bindings, store: {
        iterate: async callback => { for (const [key, value] of originals) callback(value, key); originals.set('video:late', 'late-save'); },
        removeItem: async key => { removals++; originals.delete(key); },
    } }, 'cleanupUnusedMedia', ['cleanupUnusedMedia', 'cleanupUnusedMediaImpl', 'collectMediaStorageKeys']);
    const result = await cleanup({ assets: [], projects: [], extra: [] });
    assert.equal(result.status, 'retained'); assert.equal(result.candidates, 3); assert.equal(removals, 0); assert.equal(originals.size, 4);
});

test('automatic image cleanup retains originals and previews despite incomplete reference snapshots', async () => {
    const f = fixture(); let deletes = 0;
    const cleanup = load('services/image-storage.ts', { ...f.bindings,
        imageLogStore: { iterate: async callback => callback({ storageKey: 'image:history' }) }, videoLogStore: { iterate: async () => {} },
        store: { iterate: async callback => { callback({}, 'image:history'); callback({}, 'image:recycled'); } }, previewStore: { iterate: async callback => callback({}, 'image:recycled') },
        deleteStoredImages: async () => { deletes++; }, deleteImagePreview: async () => { deletes++; },
    }, 'cleanupUnusedImages', ['cleanupUnusedImages', 'cleanupUnusedImagesImpl', 'collectImageStorageKeys']);
    const result = await cleanup({ assets: [], projects: [] }); assert.equal(result.status, 'retained'); assert.equal(result.candidates, 1); assert.equal(result.previews, 1); assert.equal(deletes, 0);
});

test('explicit user media deletion still deletes only requested keys and does not become global cleanup', async () => {
    const f = fixture(), removed = [];
    const remove = load('services/file-storage.ts', { ...f.bindings, objectUrls: new Map(), URL: { revokeObjectURL() {} }, store: { removeItem: async key => removed.push(key) } }, 'deleteStoredMedia', ['deleteStoredMedia', 'deleteStoredMediaImpl']);
    await remove(['video:chosen', 'video:chosen']); assert.deepEqual(removed, ['video:chosen']);
});
