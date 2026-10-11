import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, chmod, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { UpdateTaskLedger } from '../src/server/update-task-ledger.mjs';
import { createUpdateTaskHttpHandler } from '../src/server/update-task-http.mjs';
import { ActivityGate } from '../src/server/activity-gate.mjs';

async function fixture(t, maximum = 4096) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-task-ledger-')));
  await chmod(directory, 0o700); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tasks.json'), ledger = new UpdateTaskLedger({ file, version: '1.0.5', maximum });
  await ledger.initialize();
  const request = () => ({ id: randomUUID(), pageId: randomUUID(), domain: 'canvas', version: '1.0.5' });
  return { ledger, file, directory, request };
}
test('task begin is durable before ack, only matching completion removes metadata without user content', async t => {
  const f = await fixture(t), row = f.request(), ack = await f.ledger.begin(row);
  assert.deepEqual(ack, { id: row.id, instance: f.ledger.instance });
  const stored = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(stored.tasks, [{ ...row, instance: f.ledger.instance }]);
  assert.deepEqual(await f.ledger.snapshot(), { revision: 1, pending: 1, frozen: false });
  await f.ledger.complete(ack); assert.equal((await f.ledger.snapshot()).pending, 0);
  assert.equal((await f.ledger.snapshot()).revision, 2);
  await assert.rejects(f.ledger.complete(ack));
});
test('cold restart and failed/unknown completions retain every pending task; initialize never resets', async t => {
  const f = await fixture(t), ack = await f.ledger.begin(f.request());
  const cold = new UpdateTaskLedger({ file: f.file, version: '1.0.5' }); await cold.initialize();
  assert.equal((await cold.snapshot()).pending, 1);
  await assert.rejects(cold.complete(ack)); await assert.rejects(f.ledger.complete({ ...ack, extra: true }));
  await assert.rejects(f.ledger.complete({ ...ack, id: randomUUID() }));
  assert.equal((await cold.snapshot()).pending, 1);
});
test('freeze atomically rejects pending/revision mismatch and new admission; resume does not erase evidence', async t => {
  const f = await fixture(t), row = f.request();
  const begin = f.ledger.begin(row), freeze = f.ledger.freeze(0);
  const ack = await begin; await assert.rejects(freeze, /busy/);
  await f.ledger.complete(ack); await assert.rejects(f.ledger.freeze(0), /busy/);
  await f.ledger.freeze(2); await assert.rejects(f.ledger.begin(f.request()), /quiescing/);
  assert.equal((await f.ledger.snapshot()).frozen, true);
  f.ledger.resume(); await f.ledger.begin(f.request()); assert.equal((await f.ledger.snapshot()).pending, 1);
});
test('concurrent begins preserve rows, duplicate/capacity/invalid input is rejected, and failed queue recovers', async t => {
  const f = await fixture(t, 2), rows = [f.request(), f.request()];
  await Promise.all(rows.map(row => f.ledger.begin(row)));
  await assert.rejects(f.ledger.begin(rows[0])); await assert.rejects(f.ledger.begin(f.request()));
  for (const value of [{ ...rows[0], domain: 'unknown' }, { ...rows[0], version: '1.0.4' }, { ...rows[0], prompt: 'private' }, null]) await assert.rejects(f.ledger.begin(value));
  assert.equal((await f.ledger.snapshot()).pending, 2);
  await f.ledger.complete({ id: rows[0].id, instance: f.ledger.instance });
  await f.ledger.begin(f.request()); assert.equal((await f.ledger.snapshot()).pending, 2);
});
test('corrupt evidence, links, insecure permissions and unsafe paths are never silently reseeded', async t => {
  const f = await fixture(t); await writeFile(f.file, 'broken');
  await assert.rejects(f.ledger.initialize()); await assert.rejects(f.ledger.snapshot());
  assert.equal(await readFile(f.file, 'utf8'), 'broken');
  await writeFile(f.file, JSON.stringify({ format: 1, revision: 0, tasks: [] })); await chmod(f.file, 0o644);
  await assert.rejects(f.ledger.read());
  const linked = path.join(f.directory, 'linked'); await symlink(f.file, linked);
  await assert.rejects(new UpdateTaskLedger({ file: linked, version: '1.0.5' }).initialize());
  for (const file of ['relative', '/tasks.json', f.directory + '/x/../tasks.json', f.file + '\0']) assert.throws(() => new UpdateTaskLedger({ file, version: '1.0.5' }));
});
test('independent writers cannot overwrite accepted evidence and a crashed lock is retained as unknown', async t => {
  const f = await fixture(t), second = new UpdateTaskLedger({ file: f.file, version: '1.0.5' });
  const results = await Promise.allSettled([f.ledger.begin(f.request()), second.begin(f.request())]);
  const accepted = results.filter(value => value.status === 'fulfilled').length;
  assert.ok(accepted >= 1); assert.equal((await f.ledger.snapshot()).pending, accepted);
  await writeFile(f.file + '.lock', 'unknown crashed writer', { mode: 0o600 });
  await assert.rejects(f.ledger.begin(f.request())); await assert.rejects(second.snapshot());
  await second.initialize();
  assert.equal(await readFile(f.file + '.lock', 'utf8'), 'unknown crashed writer');
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).tasks.length, accepted);
});
test('HTTP evidence uses exact loopback Host/Origin and bounded schema, without freeze/install routes', async t => {
  const f = await fixture(t), gate = new ActivityGate(); let handler;
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.notEqual(server.address().port, 5174);
  handler = createUpdateTaskHttpHandler({ ledger: f.ledger, origin, activityGate: gate });
  const post = (path, value, extra = {}) => fetch(origin + '/local-app/update-tasks/' + path, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify(value) });
  const row = f.request(); assert.equal((await post('begin', row, { origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await post('freeze', {})).status, 404); assert.equal((await post('install', {})).status, 404);
  assert.equal((await post('begin', { ...row, token: 'private' })).status, 409);
  assert.equal((await post('begin', { text: 'x'.repeat(3000) })).status, 409);
  const reply = await post('begin', row); assert.equal(reply.status, 200); const ack = await reply.json();
  assert.deepEqual(ack, { ok: true, id: row.id, instance: f.ledger.instance });
  assert.equal((await post('complete', { id: ack.id, instance: ack.instance })).status, 200);
  assert.equal(gate.status().active, 0); assert.equal(gate.status().canInstall, false);
  handler = createUpdateTaskHttpHandler({ ledger: f.ledger, origin, ready: false });
  assert.equal((await post('begin', f.request())).status, 503);
});
