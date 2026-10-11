import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, rm, mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { serveUpdateManager } from '../src/server/update-manager-ipc.mjs';
import { updateManagerLaunchAgent } from '../src/server/update-launchd.mjs';

function request(socketPath, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath), chunks = [];
    socket.once('connect', () => socket.write(raw)); socket.on('data', b => chunks.push(b));
    socket.once('error', reject); socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
async function fixture(t) {
  const root = await mkdtemp('/tmp/guan-ipc-'), socketPath = path.join(root, 'u.sock'), downloadsDirectory = path.join(root, 'packages'), calls = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(downloadsDirectory);
  const manager = { status: () => ({ state: 'idle', installAllowed: false }), stage: async input => { calls.push(input); return { version: input.version }; } };
  const server = await serveUpdateManager({ manager, socketPath, downloadsDirectory }); t.after(() => server.close());
  return { root, socketPath, downloadsDirectory, calls };
}
test('Unix IPC is user-private and accepts status without any installation rights', async t => {
  const f = await fixture(t);
  assert.equal((await stat(f.socketPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await request(f.socketPath, '{"op":"status"}\n')), { ok: true, result: { state: 'idle', installAllowed: false } });
});
test('IPC accepts only strict download identity/version; never a caller-supplied path or URL', async t => {
  const f = await fixture(t), downloadId = 'verified-00000000-0000-0000-0000-000000000000';
  await mkdir(path.join(f.downloadsDirectory, downloadId));
  assert.equal(JSON.parse(await request(f.socketPath, JSON.stringify({ op: 'stage', downloadId, version: '1.0.5' }) + '\n')).ok, true);
  assert.deepEqual(f.calls, [{ directory: path.join(f.downloadsDirectory, downloadId), version: '1.0.5' }]);
  for (const input of [{ op: 'install' }, { op: 'exec', command: 'arbitrary' }, { op: 'recover' }, { op: 'status', extra: true },
    { op: 'stage', downloadId: '../data', version: '1.0.5' }, { op: 'stage', downloadId, version: '1.0.5-beta' },
    { op: 'stage', downloadId, version: '1.0.5', directory: '/private/data' }])
    assert.equal(JSON.parse(await request(f.socketPath, JSON.stringify(input) + '\n')).ok, false);
  assert.equal(f.calls.length, 1);
});
test('existing socket/file is preserved, never unlinked to hijack another daemon', async t => {
  const root = await mkdtemp('/tmp/guan-ipc-existing-'); t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = path.join(root, 'u.sock'); await writeFile(socketPath, 'keep');
  await assert.rejects(serveUpdateManager({ manager: {}, socketPath, downloadsDirectory: root }), /socket_exists/);
  assert.equal(await readFile(socketPath, 'utf8'), 'keep');
});
test('malformed JSON and multiple requests in one frame fail without leaking exception information', async t => {
  const f = await fixture(t);
  for (const raw of ['{broken}\n', '{"op":"status"}\n{"op":"status"}\n']) {
    const result = await request(f.socketPath, raw); assert.equal(JSON.parse(result).ok, false); assert.ok(!result.includes(f.root));
  }
});
test('launchd generation pins independent runtime and entry, is user-mode and XML-escapes paths', () => {
  const root = '/Users/QA/Application Support/Guan & Test';
  const xml = updateManagerLaunchAgent({ node: root + '/manager/runtime/node', entry: root + '/manager/scripts/run-update-manager.mjs',
    directory: root + '/manager', dataRoot: root, logs: root + '/logs' });
  assert.match(xml, /Guan &amp; Test/); assert.match(xml, /com.guanaiworkbench.updater/); assert.match(xml, /Umask/);
  assert.doesNotMatch(xml, /UserName|root<|LaunchDaemons|\/bin\/sh|current\.json/);
  if (process.platform === 'darwin') assert.equal(spawnSync('/usr/bin/plutil', ['-lint', '-'], { input: xml, encoding: 'utf8' }).status, 0);
  assert.throws(() => updateManagerLaunchAgent({ node: '/bin/sh', entry: '/unsafe', directory: '/', dataRoot: '/', logs: '/' }));
});
