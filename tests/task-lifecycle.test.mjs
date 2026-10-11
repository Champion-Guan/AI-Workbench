import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';
import { journalFixture } from './helpers/remote-task-journal.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function source(file) { return readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8'); }
function evaluate(file, bindings = {}, names) {
  const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const statements = ast.statements.filter(node => !ts.isImportDeclaration(node) && (!names || (ts.isFunctionDeclaration(node) && names.includes(node.name?.text))));
  const body = statements.map(node => node.getText(ast)).join('\n').replace(/\bexport /g, '');
  const context = vm.createContext({ TextEncoder, Uint8Array, crypto: webcrypto, ...bindings });
  vm.runInContext(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context;
}
function unresolved(registry, domain = 'canvas', maximum = 4096) {
  const ctx = evaluate('lib/unresolved-activity.ts', { frontendActivity: registry });
  vm.runInContext(`globalThis.pending = new UnresolvedActivityRegistry(frontendActivity, ${JSON.stringify(domain)}, ${maximum});`, ctx);
  return ctx.pending;
}
function videoFixture() {
  const activity = createActivityFixture();
  const pending = unresolved(activity.registry);
  const durable = journalFixture(activity.registry);
  let state = { status: 'pending' }, failure;
  const task = { provider: 'openai', id: 'fixture-task', model: 'fixture-model' };
  const ctx = evaluate('services/api/video.ts', {
    ...activity, unresolvedVideoActivity: pending, remoteVideoJournal: durable.journal, pluginVideoResults: new Map(), resolveModelRequestConfig: config => config,
    createVideoGenerationTaskImpl: async (_config, _prompt, _references, _options, beforeRequest) => { beforeRequest(); return task; },
    pollVideoGenerationTaskImpl: async () => { if (failure) throw failure; return state; },
  }, ['createVideoGenerationTask', 'rememberVideoActivity', 'pollVideoGenerationTask']);
  const config = { model: 'fixture-model', baseUrl: 'https://example.invalid', apiKey: 'fixture-account' };
  return { ...activity, pending, durable, ctx, task, config, setState: next => { state = next; }, fail: error => { failure = error; } };
}

test('created video task stays busy between polls, on timeout/abort and until confirmed terminal result', async () => {
  const f = videoFixture();
  assert.equal(await f.ctx.createVideoGenerationTask(f.config, 'fixture prompt'), f.task);
  assert.equal(f.registry.snapshot().canvas, 2, 'durable request intent and upstream task remain independently protected');
  await Promise.all([f.ctx.pollVideoGenerationTask(f.config, f.task), f.ctx.pollVideoGenerationTask(f.config, f.task)]);
  assert.equal(f.registry.snapshot().canvas, 2, 'duplicate polls do not duplicate lifetime blockers');
  for (const message of ['network unavailable', 'Aborted', 'query timeout']) {
    f.fail(Error(message));
    await assert.rejects(f.ctx.pollVideoGenerationTask(f.config, f.task), error => error.message === message);
    assert.equal(f.registry.snapshot().canvas, 2);
  }
  f.fail(undefined);
  const result = { status: 'completed', result: { url: 'https://example.invalid/fixture.mp4' } };
  f.setState(result);
  assert.equal(await f.ctx.pollVideoGenerationTask(f.config, f.task), result);
  assert.equal(f.registry.snapshot().canvas, 0);
});

test('resumed videos acquire blockers, account identities are isolated and plaintext is not retained in the tracker', async () => {
  const f = videoFixture();
  const another = { ...f.config, apiKey: 'other-fixture-account' };
  await f.ctx.pollVideoGenerationTask(f.config, f.task);
  await f.ctx.pollVideoGenerationTask(another, f.task);
  assert.equal(f.registry.snapshot().canvas, 2);
  assert.ok([...f.pending.releases.keys()].every(key => /^[a-f0-9]{64}$/.test(key)));
  f.setState({ status: 'failed', error: 'confirmed upstream failure' });
  await f.ctx.pollVideoGenerationTask(another, f.task);
  assert.equal(f.registry.snapshot().canvas, 1, 'other account cannot release the original task');
  await f.ctx.pollVideoGenerationTask(f.config, f.task);
  assert.equal(f.registry.snapshot().canvas, 0);
});

test('lost video create response retains durable pre-request evidence after a cold realm', async () => {
  const f = videoFixture();
  f.ctx.createVideoGenerationTaskImpl = async (_config, _prompt, _references, _options, beforeRequest) => {
    beforeRequest(); throw Error('create response lost');
  };
  await assert.rejects(f.ctx.createVideoGenerationTask(f.config, 'private prompt'), /response lost/);
  assert.equal(f.durable.rows.size, 1); assert.equal(f.registry.snapshot().canvas, 1);
  assert.deepEqual([...f.durable.rows.values()], ['{"format":1,"taskKey":null}']);
  const cold = createActivityFixture(), restored = journalFixture(cold.registry, { rows: f.durable.rows });
  restored.journal.restore(); assert.equal(cold.registry.snapshot().canvas, 1);
});

test('video create preflight failure does not create a false unknown remote task', async () => {
  const f = videoFixture();
  f.ctx.createVideoGenerationTaskImpl = async () => { throw Error('invalid reference before dispatch'); };
  await assert.rejects(f.ctx.createVideoGenerationTask(f.config, 'private prompt'), /before dispatch/);
  assert.equal(f.durable.rows.size, 0); assert.equal(f.registry.snapshot().canvas, 0);
});

test('attribution failure and capacity limits keep bounded unknown blockers without breaking business calls', async () => {
  const f = videoFixture();
  f.ctx.crypto = { subtle: { digest: async () => { throw Error('unsupported crypto'); } } };
  assert.equal(await f.ctx.createVideoGenerationTask(f.config, 'fixture'), f.task);
  assert.equal(f.registry.snapshot().canvas, 3, 'durable intent plus two independent attribution uncertainty blockers');
  f.setState({ status: 'completed', result: {} });
  await f.ctx.pollVideoGenerationTask(f.config, f.task);
  assert.equal(f.registry.snapshot().canvas, 3, 'unknown attribution cannot be erased by an unrelated terminal report');
  const r = createActivityFixture().registry, pending = unresolved(r, 'canvas', 2);
  for (const letter of ['a', 'b', 'c', 'd']) pending.remember(letter.repeat(64));
  assert.equal(pending.releases.size, 2);
  assert.equal(r.snapshot().canvas, 3);
  pending.terminal('a'.repeat(64)); pending.terminal('b'.repeat(64));
  assert.equal(r.snapshot().canvas, 1, 'capacity uncertainty survives retirement of known tasks');
});

test('image retry task remains busy after generation until history persistence finishes', async () => {
  const activity = createActivityFixture(), generated = deferred(), saved = deferred(), successes = [];
  const ast = ts.createSourceFile('image.tsx', source('pages/image/index.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'retryResult') callback = node.initializer; ts.forEachChild(node, visit); }
  visit(ast);
  const ctx = vm.createContext({ ...activity, performance,
    buildRequestSnapshot: () => ({ text: 'fixture', config: {}, references: [] }), setPreviewLog() {}, setResults() {},
    runGenerationSlot: () => generated.promise, saveLog: () => saved.promise, buildLog: value => value, model: 'fixture',
    message: { success: text => successes.push(text), error() {} }, t: key => key,
  });
  vm.runInContext(ts.transpileModule('globalThis.run = ' + callback.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const running = ctx.run(0);
  assert.equal(activity.registry.snapshot().workbench, 1);
  generated.resolve({ id: 'fixture-image' }); await tick();
  assert.equal(activity.registry.snapshot().workbench, 1);
  assert.equal(successes.length, 0, 'do not report success before saving the history');
  saved.resolve(); await running;
  assert.equal(activity.registry.snapshot().workbench, 0);
  assert.equal(successes.length, 1);
});

test('settled task group drains siblings before propagating failure and preserves tuple result order', async () => {
  const ctx = evaluate('lib/settle-activity-group.ts');
  const slow = deferred(), error = Error('domain failed');
  let done = false;
  const result = ctx.settleActivityGroup([Promise.reject(error), slow.promise]).finally(() => { done = true; });
  const rejected = assert.rejects(result, reason => reason === error);
  await tick(); assert.equal(done, false);
  slow.resolve(); await rejected; assert.equal(done, true);
  assert.deepEqual(Array.from(await ctx.settleActivityGroup([Promise.resolve('first'), 2])), ['first', 2]);
});

test('WebDAV lock queues whole syncs and retains exclusivity until failed group siblings drain', async () => {
  const activity = createActivityFixture(), drain = deferred(), order = [];
  const group = evaluate('lib/settle-activity-group.ts').settleActivityGroup;
  const locks = { async request(name, options, fn) { assert.equal(name, 'guan-workbench-webdav-sync-v1'); assert.equal(options.mode, 'exclusive'); order.push('lock'); try { return await fn(); } finally { order.push('unlock'); } } };
  const ctx = evaluate('lib/webdav-activity-lock.ts', { ...activity, unresolvedWebdavActivity: unresolved(activity.registry, 'webdav') });
  const first = ctx.withWebdavActivityLock(() => group([Promise.reject(Error('failed')), drain.promise]), locks);
  const failure = assert.rejects(first, /failed/);
  const second = ctx.withWebdavActivityLock(async () => { order.push('second'); return 7; }, locks);
  assert.equal(activity.registry.snapshot().webdav, 2, 'queued sync is counted immediately');
  await tick(); assert.deepEqual(order, ['lock']);
  drain.resolve(); await failure;
  assert.equal(await second, 7);
  assert.deepEqual(order, ['lock', 'unlock', 'lock', 'second', 'unlock']);
  assert.equal(activity.registry.snapshot().webdav, 0);
});

test('WebDAV without cross-page locks retains update uncertainty but still syncs in FIFO order', async () => {
  const activity = createActivityFixture(), order = [], firstDone = deferred();
  const ctx = evaluate('lib/webdav-activity-lock.ts', { ...activity, unresolvedWebdavActivity: unresolved(activity.registry, 'webdav') });
  const a = ctx.withWebdavActivityLock(async () => { order.push(1); await firstDone.promise; });
  const b = ctx.withWebdavActivityLock(async () => { order.push(2); });
  await tick(); assert.deepEqual(order, [1]);
  firstDone.resolve(); await Promise.all([a, b]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(activity.registry.snapshot().webdav, 1, 'unsupported coordination never becomes safe idle');
});
