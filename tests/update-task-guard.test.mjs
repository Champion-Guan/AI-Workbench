import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, chmod, readFile, rm } from 'node:fs/promises';
import { randomUUID, webcrypto } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { UpdateTaskLedger } from '../src/server/update-task-ledger.mjs';
import { createUpdateTaskHttpHandler } from '../src/server/update-task-http.mjs';
import { createActivityFixture } from './helpers/frontend-activity.mjs';
import { journalFixture } from './helpers/remote-task-journal.mjs';

function loadGuard(activity, video, agent, fetcher, version = '1.0.5') {
  const source = readFileSync(new URL('../src/canvas/services/update-task-guard.ts', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/export /g, '');
  const context = vm.createContext({ frontendActivity: activity, remoteVideoJournal: video, remoteAgentJournal: agent,
    APP_VERSION: version, crypto: webcrypto, fetch: fetcher, AbortSignal });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.startUpdateTaskGuard();
}
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-task-guard-'))); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new UpdateTaskLedger({ file: path.join(directory, 'tasks.json'), version: '1.0.5', instance: randomUUID() });
  await ledger.initialize(); let handler, dropCompletion = false;
  const server = createServer(async (req, res) => {
    if (req.url === '/local-app/health') { res.end(JSON.stringify({ taskEvidenceProtocol: 1, version: '1.0.5', instanceId: ledger.instance })); return; }
    if (dropCompletion && req.url.endsWith('/complete')) { res.writeHead(503); res.end(); return; }
    if (!await handler(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`; assert.notEqual(server.address().port, 5174);
  handler = createUpdateTaskHttpHandler({ ledger, origin });
  const activity = createActivityFixture().registry, video = journalFixture(activity), agent = journalFixture(activity, { domain: 'agent', namespace: 'agent' });
  const fetcher = (url, options = {}) => fetch(origin + url, { ...options, headers: { ...options.headers, origin } });
  const stop = loadGuard(activity, video.journal, agent.journal, fetcher); t.after(stop);
  return { ledger, activity, video, agent, directory, failCompletion: () => { dropCompletion = true; } };
}
test('actual guard and HTTP ledger persist intent before network dispatch, then retire only confirmed completion', async t => {
  const f = await fixture(t); let executed = false;
  const result = await f.activity.runNetwork('canvas', async () => {
    executed = true; assert.equal((await f.ledger.snapshot()).pending, 1); return 'generated and decoded';
  });
  assert.equal(result, 'generated and decoded'); assert.equal(executed, true);
  assert.equal((await f.ledger.snapshot()).pending, 0);
  await assert.rejects(f.activity.runNetwork('canvas', () => { throw Error('response lost'); }), /response lost/);
  assert.equal((await f.ledger.snapshot()).pending, 1);
  const text = await readFile(f.ledger.file, 'utf8'); assert.ok(!text.includes('response lost')); assert.ok(!text.includes('prompt'));
});
test('accepted remote video stays natively pending between requests and clears only after correlated terminal/local save handoff', async t => {
  const f = await fixture(t), taskKey = 'a'.repeat(64);
  await f.activity.runNetwork('canvas', async () => {
    const id = await f.video.journal.beginDurable(); f.video.journal.bind(id, taskKey);
    assert.equal((await f.ledger.snapshot()).pending, 2); // Request and remote intent.
  });
  assert.equal((await f.ledger.snapshot()).pending, 1);
  assert.equal(await f.video.journal.terminalDurable(taskKey), true);
  assert.equal((await f.ledger.snapshot()).pending, 0); assert.equal(f.video.rows.size, 0);
});
test('lost completion acknowledgement retains native evidence without undoing a successful business result', async t => {
  const f = await fixture(t); f.failCompletion();
  assert.equal(await f.activity.runNetwork('webdav', () => 'uploaded'), 'uploaded');
  assert.equal((await f.ledger.snapshot()).pending, 1);
});
test('legacy stays synchronous/compatible, but signed compatible clients fail closed on handshake failure', async () => {
  for (const version of ['1.0.4', '1.0.5']) {
    const activity = createActivityFixture().registry, video = journalFixture(activity), agent = journalFixture(activity, { domain: 'agent', namespace: 'agent' });
    const stop = loadGuard(activity, video.journal, agent.journal, async () => { throw Error('offline'); }, version);
    let called = false; const result = activity.runNetwork('canvas', () => { called = true; return 'okay'; });
    if (version === '1.0.4') { assert.equal(called, true); assert.equal(await result, 'okay'); }
    else { await assert.rejects(result, /offline/); assert.equal(called, false); }
    let synchronous = false; const mutation = activity.run('agent', () => { synchronous = true; });
    assert.equal(synchronous, true); await mutation; stop();
  }
});
test('native terminal handoff retains its sentinel if browser removal fails instead of advertising false idle', async t => {
  const f = await fixture(t), key = 'b'.repeat(64);
  await f.activity.runNetwork('canvas', async () => { const id = await f.video.journal.beginDurable(); f.video.journal.bind(id, key); });
  f.video.storage.removeItem = () => { throw Error('quota failure'); };
  assert.equal(await f.video.journal.terminalDurable(key), false);
  assert.equal((await f.ledger.snapshot()).pending, 2); assert.equal(f.video.rows.size, 1);
});
