import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { migrationInstallationMode, inspectPortableService, stopPortableService, verifyPortableBackup } from '../scripts/lib/portable-handoff.mjs';
import { workbenchPageCensus, workbenchTabScript } from '../src/server/workbench-page-census.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'guan-portable-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('only absent metadata selects portable; partial and crashed installations stay blocked', async t => {
  const root = await fixture(t);
  assert.equal(await migrationInstallationMode(root), 'portable');
  await mkdir(path.join(root, 'installation'));
  await writeFile(path.join(root, 'installation/current.json'), '{}');
  await assert.rejects(migrationInstallationMode(root), /incomplete/);
  await mkdir(path.join(root, 'updater-deployment'));
  await writeFile(path.join(root, 'updater-deployment/deployment.json'), '{}');
  assert.equal(await migrationInstallationMode(root), 'managed');
  const crashed = await fixture(t);
  await mkdir(path.join(crashed, 'installation'));
  await writeFile(path.join(crashed, 'installation/bootstrap.json'), '{}');
  await assert.rejects(migrationInstallationMode(crashed), /recovery_required/);
});
test('symlinked installation metadata is refused', async t => {
  const root = await fixture(t); await mkdir(path.join(root, 'installation'));
  await writeFile(path.join(root, 'other.json'), '{}');
  await symlink(path.join(root, 'other.json'), path.join(root, 'installation/current.json'));
  await assert.rejects(migrationInstallationMode(root), /invalid/);
});
test('portable listener must match UID, start time, command, version and private root', async t => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'guan-ai-workbench', version: '1.0.7' }));
  await writeFile(path.join(directory, 'server.mjs'), '// fixture');
  await writeFile(path.join(directory, 'scripts/start-portable.mjs'), '// fixture');
  const privateRoot = '/private/fixture root';
  let owner = process.getuid(), command = '/fixture/node server.mjs', env = `node server.mjs GUAN_WORKBENCH_DATA_DIR=${privateRoot} PATH=/usr/bin`;
  const run = async (file, args) => ({ stdout: file.endsWith('lsof')
    ? args.includes('cwd') ? `p12\nn${directory}\n` : '12\n'
    : args[0] === 'eww' ? env : args.at(-1) === 'uid=' ? String(owner) : args.at(-1) === 'lstart=' ? 'Mon Oct 12 10:00:00 2026' : command });
  const options = { version: '1.0.7', privateRoot, run };
  const result = await inspectPortableService(options);
  assert.equal(result.pid, 12); assert.equal(result.directory, await realpath(directory));
  assert.equal(Object.keys(result.files).length, 3); assert.equal(result.environment, undefined);
  command = `/Applications/fixture runtime/node ${directory}/server.mjs`;
  assert.equal((await inspectPortableService(options)).pid, 12);
  command = '/fixture/node server.mjs';
  owner++; await assert.rejects(inspectPortableService(options), /identity_unknown/); owner--;
  command = '/fixture/node unrelated.mjs'; await assert.rejects(inspectPortableService(options), /identity_unknown/);
  command = '/fixture/node server.mjs'; env = 'node server.mjs GUAN_WORKBENCH_DATA_DIR=/other PATH=/usr/bin';
  await assert.rejects(inspectPortableService(options), /private_root_mismatch/);
  await assert.rejects(inspectPortableService({ ...options, version: '1.0.4' }), /unsupported/);
});
test('PID reuse or newly opened pages prevent the graceful signal', async () => {
  const expected = { pid: 12, started: 'original' }, signals = [];
  await assert.rejects(stopPortableService(expected, { closed: async () => {}, inspect: async () => ({ ...expected, started: 'reused' }), signal: (...args) => signals.push(args) }), /identity_changed/);
  let checks = 0;
  await assert.rejects(stopPortableService(expected, { closed: async () => { if (++checks === 2) throw Error('pages_open'); }, inspect: async () => expected, signal: (...args) => signals.push(args) }), /pages_open/);
  assert.deepEqual(signals, []);
});
test('graceful stop has bounded wait and never escalates to SIGKILL', async () => {
  const expected = { pid: 12 }, signals = [];
  const options = { closed: async () => {}, inspect: async () => expected, signal: (...args) => signals.push(args), wait: async () => {} };
  await stopPortableService(expected, { ...options, alive: async () => false });
  await assert.rejects(stopPortableService(expected, { ...options, alive: async () => true }), /stop_unconfirmed/);
  assert.deepEqual(signals, [[12, 'SIGTERM'], [12, 'SIGTERM']]);
});
test('migration census covers both origins and rejects arbitrary ports', async () => {
  const script = workbenchTabScript('com.google.Chrome', 1, [5174, 8888]);
  for (const host of ['localhost', '127.0.0.1']) for (const port of [5174, 8888]) assert.ok(script.includes(`http://${host}:${port}`));
  assert.throws(() => workbenchTabScript('com.google.Chrome', 1, [9000]), /unavailable/);
  await assert.rejects(workbenchPageCensus({ ports: [9000], execute: async () => ({ stdout: '1 /sbin/launchd' }) }), /unavailable/);
});
test('a fabricated browser receipt cannot bypass the private backup mode and hash checks', async t => {
  const root = await fixture(t), backups = path.join(root, 'backups');
  const directory = path.join(backups, 'port8888-12345678-1234-1234-1234-123456789abc');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'MIGRATION.json'), JSON.stringify({ phase: 'browser-verified', verified: true, databases: 1, records: 1, sha256: 'wrong' }));
  await writeFile(path.join(directory, 'PRIVATE-BACKUP.json'), JSON.stringify({ format: 1, mode: 'portable', files: [] }));
  await writeFile(path.join(directory, 'browser-5174.json'), '{}');
  await assert.rejects(verifyPortableBackup(directory, { backups }), /backup_invalid/);
});
test('native macOS inspector stops only its actual isolated portable Node listener', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await fixture(t);
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'guan-ai-workbench', version: '1.0.7' }));
  await writeFile(path.join(directory, 'scripts/start-portable.mjs'), '// native fixture');
  await writeFile(path.join(directory, 'server.mjs'), "import { createServer } from 'node:net'; const s=createServer(); s.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('ready')); process.on('SIGTERM',()=>s.close(()=>process.exit(0)));\n");
  const child = spawn(process.execPath, ['server.mjs'], { cwd: directory, env: { PATH: process.env.PATH, PORT: String(port), GUAN_WORKBENCH_DATA_DIR: directory + '-private' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await once(child.stdout, 'data');
  const inspect = () => inspectPortableService({ version: '1.0.7', privateRoot: directory + '-private', port });
  const owned = await inspect(); assert.equal(owned.pid, child.pid);
  await stopPortableService(owned, { closed: async () => {}, inspect });
  assert.equal((await exit)[0], 0);
});
