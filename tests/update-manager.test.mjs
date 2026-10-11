import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, realpath, rm, mkdir, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { writePrivateFile } from '../src/server/runtime-paths.mjs';
import { testSigningIdentity, signedUpdateFixture } from './helpers/signed-update.mjs';

async function fixture(t, { bootstrap = true } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-install-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const signing = testSigningIdentity(), dataRoot = path.join(base, 'data'); await mkdir(dataRoot);
  await writeFile(path.join(dataRoot, 'private-settings'), 'retain exact business data');
  const options = { root: path.join(base, 'installation'), dataRoot, repository: 'owner/repo', trustedKeys: signing.keys, platform: 'darwin', arch: 'arm64', freeSpace: async () => 2e9 };
  const manager = new UpdateManager(options);
  const oldInput = await signedUpdateFixture(base, signing, '1.0.4'), nextInput = await signedUpdateFixture(base, signing, '1.0.5');
  const previous = await manager.stage(oldInput);
  // Bootstrap is fixture setup only, not a public production API. Stage-5's
  // real first-install handoff must independently prove the stopped old service.
  if (bootstrap) await writePrivateFile(path.join(options.root, 'current.json'), JSON.stringify(previous));
  const next = await manager.stage(nextInput), calls = [];
  let stopped = false;
  const service = {
    async stop() { calls.push('stop'); stopped = true; },
    async isStopped() { return stopped; },
    async recoverySafe() { return true; },
    async start(p) { calls.push('start:' + p.version); stopped = false; return { ready: true, version: p.version, buildId: p.buildId, origin: p.origin }; },
  };
  let assertions = 0;
  const coordinator = { async acquire() { return { async assertValid() { assertions++; }, async release() { calls.push('release'); } }; } };
  coordinator.acquireRecovery = coordinator.acquire;
  manager.service = service; manager.coordinator = coordinator;
  return { base, signing, options, manager, previous, next, nextInput, calls, service, coordinator, assertions: () => assertions };
}
test('arm64 staging re-verifies real signatures, exact files and stable identity without executing or altering current/data', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.manager.readCurrent(), f.previous);
  assert.equal((await f.manager.verifyInstalled(f.next)).signatureVerified, true);
  assert.equal(f.manager.status().installAllowed, false);
  assert.equal(await readFile(path.join(f.options.dataRoot, 'private-settings'), 'utf8'), 'retain exact business data');
  assert.equal(await f.manager.readJournal(), null);
});
test('repeat stage reuses only an exactly verified immutable version; partial/tampered versions remain blocked', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.manager.stage(f.nextInput), f.next);
  assert.deepEqual(await f.manager.readCurrent(), f.previous);
  await writeFile(path.join(f.options.root, 'versions', f.next.id, 'server.mjs'), 'tampered');
  await assert.rejects(f.manager.stage(f.nextInput));
  assert.equal(await readFile(path.join(f.options.root, 'versions', f.next.id, 'server.mjs'), 'utf8'), 'tampered');
});
test('read-only status distinguishes bootstrap, durable unfinished/terminal transactions and corrupt state after restart', async t => {
  const f = await fixture(t, { bootstrap: false });
  assert.equal((await f.manager.inspectStatus()).state, 'bootstrap-required');
  await writePrivateFile(path.join(f.options.root, 'current.json'), JSON.stringify(f.previous));
  for (const phase of ['starting', 'committed', 'rolled-back']) {
    await writePrivateFile(path.join(f.options.root, 'transaction.json'), JSON.stringify({ format: 1, phase, previous: f.previous, next: f.next }));
    const restarted = new UpdateManager(f.options);
    const status = await restarted.inspectStatus();
    assert.equal(status.state, phase === 'starting' ? 'recovery-required' : 'activation-required');
    assert.equal(status.installAllowed, false); assert.equal(status.currentVersion, '1.0.4');
    assert.deepEqual(f.calls, []);
  }
  await writeFile(path.join(f.options.root, 'transaction.json'), 'bad');
  assert.equal((await new UpdateManager(f.options).inspectStatus()).error, 'update_state_invalid');
  assert.equal(await readFile(path.join(f.options.root, 'transaction.json'), 'utf8'), 'bad');
});
test('successful transaction checks permit, stops before pointer switch and commits only after exact health', async t => {
  const f = await fixture(t); assert.deepEqual(await f.manager.install(f.next), { state: 'committed', version: '1.0.5' });
  assert.deepEqual(f.calls, ['stop', 'start:1.0.5', 'release']); assert.equal(f.assertions(), 5);
  assert.deepEqual(await f.manager.readCurrent(), f.next); assert.equal((await f.manager.readJournal()).phase, 'committed');
  assert.equal((await f.manager.verifyInstalled(f.previous)).signatureVerified, true);
});
test('missing coordinator and forged/expired permits never stop service or change current', async t => {
  for (const mode of ['missing', 'forged', 'expired']) {
    const f = await fixture(t);
    f.manager.coordinator = mode === 'missing' ? null : { async acquire() { return mode === 'forged' ? {} : { async assertValid() { throw Error('unknown windows'); }, async release() {} }; } };
    await assert.rejects(f.manager.install(f.next)); assert.deepEqual(await f.manager.readCurrent(), f.previous); assert.deepEqual(f.calls, []);
  }
});
test('no unsafe first-install or downgrade is allowed through the update transaction', async t => {
  const f = await fixture(t, { bootstrap: false }); await assert.rejects(f.manager.install(f.next), /bootstrap/);
  await writePrivateFile(path.join(f.options.root, 'current.json'), JSON.stringify(f.next));
  await assert.rejects(f.manager.install(f.previous), /version_not_newer/); assert.deepEqual(f.calls, []);
});
test('startup/health failures roll back the pointer and restart verified old version, preserving private data', async t => {
  for (const mode of ['throw', 'version', 'origin', 'buildId', 'ready']) {
    const f = await fixture(t), start = f.service.start;
    f.service.start = async p => {
      if (p.version === '1.0.5') {
        if (mode === 'throw') throw Error('synthetic startup failure');
        return { ...(await start(p)), [mode]: mode === 'ready' ? false : 'wrong' };
      }
      return start(p);
    };
    await assert.rejects(f.manager.install(f.next), /update_failed_rolled_back/);
    assert.deepEqual(await f.manager.readCurrent(), f.previous); assert.equal((await f.manager.readJournal()).phase, 'rolled-back');
    assert.equal(f.calls.at(-2), 'start:1.0.4'); assert.equal(f.calls.at(-1), 'release');
    assert.equal(await readFile(path.join(f.options.dataRoot, 'private-settings'), 'utf8'), 'retain exact business data');
  }
});
test('unconfirmed service stop never switches pointer and failed rollback remains recovery-required', async t => {
  const f = await fixture(t); f.service.isStopped = async () => false;
  await assert.rejects(f.manager.install(f.next), /update_rollback_failed/);
  assert.deepEqual(await f.manager.readCurrent(), f.previous); assert.equal(f.manager.status().state, 'recovery-required');
  assert.equal((await f.manager.readJournal()).phase, 'rolling-back');
  assert.equal(f.calls.includes('release'), false, 'failed rollback must keep root admission closed');
});
test('lost post-commit activation acknowledgement never downgrades a version that may already accept tasks', async t => {
  const f = await fixture(t); f.service.activate = async () => { throw Error('ack lost'); };
  await assert.rejects(f.manager.install(f.next), /update_activation_unconfirmed/);
  assert.deepEqual(await f.manager.readCurrent(), f.next); assert.equal((await f.manager.readJournal()).phase, 'committed');
  assert.deepEqual(f.calls, ['stop', 'start:1.0.5']); assert.equal(f.manager.status().state, 'activation-required');
});
test('permit invalidation after service stop restores old version without ever starting new', async t => {
  const f = await fixture(t); let assertions = 0;
  f.manager.coordinator = { acquire: async () => ({ assertValid: async () => { if (++assertions === 3) throw Error('inventory changed'); }, release: async () => { f.calls.push('release'); } }) };
  await assert.rejects(f.manager.install(f.next), /update_failed_rolled_back/);
  assert.deepEqual(await f.manager.readCurrent(), f.previous); assert.ok(!f.calls.includes('start:1.0.5')); assert.ok(f.calls.includes('start:1.0.4'));
});
test('tampered installed files and tampered receipt signatures reject before service/coordinator access', async t => {
  for (const mode of ['file', 'signature', 'release']) {
    const f = await fixture(t), filename = mode === 'signature' ? path.join(f.options.root, 'records', f.next.id, 'guan-stable-manifest.sig')
      : path.join(f.options.root, 'versions', f.next.id, mode === 'file' ? 'server.mjs' : 'RELEASE.json');
    await writeFile(filename, mode === 'signature' ? Buffer.alloc(64) : 'tampered');
    await assert.rejects(f.manager.install(f.next)); assert.deepEqual(f.calls, []); assert.deepEqual(await f.manager.readCurrent(), f.previous);
  }
});
test('unknown disk capacity rejects before extraction/install and retains all current/data', async t => {
  const f = await fixture(t), input = await signedUpdateFixture(f.base, f.signing, '1.0.6');
  for (const space of [0, NaN]) { f.manager.freeSpace = async () => space; await assert.rejects(f.manager.stage(input), /disk_space_insufficient/); }
  assert.deepEqual((await readdir(path.join(f.options.root, 'versions'))).sort(), [f.previous.id, f.next.id].sort());
  assert.deepEqual(await f.manager.readCurrent(), f.previous);
});
test('interrupted/current/invalid journal and symlink versions are preserved and fail closed', async t => {
  const f = await fixture(t), journal = path.join(f.options.root, 'transaction.json');
  await writePrivateFile(journal, '{bad json'); await assert.rejects(f.manager.install(f.next));
  assert.equal(await readFile(journal, 'utf8'), '{bad json');
  await rm(journal); const version = path.join(f.options.root, 'versions', f.next.id);
  await rm(version, { recursive: true }); await symlink(f.options.dataRoot, version);
  await assert.rejects(f.manager.install(f.next), /update_path_invalid/); assert.deepEqual(f.calls, []);
});
test('real process termination at each durable transaction boundary recovers the old version; committed stays new', async t => {
  for (const phase of ['prepared', 'stopping', 'switching', 'starting', 'committed']) {
    const f = await fixture(t);
    const source = `import { UpdateManager } from ${JSON.stringify(new URL('../src/server/update-manager.mjs', import.meta.url).href)};
      const o=JSON.parse(process.argv[1]), next=JSON.parse(process.argv[2]);
      const m=new UpdateManager({...o,onStep:async p=>{if(p===process.argv[3]) process.exit(73)},
        coordinator:{acquire:async()=>({assertValid:async()=>{},release:async()=>{}})},
        service:{stop:async()=>{},isStopped:async()=>true,start:async p=>({ready:true,version:p.version,buildId:p.buildId,origin:p.origin})}});
      await m.install(next);`;
    const processResult = spawnSync(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(f.options), JSON.stringify(f.next), phase], { encoding: 'utf8' });
    assert.equal(processResult.status, 73, processResult.stderr);
    const restarted = new UpdateManager({ ...f.options, service: f.service, coordinator: f.coordinator });
    const result = await restarted.recover();
    if (phase === 'committed') { assert.equal(result.state, 'activation-required'); assert.deepEqual(await restarted.readCurrent(), f.next); }
    else { assert.equal(result.state, 'rolled-back'); assert.deepEqual(await restarted.readCurrent(), f.previous); }
    assert.equal(await readFile(path.join(f.options.dataRoot, 'private-settings'), 'utf8'), 'retain exact business data');
  }
});
test('crash recovery refuses unknown running-service state and conflicting current; never blindly kills processes', async t => {
  const f = await fixture(t);
  await writePrivateFile(path.join(f.options.root, 'transaction.json'), JSON.stringify({ format: 1, phase: 'starting', previous: f.previous, next: f.next }));
  f.service.recoverySafe = async () => false; await assert.rejects(f.manager.recover(), /recovery_blocked/); assert.deepEqual(f.calls, []);
});
test('cross-process lock refuses a live owner and does not clear its evidence', async t => {
  const f = await fixture(t), file = path.join(f.options.root, 'manager.lock');
  await writePrivateFile(file, JSON.stringify({ pid: process.pid, nonce: 'test-lock' }));
  await assert.rejects(f.manager.install(f.next), /update_in_progress/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid); assert.deepEqual(f.calls, []);
});
test('future installer rejects Intel and any code/data overlapping or broad root', () => {
  const options = { root: '/safe/installation', dataRoot: '/safe/data', repository: 'owner/repo', platform: 'darwin', arch: 'arm64' };
  assert.throws(() => new UpdateManager({ ...options, arch: 'x64' }), /platform/);
  for (const root of ['/', '/safe', '/safe/data/nested']) assert.throws(() => new UpdateManager({ ...options, root }), /path/);
});
test('post-commit revalidation failure retains new pointer and pause; trusted reconciliation releases only after activation', async t => {
  const f = await fixture(t); let assertions = 0, active = false;
  f.manager.coordinator = { acquire: async () => ({ assertValid: async () => { if (++assertions === 5) throw Error('inventory lost after commit'); },
    release: async () => f.calls.push('release') }) };
  f.service.activate = async () => { active = true; };
  await assert.rejects(f.manager.install(f.next), /activation_unconfirmed/);
  assert.equal(active, false); assert.deepEqual(await f.manager.readCurrent(), f.next); assert.equal(f.calls.includes('release'), false);
  await assert.rejects(f.manager.install(f.next), /recovery_required/);
  assert.deepEqual(await f.manager.reconcileActivation(), { state: 'committed', version: '1.0.5' });
  assert.equal(active, true); assert.equal(f.calls.at(-1), 'release'); assert.equal(f.manager.recoveryLease, null);
});
test('cold terminal reconciliation requires fresh authoritative permit; unknown service remains untouched', async t => {
  const f = await fixture(t); await f.manager.install(f.next);
  const cold = new UpdateManager({ ...f.options, service: f.service });
  assert.deepEqual(await cold.recover(), { state: 'activation-required' });
  await assert.rejects(cold.reconcileActivation(), /coordination_unavailable/);
  let released = false;
  cold.coordinator = { acquireRecovery: async () => ({ assertValid: async () => {}, release: async () => { released = true; } }) };
  f.service.activate = async () => { throw Error('unknown ownership'); };
  await assert.rejects(cold.reconcileActivation(), /activation_unconfirmed/); assert.equal(released, false);
  assert.deepEqual(await cold.readCurrent(), f.next);
  f.service.activate = async () => {};
  assert.equal((await cold.reconcileActivation()).state, 'committed'); assert.equal(released, true);
});
test('nonterminal cold recovery cannot restart or activate a service without an authoritative recovery permit', async t => {
  const f = await fixture(t);
  await writePrivateFile(path.join(f.options.root, 'transaction.json'), JSON.stringify({ format: 1, phase: 'starting', previous: f.previous, next: f.next }));
  f.manager.coordinator = null;
  await assert.rejects(f.manager.recover(), /coordination_unavailable/); assert.deepEqual(f.calls, []);
  assert.equal((await f.manager.readJournal()).phase, 'starting'); assert.deepEqual(await f.manager.readCurrent(), f.previous);
});
test('historical signed packages remain verifiable but incompatible rollback/startup protocol blocks before stopping old service', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.verifyInstalled(f.previous)).startupProtocol, null);
  f.service.requiredStartupProtocol = 1;
  await assert.rejects(f.manager.install(f.next), /protocol_incompatible/); assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.manager.readCurrent(), f.previous); assert.equal(await f.manager.readJournal(), null);
});
