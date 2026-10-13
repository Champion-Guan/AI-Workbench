import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { mkdtemp, mkdir, rm, chmod, writeFile, symlink, realpath } from 'node:fs/promises';
import { UpdateManagerClient } from '../src/server/update-manager-client.mjs';
import { serveUpdateManager } from '../src/server/update-manager-ipc.mjs';
import { SoftwareUpdates } from '../src/server/software-updates.mjs';
import { UpdateError } from '../src/server/update-auth.mjs';

const id = 'verified-00000000-0000-0000-0000-000000000000';
const pointer = { version: '1.0.5', commit: 'a'.repeat(40), buildId: 'b'.repeat(24), id: '1.0.5-' + 'a'.repeat(12) + '-' + 'c'.repeat(12) };
async function fixture(t) {
  const root = await realpath(await mkdtemp('/tmp/guan-client-')), downloadsDirectory = path.join(root, 'packages'), calls = [];
  await mkdir(downloadsDirectory, { mode: 0o700 }); await mkdir(path.join(downloadsDirectory, id), { mode: 0o700 });
  const socketPath = path.join(root, 'u.sock');
  const manager = {
    inspectStatus: async () => ({ state: 'bootstrap-required', error: 'update_bootstrap_required', installAllowed: false, version: null, currentVersion: null }),
    stage: async input => { calls.push(input); return pointer; },
  };
  const server = await serveUpdateManager({ manager, socketPath, downloadsDirectory });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { root, socketPath, manager, calls, client: new UpdateManagerClient({ socketPath }) };
}
test('actual backend Unix bridge reads bounded durable status and stages only downloader identity', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.status(), { allowed: false, state: 'bootstrap-required', currentVersion: null, targetVersion: null, reason: 'update_bootstrap_required' });
  assert.deepEqual(await f.client.stage({ downloadId: id, version: '1.0.5', repository: 'Champion-Guan/guan-ai-workbench' }), { version: '1.0.5' });
  assert.deepEqual(f.calls, [{ version: '1.0.5', directory: path.join(f.root, 'packages', id) }]);
  for (const input of [{ downloadId: '../private', version: '1.0.5', repository: 'Champion-Guan/guan-ai-workbench' },
    { downloadId: id, version: '1.0.5', repository: 'other/repo' }, { downloadId: id, version: '1.0.5-beta', repository: 'Champion-Guan/guan-ai-workbench' }])
    await assert.rejects(f.client.stage(input), /update_stage_invalid/);
  assert.equal(f.calls.length, 1);
});
test('daemon absence, replaced socket, wrong permissions and symlink parents do not break the app or disclose paths', async t => {
  const f = await fixture(t);
  await chmod(f.socketPath, 0o666);
  const status = await f.client.status(); assert.equal(status.state, 'unavailable'); assert.equal(status.allowed, false);
  assert.ok(!JSON.stringify(status).includes(f.root));
  const file = path.join(f.root, 'not-socket'); await writeFile(file, 'preserve');
  assert.equal((await new UpdateManagerClient({ socketPath: file }).status()).state, 'unavailable');
  const alias = path.join(f.root, 'alias'); await symlink(f.root, alias);
  assert.equal((await new UpdateManagerClient({ socketPath: path.join(alias, 'u.sock') }).status()).state, 'unavailable');
  assert.equal((await new UpdateManagerClient({ socketPath: '/tmp/' + 'x'.repeat(105) }).status()).state, 'unavailable');
});
test('unexpected fields/permission grants or arbitrary peer errors never enter browser status', async t => {
  const f = await fixture(t);
  for (const overrides of [{ installAllowed: true }, { error: f.root + '/secret' }, { command: 'execute' }, { version: 104 }]) {
    f.manager.inspectStatus = async () => ({ state: 'idle', installAllowed: false, version: null, currentVersion: null, error: null, ...overrides });
    const status = await f.client.status(); assert.equal(status.allowed, false); assert.equal(status.reason, 'update_manager_invalid');
    assert.ok(!JSON.stringify(status).includes(f.root));
  }
});
test('backend socket client has a total deadline and a bounded response, not renewable idle timeout', async t => {
  const root = await realpath(await mkdtemp('/tmp/guan-slow-peer-')), socketPath = path.join(root, 'u.sock'), sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await new Promise(resolve => server.listen(socketPath, resolve)); await chmod(socketPath, 0o600);
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const client = new UpdateManagerClient({ socketPath, timeoutMs: 50 });
  assert.equal((await client.status()).reason, 'update_manager_unavailable');
});
test('SoftwareUpdates exposes safe manager diagnostics, coalesces staging and preserves download on failure', async t => {
  const f = await fixture(t); let complete, attempts = 0;
  const directory = path.join(f.root, 'updates'); await mkdir(directory, { mode: 0o700 });
  const updates = new SoftwareUpdates({ directory, currentVersion: '1.0.4',
    auth: { metadata: async () => null },
    downloader: { status: () => ({ state: 'verified', progress: 100 }), cancel() {},
      stageIdentity: repository => ({ repository, version: '1.0.5', downloadId: id }) },
    manager: { status: () => f.client.status(), stage: () => { attempts++; return new Promise(resolve => { complete = resolve; }); } } });
  await updates.configure({ repository: 'Champion-Guan/infinite-canvas' });
  const [first, second] = await Promise.all([updates.stage(), updates.stage()]);
  assert.equal(first.install.staging, true); assert.equal(second.install.staging, true); assert.equal(attempts, 1);
  complete(); await updates.staging;
  assert.equal((await updates.status()).install.staging, false);
  updates.manager.stage = async () => { throw new UpdateError('update_manager_unavailable'); };
  await updates.stage(); await updates.staging;
  const status = await updates.status(); assert.equal(status.install.stageError, 'update_manager_unavailable');
  assert.equal(status.download.state, 'verified'); assert.equal(status.install.allowed, false);
});
