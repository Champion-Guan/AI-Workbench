import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SoftwareUpdates } from '../src/server/software-updates.mjs';
import { writePrivateJson } from '../src/server/runtime-paths.mjs';
import { STABLE_REPOSITORY, sameWorkbenchRepository, isPublicUpdateRepository } from '../src/server/workbench-identity.mjs';

test('old channel preferences retain user choices and history while checks use the locked fork without credentials', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'guan-channel-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = { version: 1, repository: 'Champion-Guan/AI-Workbench', autoCheck: false, autoDownload: false, autoInstall: false, network: 'direct' };
  await writePrivateJson(path.join(directory, 'preferences.json'), original);
  const entries = [{ at: '2026-10-13T00:00:00Z', state: 'up-to-date', version: '1.0.13', error: null }];
  await writePrivateJson(path.join(directory, 'check-history.json'), { version: 1, repository: original.repository, entries });
  const updates = new SoftwareUpdates({ directory, currentVersion: '1.0.14', auth: { token: async repo => { assert.equal(repo, STABLE_REPOSITORY); return ''; }, metadata: () => { throw Error('public channel must not read credentials'); } },
    readRelease: async options => { assert.equal(options.repository, 'Champion-Guan/infinite-canvas'); assert.equal(options.token, ''); return null; } });
  assert.deepEqual(await updates.preferences(), { ...original, repository: STABLE_REPOSITORY });
  assert.deepEqual(await updates.history(STABLE_REPOSITORY), entries);
  assert.deepEqual(JSON.parse(await readFile(updates.file, 'utf8')), original);
  await assert.rejects(updates.configure({ repository: 'foreign/repo' }), /update_repository_locked/);
  await assert.rejects(updates.configure({ repository: original.repository }), /update_repository_locked/);
  assert.equal((await updates.check()).state, 'no-stable-release');
  assert.equal(isPublicUpdateRepository(original.repository), true);
  assert.equal(sameWorkbenchRepository(original.repository, STABLE_REPOSITORY), true);
  assert.equal(sameWorkbenchRepository('basketikun/infinite-canvas', STABLE_REPOSITORY), false);
});
