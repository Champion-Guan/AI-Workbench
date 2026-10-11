import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { mkdtemp, realpath, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { SignedUpdaterRuntime } from '../src/server/update-runtime.mjs';
import { signedUpdateFixture, testSigningIdentity } from './helpers/signed-update.mjs';
const entries = ['scripts/run-update-manager.mjs', 'scripts/run-update-supervisor.mjs', 'scripts/run-browser-bridge.mjs',
  'src/server/update-manager.mjs', 'src/server/update-supervisor.mjs', 'src/server/update-service.mjs'];
async function fixture(t, files = Object.fromEntries(entries.map(n => [n, '// signed synthetic non-executable updater fixture']))) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-runtime-'))); t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, 'data'); await mkdir(dataRoot); await writeFile(path.join(dataRoot, 'sentinel'), 'retain');
  const signing = testSigningIdentity(), manager = new UpdateManager({ root: path.join(base, 'installation'), dataRoot,
    repository: 'owner/repo', trustedKeys: signing.keys, platform: 'darwin', arch: 'arm64', freeSpace: async () => 4e9 });
  const pointer = await manager.stage(await signedUpdateFixture(base, signing, '1.0.5', { backend: '//not executed', startup: '//fixture', files }));
  const runtime = new SignedUpdaterRuntime({ directory: path.join(base, 'updater-runtime'), manager });
  return { base, manager, pointer, runtime, dataRoot };
}
test('independent signed runtime is immutable, reverified, reused only by exact identity and never activates app or writes data', async t => {
  const f = await fixture(t), value = await f.runtime.prepare(f.pointer);
  assert.equal(value.directory, path.join(f.base, 'updater-runtime', f.pointer.id));
  assert.equal(value.entry, path.join(value.directory, 'scripts/run-update-manager.mjs'));
  assert.equal((await f.runtime.prepare(f.pointer)).directory, value.directory);
  assert.equal(await f.manager.readCurrent(), null); assert.equal(await f.manager.readBootstrap(), null);
  assert.equal(await readFile(path.join(f.dataRoot, 'sentinel'), 'utf8'), 'retain');
});
test('signed app missing independent entries does not become an updater runtime', async t => {
  const f = await fixture(t, {}); await assert.rejects(f.runtime.prepare(f.pointer), /incomplete/);
  assert.equal(await f.manager.readCurrent(), null);
});
test('modified runtime, invalid signature source and symlink destination fail closed without overwriting old files', async t => {
  const f = await fixture(t), value = await f.runtime.prepare(f.pointer), entry = path.join(value.directory, entries[0]);
  await writeFile(entry, 'tampered'); await assert.rejects(f.runtime.prepare(f.pointer));
  assert.equal(await readFile(entry, 'utf8'), 'tampered');
  const g = await fixture(t); await mkdir(g.runtime.directory); await symlink(g.dataRoot, path.join(g.runtime.directory, g.pointer.id));
  await assert.rejects(g.runtime.prepare(g.pointer)); assert.equal(await readFile(path.join(g.dataRoot, 'sentinel'), 'utf8'), 'retain');
});
test('updater runtime refuses installation and business-data hierarchy overlap', async t => {
  const f = await fixture(t);
  for (const directory of ['/', homedir(), f.runtime.directory + '/x/../unsafe', f.dataRoot, f.manager.root, f.base, path.join(f.dataRoot, 'runtime')])
    assert.throws(() => new SignedUpdaterRuntime({ directory, manager: f.manager }), /invalid/);
});
