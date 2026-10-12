import path from 'node:path';
import { constants, createReadStream } from 'node:fs';
import { mkdir, lstat, realpath, readdir, copyFile, chmod, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { writePrivateFile, readPrivateFile, privateDirectory } from './runtime-paths.mjs';
import { browserProcessCensus } from './browser-process-census.mjs';
import { workbenchPageCensus } from './workbench-page-census.mjs';
const inside = (a, b) => b === a || b.startsWith(a + path.sep);
async function hash(file) {
  const sum = createHash('sha256');
  for await (const chunk of createReadStream(file, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) sum.update(chunk);
  return sum.digest('hex');
}
async function inventory(root, { liveChrome = false } = {}) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory)).sort()) {
      const file = path.join(directory, entry), info = await lstat(file);
      // Chrome's process coordination symlinks are not user data and cannot
      // be restored to a different process. No other links are exempted.
      if (liveChrome && directory === root && ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].includes(entry)
        && info.isSymbolicLink()) continue;
      if (info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('update_backup_source_unknown');
      if (info.isDirectory()) await visit(file);
      else if (info.isFile() && info.nlink === 1) files.push({ path: path.relative(root, file), size: info.size,
        mode: info.mode & 0o777, hash: await hash(file) });
      else throw Error('update_backup_source_unknown');
      if (files.length > 1000000) throw Error('update_backup_source_unknown');
    }
  }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw Error('update_backup_source_unknown');
  await visit(root); return files;
}

// Local-only byte copy of private files and existing Chrome profiles. A live
// browser copy is not a transactional/cold DB backup and is labelled as such.
// Updating code never restores, migrates or writes browser database files.
// Checksum receipt remains private; callers expose only counts/verified status.
export async function createMaintenanceBackup({ directory, dataRoot, browserRoot, census = workbenchPageCensus,
  processCensus = browserProcessCensus }) {
  if (![directory, dataRoot, browserRoot].every(v => typeof v === 'string' && path.isAbsolute(v)
    && path.resolve(v) === v && !/[\x00-\x1f]/.test(v)) || [dataRoot, browserRoot].some(root => inside(root, directory) || inside(directory, root)))
    throw Error('update_backup_path_invalid');
  const closed = async () => {
    const value = await census();
    if (value?.workbenchPagesClosed !== true || !Array.isArray(value.blockers) || value.blockers.length) throw Error('install_browsers_running');
  };
  await closed();
  // Live copies are explicitly labelled, never called offline/cold backups.
  // Continuous source-byte checks reject concurrent browser database writes.
  const processes = await processCensus(), liveChrome = processes.blockers.includes('Chrome') || processes.blockers.includes('Chromium');
  await privateDirectory(directory);
  if (await realpath(directory) !== directory) throw Error('update_backup_path_invalid');
  const target = path.join(directory, 'pre-bootstrap-' + randomUUID());
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (await realpath(target) !== target) throw Error('update_backup_path_invalid');
  const sections = [];
  for (const [name, source] of [['data', dataRoot], ['chrome', browserRoot]]) {
    await closed(); const before = await inventory(source, { liveChrome: name === 'chrome' && liveChrome }), destination = path.join(target, name);
    await mkdir(destination, { mode: 0o700 });
    for (const file of before) {
      const output = path.join(destination, file.path); await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await copyFile(path.join(source, file.path), output, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await chmod(output, 0o600);
      const handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      if (await hash(output) !== file.hash) throw Error('update_backup_verification_failed');
    }
    // Detect writing apps, not merely count files or trust a completed copy.
    if (JSON.stringify(before) !== JSON.stringify(await inventory(source, { liveChrome: name === 'chrome' && liveChrome }))) throw Error('update_backup_source_changed');
    await closed(); sections.push({ name, files: before });
  }
  for (const [i, source] of [dataRoot, browserRoot].entries()) {
    if (JSON.stringify(sections[i].files) !== JSON.stringify(await inventory(source, { liveChrome: i === 1 && liveChrome }))) throw Error('update_backup_source_changed');
  }
  await closed();
  const finalProcesses = await processCensus();
  if (liveChrome !== (finalProcesses.blockers.includes('Chrome') || finalProcesses.blockers.includes('Chromium')))
    throw Error('update_backup_source_changed');
  await writePrivateFile(path.join(target, 'BACKUP.json'), JSON.stringify({ format: 1, origin: 'http://127.0.0.1:5174',
    browserBackupMode: liveChrome ? 'stable-byte-copy' : 'offline', automaticBrowserRestoreAllowed: false, sections }));
  await verifyMaintenanceBackup(target);
  async function syncDirectories(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await syncDirectories(path.join(directory, entry.name));
    const handle = await open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncDirectories(target);
  const parent = await open(directory, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
  return { directory: target, verified: true, files: sections.reduce((n, section) => n + section.files.length, 0) };
}
export async function verifyMaintenanceBackup(directory) {
  const raw = await readPrivateFile(path.join(directory, 'BACKUP.json'), { maxBytes: 256 * 1024 * 1024 }), value = JSON.parse(raw);
  if (value?.format !== 1 || value.origin !== 'http://127.0.0.1:5174' || !Array.isArray(value.sections)
    || value.sections.length !== 2 || value.sections[0]?.name !== 'data' || value.sections[1]?.name !== 'chrome') throw Error('update_backup_verification_failed');
  for (const section of value.sections) {
    if (!Array.isArray(section.files)) throw Error('update_backup_verification_failed');
    const actual = await inventory(path.join(directory, section.name));
    // The private backup is deliberately non-executable; original modes are
    // retained in the receipt for an explicit restore, not applied in-place.
    if (JSON.stringify(actual.map(file => ({ path: file.path, size: file.size, hash: file.hash })))
      !== JSON.stringify(section.files.map(file => ({ path: file.path, size: file.size, hash: file.hash })))) throw Error('update_backup_verification_failed');
  }
  return true;
}
