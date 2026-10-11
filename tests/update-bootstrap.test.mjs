import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { testSigningIdentity, signedUpdateFixture } from './helpers/signed-update.mjs';

async function fixture(t, protocol = true) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-bootstrap-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, 'data'); await mkdir(dataRoot);
  await writeFile(path.join(dataRoot, 'sentinel'), 'retain business data');
  const signing = testSigningIdentity(), options = { root: path.join(base, 'installation'), dataRoot, repository: 'owner/repo',
    platform: 'darwin', arch: 'arm64', trustedKeys: signing.keys, freeSpace: async () => 4e9 };
  const manager = new UpdateManager(options), calls = [];
  let stopped = true;
  manager.service = { isStopped: async () => stopped,
    recoverySafe: async () => true,
    start: async p => { calls.push('start'); stopped = false; return { ready: true, version: p.version, buildId: p.buildId, origin: p.origin }; },
    activate: async () => { calls.push('activate'); }, stop: async () => { calls.push('stop'); stopped = true; } };
  const lease = { assertValid: async () => { calls.push('assert'); }, release: async () => { calls.push('release'); } };
  manager.coordinator = { acquireBootstrap: async () => lease, acquireBootstrapRecovery: async () => lease };
  const next = await manager.stage(await signedUpdateFixture(base, signing, '1.0.5', protocol ? { backend: '//not executed', startup: '//fixture' } : null));
  return { manager, next, options, calls, lease, base };
}
test('first signed bootstrap validates stopped service and continuous permit before durable pointer and activation', async t => {
  const f = await fixture(t);
  f.manager.onStep = async phase => {
    if (phase === 'bootstrap-starting') assert.equal(await f.manager.readCurrent(), null);
    if (phase === 'bootstrap-committed') assert.equal(f.calls.includes('activate'), false);
  };
  assert.deepEqual(await f.manager.bootstrap(f.next), { state: 'committed', version: '1.0.5' });
  assert.deepEqual(await f.manager.readCurrent(), f.next); assert.equal((await f.manager.readBootstrap()).phase, 'activated');
  assert.equal(f.calls.at(-1), 'release');
  assert.equal(await readFile(path.join(f.options.dataRoot, 'sentinel'), 'utf8'), 'retain business data');
  await assert.rejects(f.manager.bootstrap(f.next), /conflict/);
});
test('unsupported old protocol, occupied service and absent authority never bootstrap or write a current pointer', async t => {
  for (const mode of ['old-protocol', 'occupied', 'missing-authority']) {
    const f = await fixture(t, mode !== 'old-protocol');
    if (mode === 'occupied') f.manager.service.isStopped = async () => false;
    if (mode === 'missing-authority') f.manager.coordinator = null;
    await assert.rejects(f.manager.bootstrap(f.next)); assert.equal(await f.manager.readCurrent(), null);
    assert.equal(f.calls.includes('start'), false); assert.equal(await f.manager.readBootstrap(), null);
  }
});
test('bootstrap startup failure stops only its own service and retains data and aborted evidence', async t => {
  const f = await fixture(t); f.manager.service.start = async () => { throw Error('QA failure'); };
  await assert.rejects(f.manager.bootstrap(f.next), /blocked/);
  assert.equal(await f.manager.readCurrent(), null); assert.equal((await f.manager.readBootstrap()).phase, 'aborted');
  assert.ok(f.calls.includes('stop')); assert.equal(f.calls.at(-1), 'release');
  assert.equal(await readFile(path.join(f.options.dataRoot, 'sentinel'), 'utf8'), 'retain business data');
});
test('lost bootstrap activation acknowledgement retains committed pointer and lease; explicit reconciliation is idempotent', async t => {
  const f = await fixture(t); f.manager.service.activate = async () => { throw Error('lost ack'); };
  await assert.rejects(f.manager.bootstrap(f.next), /activation_unconfirmed/);
  assert.deepEqual(await f.manager.readCurrent(), f.next); assert.equal((await f.manager.readBootstrap()).phase, 'committed');
  assert.equal(f.calls.includes('release'), false);
  assert.equal((await new UpdateManager(f.options).inspectStatus()).state, 'activation-required');
  await assert.rejects(f.manager.stage({ directory: f.base, version: '1.0.6' }), /recovery_required/);
  f.manager.service.activate = async () => { f.calls.push('activate'); };
  assert.deepEqual(await f.manager.reconcileBootstrap(), { state: 'committed', version: '1.0.5' });
  assert.equal((await f.manager.readBootstrap()).phase, 'activated'); assert.equal(f.calls.at(-1), 'release');
});
test('expired bootstrap permit and failed stop retain uncertainty rather than clearing journal or releasing work', async t => {
  const f = await fixture(t); let count = 0;
  f.lease.assertValid = async () => { if (++count === 3) throw Error('inventory changed'); };
  f.manager.service.stop = async () => { throw Error('stop unknown'); };
  await assert.rejects(f.manager.bootstrap(f.next), /recovery_required/);
  assert.equal(await f.manager.readCurrent(), null); assert.equal((await f.manager.readBootstrap()).phase, 'starting');
  assert.equal(f.calls.includes('release'), false); assert.equal(f.manager.recoveryLease, f.lease);
  assert.equal((await new UpdateManager(f.options).inspectStatus()).state, 'recovery-required');
});
test('corrupt bootstrap evidence is kept and blocks all staging/install/recovery paths', async t => {
  const f = await fixture(t), file = path.join(f.manager.root, 'bootstrap.json');
  await writeFile(file, 'bad');
  await assert.rejects(f.manager.bootstrap(f.next)); await assert.rejects(f.manager.install(f.next));
  await assert.rejects(f.manager.recover()); assert.equal((await f.manager.inspectStatus()).state, 'blocked');
  assert.equal(await readFile(file, 'utf8'), 'bad'); assert.equal(f.calls.includes('start'), false);
});
test('cold bootstrap recovery aborts only pre-pointer own service, and completes exact pointer-before-commit forward', async t => {
  for (const pointerWritten of [false, true]) {
    const f = await fixture(t);
    await f.manager.bootstrapRecord({ format: 1, phase: 'starting', next: f.next }, 'starting');
    if (pointerWritten) {
      const { writePrivateFile } = await import('../src/server/runtime-paths.mjs');
      await writePrivateFile(path.join(f.manager.root, 'current.json'), JSON.stringify(f.next));
    }
    const cold = new UpdateManager({ ...f.options, service: f.manager.service, coordinator: f.manager.coordinator });
    const result = await cold.recoverBootstrap();
    assert.equal(result.state, pointerWritten ? 'committed' : 'bootstrap-required');
    assert.equal((await cold.readBootstrap()).phase, pointerWritten ? 'activated' : 'aborted');
    assert.equal(f.calls.at(-1), 'release');
  }
});
test('cold bootstrap recovery never adopts an unknown active service or releases its pause', async t => {
  const f = await fixture(t);
  await f.manager.bootstrapRecord({ format: 1, phase: 'starting', next: f.next }, 'starting');
  f.manager.service.recoverySafe = async () => false;
  await assert.rejects(f.manager.recoverBootstrap(), /recovery_blocked/);
  assert.equal(f.calls.includes('stop'), false); assert.equal(f.calls.includes('release'), false);
  assert.equal((await f.manager.readBootstrap()).phase, 'starting');
});

test('bad current read and lost release after activation retain lease for explicit reconciliation', async t => {
  const bad = await fixture(t);
  bad.manager.onStep = async phase => {
    if (phase === 'bootstrap-committed') { await writeFile(path.join(bad.manager.root, 'current.json'), 'broken'); throw Error('QA interruption'); }
  };
  await assert.rejects(bad.manager.bootstrap(bad.next), /recovery_required/);
  assert.equal(bad.manager.recoveryLease, bad.lease); assert.equal(bad.calls.includes('release'), false);
  const f = await fixture(t); f.lease.release = async () => { throw Error('lost release'); };
  await assert.rejects(f.manager.bootstrap(f.next), /recovery_required/);
  assert.equal((await f.manager.readBootstrap()).phase, 'activated'); assert.deepEqual(await f.manager.readCurrent(), f.next);
  assert.equal(f.manager.recoveryLease, f.lease);
  f.lease.release = async () => { f.calls.push('release'); };
  assert.deepEqual(await f.manager.reconcileBootstrap(), { state: 'committed', version: '1.0.5' });
  assert.equal(f.manager.recoveryLease, null);
});
