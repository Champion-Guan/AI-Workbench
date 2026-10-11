import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, realpath, mkdir, cp, copyFile, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { OwnedUpdateService } from '../src/server/update-service.mjs';
import { localRuntime } from './helpers/owned-runtime.mjs';

const project = new URL('../', import.meta.url);
async function fixture(t, mode = 'normal', realBackend = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-owned-service-')));
  const versionsRoot = path.join(root, 'versions'), privateRoot = path.join(root, 'private'), dataRoot = path.join(privateRoot, 'data');
  await mkdir(versionsRoot); await mkdir(dataRoot, { recursive: true });
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  assert.notEqual(port, 5174); const origin = `http://127.0.0.1:${port}`;
  const pointer = { id: '1.0.5-' + 'a'.repeat(12) + '-localqa', version: '1.0.5', commit: 'a'.repeat(40), buildId: 'b'.repeat(24), dataRoot, origin };
  const directory = path.join(versionsRoot, pointer.id); pointer.directory = directory;
  await mkdir(path.join(directory, 'runtime'), { recursive: true });
  // Native local Node, not the non-executable synthetic signed ZIP payload.
  await copyFile((await localRuntime()).file, path.join(directory, 'runtime/node'), constants.COPYFILE_FICLONE);
  await chmod(path.join(directory, 'runtime/node'), 0o700);
  if (!realBackend) {
    await copyFile(new URL('./fixtures/owned-update-backend.mjs', import.meta.url), path.join(directory, 'server.mjs'));
    await copyFile(new URL('../src/server/update-startup.mjs', import.meta.url), path.join(directory, 'update-startup.mjs'));
    await writeFile(path.join(directory, 'fixture.json'), JSON.stringify({ mode, version: pointer.version, buildId: pointer.buildId }));
  } else {
    for (const file of ['server.mjs', 'package.json', 'src/server', 'config/examples', 'node_modules/undici'])
      await cp(new URL(file, project), path.join(directory, file), { recursive: true });
    await mkdir(path.join(directory, 'public/infinite-canvas'), { recursive: true });
    await writeFile(path.join(directory, 'public/index.html'), '<title>QA</title>');
    await writeFile(path.join(directory, 'public/infinite-canvas/index.html'), '<title>QA canvas</title>');
    pointer.version = JSON.parse(await readFile(path.join(directory, 'package.json'))).version;
    pointer.buildId = createHash('sha256').update(await readFile(path.join(directory, 'src/server/index.mjs')))
      .update(await readFile(path.join(directory, 'public/infinite-canvas/index.html'))).digest('hex').slice(0, 24);
    for (const name of ['config', 'proxy', 'runtime']) await mkdir(path.join(dataRoot, name), { recursive: true });
    for (const [file, bytes] of [['config/runtime.env', ''], ['proxy/profile.yaml', 'proxies: []\nrules: []\n'],
      ['proxy/state.json', JSON.stringify({ version: 1, enabled: false, relayEnabled: false, source: null, cachedConfig: null, configName: 'QA' })],
      ['runtime/image-relay-transports.json', '{}']]) await writeFile(path.join(dataRoot, file), bytes);
  }
  const sentinel = path.join(dataRoot, 'sentinel'); await writeFile(sentinel, 'retain local business data');
  let verified = 0;
  const options = { versionsRoot, dataRoot, privateRoot, origin, disableProxy: true, startupTimeout: 2000, stopTimeout: 500, activationTimeout: 150,
    verify: async p => { verified++; assert.equal(p.id, pointer.id); return { directory, startupProtocol: 1 }; } };
  const service = new OwnedUpdateService(options);
  t.after(async () => {
    // Test-owned, intentionally unresponsive fixture only. Never a production PID.
    const child = service.owned?.child;
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, options, service, pointer, sentinel, verified: () => verified };
}

test('real owned Node child quarantines business traffic, validates exact health and activates idempotently', async t => {
  const f = await fixture(t), report = await f.service.start(f.pointer);
  assert.equal(report.pid, f.service.owned.child.pid); assert.equal(report.maintenance, true); assert.equal(report.envClean, true);
  assert.equal(f.verified(), 1); assert.equal((await fetch(f.pointer.origin + '/')).status, 503);
  assert.equal(await f.service.recoverySafe(), true);
  await assert.rejects(f.service.stop({ allowed: [{ ...f.pointer, commit: 'c'.repeat(40) }] }), /identity/);
  await assert.rejects(f.service.activate({ ...f.pointer, buildId: 'c'.repeat(24) }), /ownership/);
  await f.service.activate(f.pointer); await f.service.activate(f.pointer);
  assert.equal((await fetch(f.pointer.origin + '/')).status, 200); assert.equal(await f.service.recoverySafe(), false);
  await f.service.stop({ allowed: [f.pointer] }); assert.equal(await f.service.isStopped(), true);
  assert.equal(await readFile(f.sentinel, 'utf8'), 'retain local business data');
});
test('actual copied project backend uses owned native Node, private root and inherited activation IPC', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'normal', true);
  const before = await readFile(path.join(f.options.dataRoot, 'proxy/state.json'));
  const report = await f.service.start(f.pointer); assert.equal(report.proxy.running, false); assert.equal(report.maintenance, true);
  assert.equal((await fetch(f.pointer.origin + '/local-app/activity')).status, 503);
  await f.service.activate(f.pointer);
  const status = await (await fetch(f.pointer.origin + '/local-app/updates/status', { headers: { origin: f.pointer.origin } })).json();
  assert.equal(status.install.allowed, false); assert.equal(status.preferences.autoInstall, false);
  await f.service.stop({ allowed: [f.pointer] });
  assert.deepEqual(await readFile(path.join(f.options.dataRoot, 'proxy/state.json')), before);
  assert.equal(await readFile(f.sentinel, 'utf8'), 'retain local business data');
});
test('foreign occupied listener is not adopted, signalled, or displaced', async t => {
  const f = await fixture(t), foreign = createServer();
  await new Promise(resolve => foreign.listen(Number(new URL(f.pointer.origin).port), '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  await assert.rejects(f.service.start(f.pointer), /port_occupied/);
  await assert.rejects(f.service.stop({ allowed: [f.pointer] }), /ownership_unknown/);
  assert.equal(await f.service.recoverySafe(), false); assert.equal(foreign.listening, true);
});
test('spawn exit and wrong build health keep ownership until verified stop; no activation', async t => {
  for (const mode of ['exit', 'bad-health']) {
    const f = await fixture(t, mode);
    await assert.rejects(f.service.start(f.pointer), /service_start/);
    if (mode === 'bad-health') { assert.equal((await fetch(f.pointer.origin + '/')).status, 503); assert.equal(await f.service.recoverySafe(), false); }
    await f.service.stop({ allowed: [f.pointer] }); assert.equal(await f.service.isStopped(), true);
  }
});
test('stop timeout preserves live owned handle and does not force kill or claim stopped', async t => {
  const f = await fixture(t, 'ignore-stop'); await f.service.start(f.pointer);
  await assert.rejects(f.service.stop({ allowed: [f.pointer] }), /stop_timeout/);
  assert.equal(f.service.owned.child.exitCode, null); assert.equal(await f.service.isStopped(), false);
  assert.equal((await fetch(f.pointer.origin + '/')).status, 503);
});
test('lost activation ack is confirmed through the same exact live PID and instance, not a downgrade', async t => {
  const f = await fixture(t, 'no-ack'); await f.service.start(f.pointer);
  const instance = f.service.owned.instanceId;
  await f.service.activate(f.pointer); assert.equal(f.service.owned.instanceId, instance);
  assert.equal(f.service.owned.active, true); await f.service.activate(f.pointer);
  await f.service.stop({ allowed: [f.pointer] });
});
test('manager restart cannot adopt or stop an orphan even with matching version identity', async t => {
  const f = await fixture(t); await f.service.start(f.pointer);
  const restarted = new OwnedUpdateService(f.options);
  assert.equal(await restarted.recoverySafe(), false);
  await assert.rejects(restarted.start(f.pointer), /port_occupied/);
  await assert.rejects(restarted.stop({ allowed: [f.pointer] }), /ownership_unknown/);
  assert.equal((await fetch(f.pointer.origin + '/')).status, 503);
  await f.service.stop({ allowed: [f.pointer] });
});
test('verification refusal, wrong data/origin and symlink runtime prevent execution', async t => {
  const f = await fixture(t);
  for (const p of [{ ...f.pointer, origin: 'http://127.0.0.1:5174' }, { ...f.pointer, dataRoot: f.root }])
    await assert.rejects(f.service.start(p), /identity/);
  const refused = new OwnedUpdateService({ ...f.options, verify: async () => { throw Error('signature invalid'); } });
  await assert.rejects(refused.start(f.pointer), /signature/); assert.equal(refused.owned, null);
  const legacy = new OwnedUpdateService({ ...f.options, verify: async () => ({ directory: f.pointer.directory }) });
  await assert.rejects(legacy.start(f.pointer), /protocol_incompatible/); assert.equal(legacy.owned, null);
  await rm(path.join(f.pointer.directory, 'runtime/node')); await symlink(process.execPath, path.join(f.pointer.directory, 'runtime/node'));
  await assert.rejects(f.service.start(f.pointer), /path_invalid/); assert.equal(f.service.owned, null);
});
test('concurrent start/activation cannot bypass a running operation', async t => {
  const f = await fixture(t); const started = f.service.start(f.pointer);
  await assert.rejects(f.service.start(f.pointer), /in_progress/); await assert.rejects(f.service.activate(f.pointer), /in_progress/);
  await started; await f.service.stop({ allowed: [f.pointer] });
});
