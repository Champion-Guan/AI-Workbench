import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { OwnedUpdateService } from '../src/server/update-service.mjs';
import { testSigningIdentity, signedUpdateFixture } from './helpers/signed-update.mjs';
import { localRuntime } from './helpers/owned-runtime.mjs';
import { createServer } from 'node:net';

test('local test-signed native arm64 packages run real commit and failed-start rollback transactions', {
  timeout: 120000, skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-service-transaction-')));
  const privateRoot = path.join(base, 'private'), dataRoot = path.join(privateRoot, 'data'); await mkdir(dataRoot, { recursive: true });
  const sentinel = path.join(dataRoot, 'canvas-history-sentinel'); await writeFile(sentinel, 'unchanged QA business data');
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); assert.notEqual(port, 5174);
  const origin = `http://127.0.0.1:${port}`, signing = testSigningIdentity();
  const executable = { runtime: (await localRuntime()).bytes,
    backend: await readFile(new URL('./fixtures/owned-update-backend.mjs', import.meta.url)),
    startup: await readFile(new URL('../src/server/update-startup.mjs', import.meta.url)) };
  let released = 0;
  // This is an explicit test coordinator, not production inventory proof.
  const coordinator = { acquire: async () => ({ assertValid: async () => {}, release: async () => { released++; } }) };
  coordinator.acquireBootstrap = coordinator.acquire;
  const manager = new UpdateManager({ root: path.join(base, 'installation'), dataRoot, repository: 'owner/repo',
    trustedKeys: signing.keys, coordinator, origin, freeSpace: async () => 4e9 });
  const service = new OwnedUpdateService({ versionsRoot: path.join(manager.root, 'versions'), dataRoot, privateRoot, origin,
    verify: p => manager.verifyInstalled(p), disableProxy: true, startupTimeout: 10000 });
  manager.service = service;
  t.after(async () => {
    const child = service.owned?.child;
    if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
    await rm(base, { recursive: true, force: true });
  });
  const previous = await manager.stage(await signedUpdateFixture(base, signing, '1.0.4', executable));
  assert.deepEqual(await manager.bootstrap(previous), { state: 'committed', version: '1.0.4' });
  assert.equal((await manager.readBootstrap()).phase, 'activated');
  assert.equal(released, 1); released = 0;
  const oldPid = service.owned.child.pid;
  const next = await manager.stage(await signedUpdateFixture(base, signing, '1.0.5', executable));
  manager.onStep = async phase => {
    if (phase === 'committed') assert.equal((await fetch(origin + '/')).status, 503, 'business remains quarantined until durable commit');
  };
  assert.deepEqual(await manager.install(next), { state: 'committed', version: '1.0.5' });
  assert.notEqual(service.owned.child.pid, oldPid); assert.equal((await fetch(origin + '/')).status, 200);
  assert.deepEqual(await manager.readCurrent(), next); assert.equal(released, 1);
  const broken = await manager.stage(await signedUpdateFixture(base, signing, '1.0.6', { ...executable, mode: 'exit' }));
  await assert.rejects(manager.install(broken), /update_failed_rolled_back/);
  assert.deepEqual(await manager.readCurrent(), next);
  const restored = await (await fetch(origin + '/local-app/health')).json();
  assert.equal(restored.version, '1.0.5'); assert.equal(restored.maintenance, false); assert.equal(released, 2);
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged QA business data');
  await service.stop({ allowed: [next] }); assert.equal(await service.isStopped(), true);
});
