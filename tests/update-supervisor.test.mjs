import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, realpath, readFile, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { serveUpdateSupervisor, SupervisedUpdateService, supervisorCapability } from '../src/server/update-supervisor.mjs';
import { updateSupervisorLaunchAgent } from '../src/server/update-launchd.mjs';
import { OwnedUpdateService } from '../src/server/update-service.mjs';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { signedUpdateFixture, testSigningIdentity } from './helpers/signed-update.mjs';
import { localRuntime } from './helpers/owned-runtime.mjs';
import { writePrivateFile } from '../src/server/runtime-paths.mjs';

const pointer = { id: '1.0.4-fixture', version: '1.0.4', commit: 'a'.repeat(40), buildId: 'b'.repeat(24) };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t, service) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-supervisor-')));
  const socketPath = path.join(root, 's.sock'), capabilityFile = path.join(root, 'capability');
  const capability = await supervisorCapability(capabilityFile, { create: true });
  const ipc = await serveUpdateSupervisor({ service, socketPath, capability, versionsRoot: path.join(root, 'versions'), dataRoot: path.join(root, 'data'), origin: 'http://127.0.0.1:65000' });
  const clients = [];
  const client = () => { const value = new SupervisedUpdateService({ socketPath, capabilityFile, timeout: 2000 }); clients.push(value); return value; };
  t.after(async () => { clients.forEach(c => c.disconnect()); await ipc.close(); await rm(root, { recursive: true, force: true }); });
  return { root, socketPath, capabilityFile, capability, ipc, client };
}

test('capability is copy-once, bounded and rejects writable, linked and damaged files without replacement', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-capability-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'capability'), first = await supervisorCapability(file, { create: true });
  assert.match(first, /^[a-f0-9]{64}$/); assert.equal(await supervisorCapability(file, { create: true }), first);
  await chmod(file, 0o644); await assert.rejects(supervisorCapability(file), /service_supervisor_path_invalid/);
  await chmod(file, 0o600); await writeFile(file, 'invalid');
  await assert.rejects(supervisorCapability(file, { create: true }), /capability_invalid/); assert.equal(await readFile(file, 'utf8'), 'invalid');
  const link = path.join(root, 'link'); await symlink(file, link); await assert.rejects(supervisorCapability(link), /path_invalid/);
});

test('exclusive authenticated controller reconnects without resetting owned service state', async t => {
  let running = false, active = false, starts = 0;
  const fixture = { start: async p => { assert.equal(p.directory.endsWith('/' + pointer.id), true); running = true; starts++; return { pid: 123 }; },
    activate: async () => { active = true; return { pid: 123 }; }, stop: async () => { running = false; },
    isStopped: async () => !running, recoverySafe: async () => running && !active };
  const env = await setup(t, fixture), first = env.client(), second = env.client();
  await first.start(pointer); const incarnation = first.incarnation;
  await assert.rejects(second.connect(), /outcome_unknown/);
  first.disconnect(); await pause(30);
  await second.connect(); assert.equal(second.incarnation, incarnation); assert.equal(await second.recoverySafe(), true);
  await second.activate(pointer); assert.equal(await second.recoverySafe(), false); assert.equal(starts, 1);
  await assert.rejects(env.ipc.close(), /stop_required/);
  await second.stop({ allowed: [pointer] }); assert.equal(await second.isStopped(), true);
});

test('disconnect during operation does not release operation lock, and late completion is not cancelled', async t => {
  let finish, stopped = true;
  const fixture = { start: () => new Promise(resolve => { finish = () => { stopped = false; resolve({ pid: 123 }); }; }),
    stop: async () => { stopped = true; }, isStopped: async () => stopped };
  const env = await setup(t, fixture), first = env.client(), second = env.client();
  const starting = first.start(pointer); const outcome = assert.rejects(starting, /outcome_unknown/);
  while (!finish) await pause(10);
  first.disconnect(); await outcome; await pause(20);
  await assert.rejects(second.connect(), /outcome_unknown/);
  finish(); await pause(20); await second.connect(); assert.equal(await second.isStopped(), false);
  await second.stop({ allowed: [pointer] });
});

async function raw(socketPath, input) {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath); let data = '';
    socket.on('error', () => {}); socket.on('data', chunk => { data += chunk; socket.destroy(); });
    socket.on('close', () => resolve(data)); socket.on('connect', () => socket.write(input));
  });
}
test('wrong capability, arbitrary commands, replay session and oversized input cannot reach service', async t => {
  let calls = 0;
  const env = await setup(t, { isStopped: async () => { calls++; return true; } });
  assert.equal(await raw(env.socketPath, JSON.stringify({ op: 'hello', capability: '0'.repeat(64) }) + '\n'), '');
  assert.equal(await raw(env.socketPath, '{"op":"exec","command":"no"}\n'), '');
  assert.equal(await raw(env.socketPath, 'x'.repeat(4097)), '');
  const client = env.client(); await client.connect();
  await assert.rejects(client.call('exec', { command: 'no' }), /request_invalid/); assert.equal(calls, 0);
  client.socket.write(JSON.stringify({ op: 'isStopped', value: null, incarnation: client.incarnation, session: client.session, sequence: client.sequence }) + '\n');
  await pause(20); assert.equal(client.socket, null); assert.equal(calls, 0);
});

test('supervisor launchd pins a distinct independent user job and validates labels', () => {
  const options = { node: '/private/stable/runtime/node', entry: '/private/stable/scripts/run-update-supervisor.mjs', directory: '/private/stable', dataRoot: '/private/data', logs: '/private/logs' };
  const plist = updateSupervisorLaunchAgent(options);
  assert.match(plist, /com.guanaiworkbench.supervisor/); assert.match(plist, /run-update-supervisor.mjs/); assert.doesNotMatch(plist, /run-update-manager.mjs|updater.log/);
  assert.match(plist, /<integer>63<\/integer>/); assert.throws(() => updateSupervisorLaunchAgent({ ...options, label: 'arbitrary' }));
});

test('real signed arm64 child survives controller process exit and new manager safely reconciles activation then installs', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 120000,
}, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-supervised-native-')));
  const privateRoot = path.join(base, 'private'), dataRoot = path.join(privateRoot, 'data'); await mkdir(dataRoot, { recursive: true });
  const sentinel = path.join(dataRoot, 'history'); await writeFile(sentinel, 'keep unchanged');
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${reservation.address().port}`; assert.notEqual(reservation.address().port, 5174); await new Promise(resolve => reservation.close(resolve));
  const signing = testSigningIdentity(), root = path.join(base, 'installation');
  const coordinator = { acquire: async () => ({ assertValid: async () => {}, release: async () => {} }),
    acquireRecovery: async () => ({ assertValid: async () => {}, release: async () => {} }) }; // Explicit QA inventory, not production.
  const manager = new UpdateManager({ root, dataRoot, origin, repository: 'owner/repo', trustedKeys: signing.keys, coordinator, freeSpace: async () => 4e9 });
  const owned = new OwnedUpdateService({ versionsRoot: path.join(root, 'versions'), dataRoot, privateRoot, origin, verify: p => manager.verifyInstalled(p), disableProxy: true, startupTimeout: 2000 });
  const socketPath = path.join(base, 's.sock'), capabilityFile = path.join(base, 'capability');
  const capability = await supervisorCapability(capabilityFile, { create: true });
  const ipc = await serveUpdateSupervisor({ service: owned, socketPath, capability, versionsRoot: owned.versionsRoot, dataRoot, origin });
  let controller, client;
  t.after(async () => {
    client?.disconnect();
    if (controller?.exitCode === null && controller?.signalCode === null) { const ended = once(controller, 'exit'); controller.kill('SIGTERM'); await ended; }
    if (owned.owned) await owned.stop({ allowed: [owned.owned.pointer] });
    await ipc.close(); await rm(base, { recursive: true, force: true });
  });
  const executable = { runtime: (await localRuntime()).bytes, backend: await readFile(new URL('./fixtures/owned-update-backend.mjs', import.meta.url)), startup: await readFile(new URL('../src/server/update-startup.mjs', import.meta.url)) };
  const previous = await manager.stage(await signedUpdateFixture(base, signing, '1.0.4', executable));
  await writePrivateFile(path.join(root, 'current.json'), JSON.stringify(previous)); // QA bootstrap.
  controller = fork(new URL('./fixtures/supervisor-controller.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const reply = once(controller, 'message'); controller.send({ connection: { socketPath, capabilityFile }, pointer: previous, activate: false });
  const [result] = await reply; assert.equal(result.ok, true);
  const childPid = owned.owned.child.pid; assert.equal(result.pid, childPid); assert.equal((await fetch(origin + '/')).status, 503);
  const ended = once(controller, 'exit'); controller.kill('SIGTERM'); await ended; await pause(50);
  assert.equal(owned.owned.child.exitCode, null);
  // A new manager instance binds to the independent exact owner, not health PID.
  const recovered = new UpdateManager({ root, dataRoot, origin, repository: 'owner/repo', trustedKeys: signing.keys, coordinator, freeSpace: async () => 4e9 });
  client = new SupervisedUpdateService({ socketPath, capabilityFile }); recovered.service = client;
  assert.equal(await client.recoverySafe(), true); await client.activate(previous);
  assert.equal(owned.owned.child.pid, childPid); assert.equal((await fetch(origin + '/')).status, 200);
  const next = await recovered.stage(await signedUpdateFixture(base, signing, '1.0.5', executable));
  recovered.onStep = async phase => {
    if (phase === 'committed') { client.disconnect(); throw Error('QA controller lost after durable commit'); }
  };
  await assert.rejects(recovered.install(next), /update_activation_unconfirmed/);
  assert.deepEqual(await recovered.readCurrent(), next); assert.equal((await fetch(origin + '/')).status, 503);
  assert.notEqual(owned.owned.child.pid, childPid);
  const resumed = new UpdateManager({ root, dataRoot, origin, repository: 'owner/repo', trustedKeys: signing.keys, coordinator, freeSpace: async () => 4e9 });
  client = new SupervisedUpdateService({ socketPath, capabilityFile }); resumed.service = client;
  await resumed.reconcileActivation();
  assert.deepEqual(await resumed.readCurrent(), next, 'committed recovery does not downgrade or respawn the service');
  assert.notEqual(owned.owned.child.pid, childPid); assert.equal((await fetch(origin + '/')).status, 200);
  const broken = await resumed.stage(await signedUpdateFixture(base, signing, '1.0.6', { ...executable, mode: 'exit' }));
  await assert.rejects(resumed.install(broken), /update_failed_rolled_back/);
  assert.equal((await (await fetch(origin + '/local-app/health')).json()).version, '1.0.5');
  assert.equal(await readFile(sentinel, 'utf8'), 'keep unchanged');
  await client.stop({ allowed: [next] });
});
