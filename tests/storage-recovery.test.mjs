import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createPersistenceFixture } from './helpers/persistence-checkpoint.mjs';
import { createActivityFixture } from './helpers/frontend-activity.mjs';

function activityRegistry() {
    const source = readFileSync(new URL('../src/canvas/lib/update-activity.ts', import.meta.url), 'utf8').replace(/export /g, '');
    const context = vm.createContext({});
    vm.runInContext(ts.transpileModule(source + '\nglobalThis.registry = frontendActivity;', {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
    return context.registry;
}

function storage(frontendActivity = activityRegistry()) {
    const disk = new Map(), recovery = new Map();
    const backend = {
        config() {},
        async getItem(key) { return disk.get(key) ?? null; },
        async setItem(key, value) { disk.set(key, value); },
        async removeItem(key) { disk.delete(key); },
    };
    const localStorage = {
        getItem: key => recovery.get(key) ?? null,
        setItem: (key, value) => recovery.set(key, value),
        removeItem: key => recovery.delete(key),
    };
    const source = readFileSync(new URL('../src/canvas/lib/localforage-storage.ts', import.meta.url), 'utf8')
        .replace(/^import .*;$/gm, '').replace('export const localForageStorage', 'const localForageStorage');
    const persistence = createPersistenceFixture();
    const context = vm.createContext({ localforage: backend, window: { localStorage }, frontendActivity, ...persistence });
    vm.runInContext(ts.transpileModule(source.replace('export async function', 'async function') + '\nglobalThis.storage = localForageStorage; globalThis.flush = flushLocalForagePersistence;', {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText, context);
    return { api: context.storage, backend, disk, recovery, localStorage, frontendActivity, flush: context.flush, ...persistence };
}

test('failed IndexedDB write takes precedence over stale data and successful recovery cleans fallback', async () => {
    const { api, backend, disk, recovery, frontendActivity, flush, flushStorageCheckpoints } = storage();
    disk.set('canvas', 'old');
    const write = backend.setItem;
    backend.setItem = async () => { throw Error('offline'); };
    await api.setItem('canvas', 'new');
    assert.equal(await api.getItem('canvas'), 'new');
    await assert.rejects(flush(), /incomplete/);
    await assert.rejects(flushStorageCheckpoints(), /incomplete/);
    backend.setItem = write;
    await api.setItem('canvas', 'latest');
    assert.equal(await api.getItem('canvas'), 'latest');
    assert.equal(recovery.size, 0);
    assert.equal(frontendActivity.snapshot().storage, 0);
    await flush(); await flushStorageCheckpoints();
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('explicit local flush waits queued writes and newer writes submitted while draining', async () => {
    const { api, backend, disk, flush, flushStorageCheckpoints, frontendActivity } = storage();
    const firstGate = deferred(), lastGate = deferred();
    const committed = [];
    backend.setItem = async (key, value) => {
        if (value === 'first') await firstGate.promise;
        if (value === 'last') await lastGate.promise;
        committed.push(value); disk.set(key, value);
    };
    const first = api.setItem('canvas', 'first');
    let done = false;
    const flushing = flush().then(() => { done = true; });
    await tick();
    const last = api.setItem('canvas', 'last');
    assert.equal(frontendActivity.snapshot().storage, 2);
    firstGate.resolve(); await first; await tick();
    assert.equal(done, false);
    lastGate.resolve(); await last; await flushing; await flushStorageCheckpoints();
    assert.deepEqual(committed, ['first', 'last']);
    assert.equal(await api.getItem('canvas'), 'last');
});

test('a later successful FIFO replacement supersedes an older failed commit without retrying the old value', async () => {
    const { api, backend, disk, flush, flushStorageCheckpoints } = storage();
    const gate = deferred(), calls = [];
    backend.setItem = async (key, value) => {
        calls.push(value);
        if (value === 'failed') { await gate.promise; throw Error('offline'); }
        disk.set(key, value);
    };
    const first = api.setItem('canvas', 'failed'); await tick();
    const newer = api.setItem('canvas', 'newer'); const flushing = flush();
    gate.resolve(); await Promise.all([first, newer, flushing]); await flushStorageCheckpoints();
    assert.deepEqual(calls, ['failed', 'newer']); assert.equal(disk.get('canvas'), 'newer');
});

test('another key succeeding cannot clear failed primary persistence; flush never writes recovery automatically', async () => {
    const { api, backend, disk, recovery, flush } = storage();
    const calls = [];
    backend.setItem = async (key, value) => { calls.push(key); if (key === 'canvas') throw Error('offline'); disk.set(key, value); };
    await api.setItem('canvas', 'recovery'); await api.setItem('plugin', 'saved');
    const before = [...recovery];
    await assert.rejects(flush(), error => error.message === 'Local persistence incomplete');
    await assert.rejects(flush());
    assert.deepEqual(calls, ['canvas', 'plugin']); assert.deepEqual([...recovery], before);
});

test('staging quota failure can be certified by exact primary read-back with no conflicting recovery copies', async () => {
    const { api, localStorage, disk, flush, frontendActivity } = storage();
    const save = localStorage.setItem;
    localStorage.setItem = () => { throw Error('quota'); };
    await api.setItem('canvas', 'saved-on-primary');
    assert.equal(disk.get('canvas'), 'saved-on-primary');
    await flush(); assert.equal(frontendActivity.snapshot().storage, 0);
    localStorage.setItem = save;
    await api.setItem('canvas', 'latest'); await flush();
});

test('primary quota recovery refuses mismatched read-back and never deletes existing fallback conflicts', async () => {
    for (const conflict of ['mismatch', 'fallback', 'tombstone', 'unreadable']) {
        const f = storage(); f.localStorage.setItem = () => { throw Error('quota'); };
        if (conflict === 'mismatch') f.backend.getItem = async () => 'wrong';
        if (conflict === 'fallback') f.recovery.set('canvas', 'old-recovery');
        if (conflict === 'tombstone') f.recovery.set('infinite-canvas:fallback:canvas', 'deleted:old');
        if (conflict === 'unreadable') f.localStorage.getItem = () => { throw Error('read'); };
        const before = [...f.recovery]; await f.api.setItem('canvas', 'new');
        await assert.rejects(f.flush()); assert.deepEqual([...f.recovery], before); assert.equal(f.disk.get('canvas'), 'new');
    }
});

test('quota recovery read-back remains busy, rejects a late conflicting fallback and does not erase it', async () => {
    const f = storage(), read = deferred(); let started = false;
    f.localStorage.setItem = () => { throw Error('quota'); };
    f.backend.getItem = () => { started = true; return read.promise; };
    const writing = f.api.setItem('canvas', 'new'); await tick(); assert.equal(started, true); assert.ok(f.frontendActivity.snapshot().storage > 0);
    f.recovery.set('canvas', 'late-other-page'); read.resolve('new'); await writing;
    await assert.rejects(f.flush()); assert.equal(f.recovery.get('canvas'), 'late-other-page');
});

test('newer write invalidates old quota read-back proof even when old primary value matches', async () => {
    const f = storage(), read = deferred(); let first = true;
    f.localStorage.setItem = () => { throw Error('quota'); };
    f.backend.getItem = key => { if (first) { first = false; return read.promise; } return Promise.resolve(f.disk.get(key)); };
    const old = f.api.setItem('canvas', 'old'); await tick();
    const newer = f.api.setItem('canvas', 'new'); read.resolve('old'); await old; await newer;
    assert.equal(f.disk.get('canvas'), 'new'); await f.flush();
});

test('partially staged recovery remains intact and cannot be certified or silently cleaned by flush', async () => {
    const { api, localStorage, disk, recovery, flush } = storage();
    const save = localStorage.setItem;
    localStorage.setItem = (key, value) => { if (key.includes(':fallback:')) throw Error('quota'); save(key, value); };
    await api.setItem('canvas', 'recovery');
    assert.equal(disk.get('canvas'), 'recovery'); assert.equal(recovery.get('canvas'), 'recovery');
    const before = [...recovery]; await assert.rejects(flush()); assert.deepEqual([...recovery], before);
    localStorage.setItem = save;
    await api.setItem('canvas', 'newest'); await flush(); assert.equal(recovery.size, 0);
});

test('when neither storage succeeds the original rejection and prior primary value survive', async () => {
    const { api, backend, localStorage, disk, flush, frontendActivity } = storage();
    const failure = Error('disk unavailable'); disk.set('canvas', 'previous');
    localStorage.setItem = () => { throw Error('quota'); };
    backend.setItem = async () => { throw failure; };
    await assert.rejects(api.setItem('canvas', 'new'), error => error === failure);
    assert.equal(disk.get('canvas'), 'previous'); await assert.rejects(flush());
    assert.equal(frontendActivity.snapshot().storage, 0);
});

test('synchronous tombstone staging failure is tracked before any IndexedDB removal', async () => {
    const { api, backend, localStorage, disk, flush, frontendActivity } = storage();
    const save = localStorage.setItem; disk.set('canvas', 'previous'); let removals = 0;
    backend.removeItem = async key => { removals++; disk.delete(key); };
    localStorage.setItem = () => { throw Error('quota'); };
    const revision = frontendActivity.revision();
    await assert.rejects(api.removeItem('canvas'), /quota/);
    assert.equal(removals, 0); assert.equal(disk.get('canvas'), 'previous');
    assert.ok(frontendActivity.revision() > revision); await assert.rejects(flush());
    localStorage.setItem = save; await api.removeItem('canvas'); await flush();
    assert.equal(removals, 1);
});

test('each recovery cleanup failure blocks confirmation and preserves the original rejection until explicit retry', async () => {
    for (const failedKey of ['canvas', 'infinite-canvas:fallback:canvas']) {
        const { api, localStorage, disk, recovery, flush } = storage();
        const remove = localStorage.removeItem; const failure = Error('cleanup');
        localStorage.removeItem = key => { if (key === failedKey) throw failure; remove(key); };
        await assert.rejects(api.setItem('canvas', 'new'), error => error === failure);
        assert.equal(disk.get('canvas'), 'new'); assert.equal(recovery.has('infinite-canvas:fallback:canvas'), true);
        await assert.rejects(flush());
        localStorage.removeItem = remove; await api.setItem('canvas', 'latest'); await flush();
        assert.equal(recovery.size, 0);
    }
});

test('a restored tombstone returns null but blocks installation without automatically deleting primary data', async () => {
    const { api, backend, disk, recovery, flush } = storage();
    disk.set('canvas', 'old'); recovery.set('infinite-canvas:fallback:canvas', 'deleted:previous-session');
    let removals = 0;
    backend.removeItem = async key => { removals++; disk.delete(key); };
    assert.equal(await api.getItem('canvas'), null);
    const before = [...recovery]; await assert.rejects(flush());
    assert.equal(removals, 0); assert.equal(disk.get('canvas'), 'old'); assert.deepEqual([...recovery], before);
    await api.setItem('canvas', 'new'); await flush(); assert.equal(disk.get('canvas'), 'new');
});

test('restored fallback and marker-only records are unknown until a successful explicit save', async () => {
    for (const markerOnly of [false, true]) {
        const { api, disk, recovery, flush, flushStorageCheckpoints } = storage();
        disk.set('canvas', 'primary');
        if (markerOnly) recovery.set('infinite-canvas:fallback:canvas', 'value:old-session');
        else recovery.set('canvas', 'fallback');
        assert.equal(await api.getItem('canvas'), markerOnly ? 'primary' : 'fallback');
        await assert.rejects(flush()); await assert.rejects(flushStorageCheckpoints());
        await api.setItem('canvas', 'latest'); await flush(); await flushStorageCheckpoints();
    }
});

test('unreadable recovery or failed primary reads retain unknown evidence without changing read behavior', async () => {
    {
        const { api, disk, localStorage, flush } = storage();
        disk.set('canvas', 'primary'); localStorage.getItem = () => { throw Error('disabled'); };
        assert.equal(await api.getItem('canvas'), 'primary'); await assert.rejects(flush());
    }
    {
        const { api, backend, flush } = storage();
        backend.getItem = async () => { throw Error('offline'); };
        assert.equal(await api.getItem('canvas'), null); await assert.rejects(flush());
    }
});

test('delete cleanup errors remain visible and retrying deletion confirms the real removal', async () => {
    const { api, localStorage, disk, recovery, flush } = storage();
    disk.set('canvas', 'old'); const remove = localStorage.removeItem;
    localStorage.removeItem = key => { if (key.includes(':fallback:')) throw Error('cleanup'); remove(key); };
    await assert.rejects(api.removeItem('canvas'), /cleanup/); assert.equal(disk.has('canvas'), false);
    assert.ok(recovery.get('infinite-canvas:fallback:canvas').startsWith('deleted:'));
    await assert.rejects(flush());
    localStorage.removeItem = remove; await api.removeItem('canvas'); await flush();
});

test('actual barrier waits local queues and refuses a receipt for a swallowed primary failure', async () => {
    const activity = createActivityFixture();
    const { api, backend, flush, flushStorageCheckpoints } = storage(activity.registry);
    activity.barrier.registerFlush(flush); activity.barrier.registerFlush(flushStorageCheckpoints);
    const gate = deferred(), epoch = '11111111-1111-4111-8111-111111111111';
    const save = backend.setItem;
    backend.setItem = async () => { await gate.promise; throw Error('offline'); };
    const writing = api.setItem('canvas', 'new');
    let rejected = false;
    const draining = assert.rejects(activity.barrier.drain(epoch), /Persistence flush failed/).then(() => { rejected = true; });
    await tick(); assert.equal(rejected, false); assert.equal(activity.registry.snapshot().storage, 1);
    gate.resolve(); await writing; await draining;
    await assert.rejects(activity.runTaskActivity('workbench', () => {}), /quiescing/);
    activity.barrier.resume(epoch); backend.setItem = save;
    await api.setItem('canvas', 'latest');
    const receipt = await activity.barrier.drain(epoch); assert.equal(activity.barrier.isAcknowledged(receipt), true);
    activity.barrier.resume(epoch); activity.barrier.dispose();
    const source = readFileSync(new URL('../src/canvas/services/task-admission.ts', import.meta.url), 'utf8');
    assert.match(source, /registerFlush\(flushLocalForagePersistence\)/);
});

test('an old queued save cannot erase a newer deletion tombstone', async () => {
    const { api, backend, disk, recovery, flush } = storage();
    const gate = deferred(), removeGate = deferred();
    backend.setItem = async (key, value) => { await gate.promise; disk.set(key, value); };
    backend.removeItem = async key => { await removeGate.promise; disk.delete(key); };
    const writing = api.setItem('canvas', 'old-save'); await tick();
    const deleting = api.removeItem('canvas'); gate.resolve(); await writing;
    assert.ok(recovery.get('infinite-canvas:fallback:canvas').startsWith('deleted:'));
    assert.equal(await api.getItem('canvas'), null);
    let done = false; const flushing = flush().then(() => { done = true; });
    await tick(); assert.equal(done, false);
    removeGate.resolve(); await deleting; await flushing;
    assert.equal(disk.has('canvas'), false); assert.equal(recovery.size, 0);
});

test('an old queued delete cannot erase a newer value recovery marker', async () => {
    const { api, backend, disk, recovery, flush } = storage();
    const gate = deferred(), saveGate = deferred();
    disk.set('canvas', 'old');
    backend.removeItem = async key => { await gate.promise; disk.delete(key); };
    backend.setItem = async (key, value) => { await saveGate.promise; disk.set(key, value); };
    const deleting = api.removeItem('canvas'); await tick();
    const writing = api.setItem('canvas', 'new-save'); gate.resolve(); await deleting;
    assert.ok(recovery.get('infinite-canvas:fallback:canvas').startsWith('value:'));
    assert.equal(await api.getItem('canvas'), 'new-save');
    saveGate.resolve(); await writing; await flush();
    assert.equal(disk.get('canvas'), 'new-save'); assert.equal(recovery.size, 0);
});

test('failed writes on one key still wait for slow writes on another key before flush rejects', async () => {
    const { api, backend, disk, flush } = storage();
    const slow = deferred();
    backend.setItem = async (key, value) => {
        if (key === 'bad') throw Error('offline');
        await slow.promise; disk.set(key, value);
    };
    await api.setItem('bad', 'recovery'); const writing = api.setItem('slow', 'value');
    let done = false;
    const flushing = assert.rejects(flush()).then(() => { done = true; });
    await tick(); assert.equal(done, false);
    slow.resolve(); await writing; await flushing; assert.equal(disk.get('slow'), 'value');
});

test('recovery copy is synchronous and older writes cannot erase the newest pending value', async () => {
    const { api, backend, disk, recovery, frontendActivity } = storage();
    let release;
    backend.setItem = async (key, value) => {
        if (value === 'first') await new Promise(resolve => { release = resolve; });
        disk.set(key, value);
    };
    const first = api.setItem('canvas', 'first');
    assert.equal(recovery.get('canvas'), 'first');
    await new Promise(resolve => setImmediate(resolve));
    const second = api.setItem('canvas', 'second');
    assert.equal(frontendActivity.snapshot().storage, 2, 'queued writes are counted before they start');
    assert.equal(await api.getItem('canvas'), 'second');
    release();
    await Promise.all([first, second]);
    assert.equal(disk.get('canvas'), 'second');
    assert.equal(recovery.size, 0);
    assert.equal(frontendActivity.snapshot().storage, 0);
});

test('failed removal leaves a tombstone rather than resurrecting old IndexedDB data', async () => {
    const { api, backend, disk, flush } = storage();
    disk.set('canvas', 'old');
    backend.removeItem = async () => { throw Error('offline'); };
    await api.removeItem('canvas');
    assert.equal(await api.getItem('canvas'), null);
    await assert.rejects(flush());
    await api.setItem('canvas', 'new');
    assert.equal(await api.getItem('canvas'), 'new');
    await flush();
});
