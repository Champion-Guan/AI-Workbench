import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, realpath, mkdir, rm, readFile, writeFile, symlink, chmod, lstat } from 'node:fs/promises';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { SignedUpdaterRuntime } from '../src/server/update-runtime.mjs';
import { UpdaterDeployment, UserLaunchdJobs } from '../src/server/update-deployment.mjs';
import { signedUpdateFixture, testSigningIdentity } from './helpers/signed-update.mjs';
const entries = ['scripts/run-update-manager.mjs', 'scripts/run-update-supervisor.mjs', 'scripts/run-browser-bridge.mjs',
  'src/server/update-manager.mjs', 'src/server/update-supervisor.mjs', 'src/server/update-service.mjs'];
async function fixture(t, onStep) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-deployment-'))); t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, 'private/data'), agents = path.join(base, 'agents');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 }); await mkdir(agents, { mode: 0o700 });
  await writeFile(path.join(dataRoot, 'sentinel'), 'retain');
  const signing = testSigningIdentity(), manager = new UpdateManager({ root: path.join(base, 'installation'), dataRoot,
    repository: 'owner/repo', trustedKeys: signing.keys, platform: 'darwin', arch: 'arm64', freeSpace: async () => 4e9 });
  const runtime = new SignedUpdaterRuntime({ directory: path.join(base, 'runtime'), manager });
  const pointers = [];
  for (const version of ['1.0.5', '1.0.6']) {
    const pointer = await manager.stage(await signedUpdateFixture(base, signing, version, { backend: '// never executed', startup: '// QA',
      files: Object.fromEntries(entries.map(file => [file, '// signed synthetic fixture'])) }));
    await runtime.prepare(pointer); pointers.push(pointer);
  }
  const running = new Map(), calls = []; let failStart = false, failHealth = false, valid = true;
  const jobs = {
    async inspect(label, expected) {
      const actual = running.get(label); if (!actual) return false;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('QA conflicting job'); return true;
    },
    async start(label, expected) { calls.push(['start', label]); if (failStart) { failStart = false; throw Error('QA start failed'); } running.set(label, expected); },
    async stop(label, expected) { calls.push(['stop', label]); if (await this.inspect(label, expected)) running.delete(label); },
  };
  const health = async () => { if (failHealth) { failHealth = false; throw Error('QA health failed'); } };
  const lease = { assertValid: async () => { if (!valid) throw Error('install_permit_invalid'); } };
  const deployment = new UpdaterDeployment({ runtime, directory: path.join(base, 'deployment'), agents,
    privateRoot: path.join(base, 'private'), logs: path.join(base, 'logs'), jobs, health, onStep });
  return { base, dataRoot, runtime, pointers, deployment, running, calls, lease,
    failStart: () => { failStart = true; }, failHealth: () => { failHealth = true; }, invalidate: () => { valid = false; } };
}
test('signed independent deployment installs both jobs; manager upgrade leaves supervisor pinned and running', async t => {
  const f = await fixture(t); await chmod(f.deployment.agents, 0o755);
  await f.deployment.deploy(f.pointers[0], f.lease);
  const supervisor = f.running.get(f.deployment.labels.supervisor), count = f.calls.length;
  await f.deployment.deploy(f.pointers[1], f.lease);
  assert.equal(f.running.get(f.deployment.labels.supervisor), supervisor);
  assert.deepEqual(f.calls.slice(count).map(call => call[0]), ['stop', 'start']);
  assert.equal((await f.deployment.read()).supervisor.id, f.pointers[0].id);
  assert.equal(await readFile(path.join(f.dataRoot, 'sentinel'), 'utf8'), 'retain');
  assert.equal(await f.runtime.manager.readCurrent(), null);
  assert.equal((await lstat(f.deployment.agents)).mode & 0o777, 0o755, 'shared LaunchAgents permissions must not change');
  await assert.rejects(f.deployment.deploy(f.pointers[0], f.lease), /not_newer/);
});
test('manager startup/health failure restores old signed manager without stopping supervisor', async t => {
  for (const failure of ['failStart', 'failHealth']) {
    const f = await fixture(t); await f.deployment.deploy(f.pointers[0], f.lease); const count = f.calls.length;
    f[failure](); await assert.rejects(f.deployment.deploy(f.pointers[1], f.lease), /failed_rolled_back/);
    assert.equal(f.running.get(f.deployment.labels.manager).directory.endsWith(f.pointers[0].id), true);
    assert.equal(f.calls.slice(count).some(call => call[1] === f.deployment.labels.supervisor), false);
    assert.equal((await f.deployment.read()).phase, 'rolled-back');
  }
});
test('initial failed deployment removes only its own exact plists and allows safe retry', async t => {
  const f = await fixture(t); f.failStart();
  await assert.rejects(f.deployment.deploy(f.pointers[0], f.lease), /rolled_back/);
  assert.equal(f.running.size, 0);
  await f.deployment.deploy(f.pointers[1], f.lease); assert.equal(f.running.size, 2);
});
test('unknown existing plist/job, bad journal, symlink and altered signed runtime block before launching', async t => {
  const f = await fixture(t), descriptor = (await f.deployment.descriptors(f.pointers[0])).manager;
  await writeFile(descriptor.plist, 'unrelated', { mode: 0o600 });
  await assert.rejects(f.deployment.deploy(f.pointers[0], f.lease), /exists/); assert.equal(f.calls.length, 0);
  assert.equal(await readFile(descriptor.plist, 'utf8'), 'unrelated');
  const g = await fixture(t); await g.deployment.initialize(); await writeFile(g.deployment.file, '{bad', { mode: 0o600 });
  await assert.rejects(g.deployment.deploy(g.pointers[0], g.lease)); assert.equal(g.calls.length, 0);
  const h = await fixture(t), desc = (await h.deployment.descriptors(h.pointers[0])).manager;
  await symlink(path.join(h.dataRoot, 'sentinel'), desc.plist); await assert.rejects(h.deployment.deploy(h.pointers[0], h.lease));
  const k = await fixture(t); await writeFile(path.join(k.runtime.directory, k.pointers[0].id, entries[0]), 'tampered');
  await assert.rejects(k.deployment.deploy(k.pointers[0], k.lease)); assert.equal(k.calls.length, 0);
});
test('cold interrupted upgrade recovers old manager; committed journal still requires live health', async t => {
  let fail = false;
  const f = await fixture(t, async phase => { if (fail && phase === 'written') { f.invalidate(); throw Error('QA shutdown'); } });
  await f.deployment.deploy(f.pointers[0], f.lease); fail = true;
  await assert.rejects(f.deployment.deploy(f.pointers[1], f.lease), /recovery_required/);
  assert.equal((await f.deployment.read()).phase, 'written');
  const freshLease = { assertValid: async () => {} }; fail = false;
  assert.equal((await f.deployment.recover(freshLease)).state, 'rolled-back');
  assert.equal(f.running.get(f.deployment.labels.manager).directory.endsWith(f.pointers[0].id), true);
  const g = await fixture(t); await g.deployment.deploy(g.pointers[0], g.lease); g.running.delete(g.deployment.labels.manager);
  await assert.rejects(g.deployment.recover(g.lease), /unknown/);
});
test('launchctl adapter recognises only exact absent-job failure; bounded fixed commands reject unknown jobs', async () => {
  const label = 'com.guanaiworkbench.updater', expected = { plist: '/private/agents/job.plist', node: '/private/runtime/node', entry: '/private/runtime/scripts/run-update-manager.mjs', directory: '/private/runtime' };
  let args;
  const absent = Object.assign(Error(), { code: 113, stderr: 'Bad request.\nCould not find service "' + label + '" in domain for user gui: 501\n' });
  const jobs = new UserLaunchdJobs({ uid: 501, platform: 'darwin', run: async (command, arguments_, options) => {
    assert.equal(command, '/bin/launchctl'); assert.equal(options.timeout, 10000); args = arguments_; throw absent;
  } });
  assert.equal(await jobs.inspect(label, expected), false); assert.deepEqual(args, ['print', 'gui/501/' + label]);
  absent.code = 1; await assert.rejects(jobs.inspect(label, expected), /unknown/);
  await assert.rejects(jobs.inspect('evil', expected), /label_invalid/);
  const live = new UserLaunchdJobs({ uid: 501, platform: 'darwin', run: async () => ({ stdout:
    '\tpath = ' + expected.plist + '\n\tprogram = ' + expected.node + '\n\tworking directory = ' + expected.directory
    + '\n\targuments = {\n\t\t' + expected.node + '\n\t\t' + expected.entry + '\n\t}\n' }) });
  assert.equal(await live.inspect(label, expected), true);
  await assert.rejects(live.inspect(label, { ...expected, node: '/other/node' }), /conflict/);
});
