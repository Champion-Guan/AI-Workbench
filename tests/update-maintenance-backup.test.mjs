import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { createMaintenanceBackup, verifyMaintenanceBackup } from '../src/server/update-maintenance-backup.mjs';
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-maintenance-backup-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data'), browserRoot = path.join(root, 'chrome'), directory = path.join(root, 'backups');
  await mkdir(path.join(dataRoot, 'config'), { recursive: true }); await mkdir(path.join(browserRoot, 'Default/IndexedDB'), { recursive: true });
  await writeFile(path.join(dataRoot, 'config/local'), 'QA private settings; not uploaded');
  await writeFile(path.join(browserRoot, 'Default/IndexedDB/records'), Buffer.from([0, 255, 14, 9]));
  return { root, dataRoot, browserRoot, directory, census: async () => ({ workbenchPagesClosed: true, blockers: [] }),
    processCensus: async () => ({ knownBrowsersExited: true, blockers: [] }) };
}
test('offline backup preserves every source byte, verifies destination and restricts backup permissions without changing original files', async t => {
  const f = await fixture(t), result = await createMaintenanceBackup(f);
  assert.equal(result.verified, true); assert.equal(result.files, 2);
  assert.equal((await lstat(result.directory)).mode & 0o777, 0o700);
  assert.equal(await verifyMaintenanceBackup(result.directory), true);
  assert.deepEqual(await readFile(path.join(result.directory, 'chrome/Default/IndexedDB/records')), Buffer.from([0, 255, 14, 9]));
  assert.equal(await readFile(path.join(f.dataRoot, 'config/local'), 'utf8'), 'QA private settings; not uploaded');
  await writeFile(path.join(result.directory, 'data/config/local'), 'broken');
  await assert.rejects(verifyMaintenanceBackup(result.directory), /verification_failed/);
  assert.equal(await readFile(path.join(f.dataRoot, 'config/local'), 'utf8'), 'QA private settings; not uploaded');
});
test('browser may stay running after workbench closes; byte snapshot is labelled and never authorizes automatic browser restore', async t => {
  const f = await fixture(t);
  await symlink('/tmp/chrome-process-lock', path.join(f.browserRoot, 'SingletonLock'));
  const result = await createMaintenanceBackup({ ...f, processCensus: async () => ({ knownBrowsersExited: false, blockers: ['Chrome'] }) });
  const record = JSON.parse(await readFile(path.join(result.directory, 'BACKUP.json'), 'utf8'));
  assert.equal(record.browserBackupMode, 'stable-byte-copy');
  assert.equal(record.automaticBrowserRestoreAllowed, false);
  assert.equal(await verifyMaintenanceBackup(result.directory), true);
  assert.equal((await lstat(path.join(f.browserRoot, 'SingletonLock'))).isSymbolicLink(), true);
});
test('browser data changing while other sites remain open blocks backup instead of accepting a partial snapshot', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(createMaintenanceBackup({ ...f,
    census: async () => {
      if (++calls === 5) await writeFile(path.join(f.browserRoot, 'Default/IndexedDB/records'), 'changed');
      return { workbenchPagesClosed: true, blockers: [] };
    }, processCensus: async () => ({ knownBrowsersExited: false, blockers: ['Chrome'] }),
  }), /source_changed/);
  assert.equal(await readFile(path.join(f.browserRoot, 'Default/IndexedDB/records'), 'utf8'), 'changed');
});
test('browser reopening, symlink sources and overlapping destination refuse backup without clearing originals', async t => {
  const f = await fixture(t); let checks = 0;
  await assert.rejects(createMaintenanceBackup({ ...f, census: async () => ({ workbenchPagesClosed: ++checks < 3, blockers: [] }) }), /browsers_running/);
  const g = await fixture(t); await symlink(g.dataRoot, path.join(g.browserRoot, 'linked')); await assert.rejects(createMaintenanceBackup(g), /source_unknown/);
  await assert.rejects(createMaintenanceBackup({ ...g, directory: path.join(g.dataRoot, 'backup') }), /path_invalid/);
  assert.equal(await readFile(path.join(g.dataRoot, 'config/local'), 'utf8'), 'QA private settings; not uploaded');
});
