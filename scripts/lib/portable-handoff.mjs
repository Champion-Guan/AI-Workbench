import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readPrivateFile } from '../../src/server/runtime-paths.mjs';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function verifyPortableBackup(directory, paths) {
  if (path.dirname(directory) !== paths.backups || !/^port8888-[a-f0-9-]{36}$/.test(path.basename(directory)))
    throw Error('migration_backup_invalid');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077)
    throw Error('migration_backup_invalid');
  const receipt = JSON.parse(await readPrivateFile(path.join(directory, 'MIGRATION.json'), { maxBytes: 4096 }));
  const backup = JSON.parse(await readPrivateFile(path.join(directory, 'PRIVATE-BACKUP.json'), { maxBytes: 16 * 1024 * 1024 }));
  if (receipt.phase !== 'browser-verified' || receipt.verified !== true || receipt.databases < 1 || receipt.records < 1
    || backup.format !== 1 || backup.mode !== 'portable' || !Array.isArray(backup.files)
    || hash(await readFile(path.join(directory, 'browser-5174.json'))) !== receipt.sha256) throw Error('migration_backup_invalid');
  const inventory = async root => {
    const files = [];
    async function walk(dir) {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('migration_backup_invalid');
      for (const name of (await readdir(dir)).sort()) {
        const file = path.join(dir, name), stat = await lstat(file);
        if (stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('migration_backup_invalid');
        if (stat.isDirectory()) await walk(file);
        else if (stat.isFile()) files.push({ name: path.relative(root, file), size: stat.size, sha256: hash(await readFile(file)) });
        else throw Error('migration_backup_invalid');
      }
    }
    await walk(root); return files;
  };
  if (JSON.stringify(await inventory(path.join(directory, 'data'))) !== JSON.stringify(backup.files))
    throw Error('migration_backup_invalid');
  return { verified: true };
}
export async function migrationInstallationMode(root) {
  const present = [];
  for (const name of ['installation/current.json', 'updater-deployment/deployment.json']) {
    try {
      const info = await lstat(path.join(root, name));
      if (!info.isFile() || info.isSymbolicLink()) throw Error('migration_installation_invalid');
      present.push(true);
    } catch (error) { if (error.code !== 'ENOENT') throw error; present.push(false); }
  }
  if (present.every(Boolean)) return 'managed';
  if (present.some(Boolean)) throw Error('migration_installation_incomplete');
  // A failed previous bootstrap must never be mistaken for a fresh portable install.
  for (const name of ['installation/bootstrap.json', 'installation/transaction.json', 'updater-deployment/transaction.json']) {
    try { await lstat(path.join(root, name)); throw Error('migration_recovery_required'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return 'portable';
}

// Inspect only the exact listener. Never return environment values or issue a
// kill-by-port command. Start time, UID, executable and source bytes are pinned.
export async function inspectPortableService({ version, privateRoot, run = execute, uid = process.getuid(), port = 5174 } = {}) {
  if (version !== '1.0.7') throw Error('migration_portable_version_unsupported');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('migration_service_identity_unknown');
  const command = async (file, args) => (await run(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const listeners = [...new Set((await command('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])).split(/\s+/))];
  if (listeners.length !== 1 || !/^[1-9][0-9]*$/.test(listeners[0])) throw Error('migration_service_identity_unknown');
  const pid = Number(listeners[0]);
  const owner = await command('/bin/ps', ['-p', String(pid), '-o', 'uid=']);
  const started = await command('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
  const argv = await command('/bin/ps', ['-p', String(pid), '-o', 'command=']);
  const cwd = (await command('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])).split('\n').find(line => line.startsWith('n'))?.slice(1);
  const knownEntry = cwd && [path.join(cwd, 'server.mjs'), 'server.mjs', './server.mjs'].some(entry =>
    argv.endsWith(' ' + entry) && /(?:^|\/)node$/.test(argv.slice(0, -entry.length - 1)));
  if (Number(owner) !== uid || !started || !cwd || !path.isAbsolute(cwd)
    || !knownEntry) throw Error('migration_service_identity_unknown');
  const directory = await realpath(cwd);
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.name !== 'guan-ai-workbench' || metadata.version !== version) throw Error('migration_service_identity_unknown');
  // A custom private root must be explicitly matched, never silently switched.
  const environment = await command('/bin/ps', ['eww', '-p', String(pid), '-o', 'command=']);
  const custom = /(?:^|\s)GUAN_WORKBENCH_DATA_DIR=(.*?)(?=\s[A-Za-z_][A-Za-z_0-9]*=|$)/.exec(environment)?.[1];
  if (custom && path.resolve(custom) !== privateRoot) throw Error('migration_private_root_mismatch');
  const files = {};
  for (const name of ['server.mjs', 'package.json', 'scripts/start-portable.mjs']) {
    const file = path.join(directory, name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid) throw Error('migration_service_identity_unknown');
    files[name] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return { pid, uid, started, argv, directory, version, files };
}

export async function stopPortableService(expected, { inspect, closed, signal = (pid, value) => process.kill(pid, value),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } } }) {
  await closed();
  if (JSON.stringify(await inspect()) !== JSON.stringify(expected)) throw Error('migration_service_identity_changed');
  await closed();
  // Recheck immediately before the sole graceful signal; no SIGKILL fallback.
  if (JSON.stringify(await inspect()) !== JSON.stringify(expected)) throw Error('migration_service_identity_changed');
  signal(expected.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!await alive(expected.pid)) return;
    await wait(100);
  }
  throw Error('migration_legacy_stop_unconfirmed');
}
