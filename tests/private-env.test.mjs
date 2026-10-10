import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareRuntimePaths } from '../src/server/runtime-paths.mjs';
import { loadPrivateRuntimeEnv } from '../src/server/private-env.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'guan-private-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'code'); await mkdir(project);
  const options = { home: path.join(root, 'home'), os: 'darwin', env: { GUAN_WORKBENCH_DATA_DIR: path.join(root, 'private') } };
  return { root, project, options };
}
test('private env is the only persisted source after copy-once; deleted legacy settings do not reappear', async t => {
  const f = await fixture(t), legacy = path.join(f.project, '.env.local');
  await writeFile(legacy, 'QA_RETAIN=first\nQA_REMOVED=original-fixture\n');
  const { paths } = await prepareRuntimePaths(f.project, f.options);
  const first = {}; assert.equal(await loadPrivateRuntimeEnv(paths.envFile, first), 2);
  await writeFile(paths.envFile, 'QA_RETAIN=edited\n', { mode: 0o600 });
  await writeFile(legacy, 'QA_RETAIN=new-version-default\nQA_REMOVED=should-not-return\n');
  await prepareRuntimePaths(f.project, f.options);
  const target = {}; assert.equal(await loadPrivateRuntimeEnv(paths.envFile, target), 1);
  assert.equal(target.QA_RETAIN, 'edited'); assert.equal(target.QA_REMOVED, undefined);
  assert.equal(await readFile(paths.envFile, 'utf8'), 'QA_RETAIN=edited\n');
  assert.equal(await readFile(legacy, 'utf8'), 'QA_RETAIN=new-version-default\nQA_REMOVED=should-not-return\n');
});
test('launcher values retain precedence and quoted/empty/Unicode legacy values remain compatible', async t => {
  const f = await fixture(t), file = path.join(f.root, 'runtime.env');
  await writeFile(file, 'export QA_A="中文🙂"\r\nQA_B=\r\nQA_C=\'literal # content\'\nQA_OVERRIDE=stored\n# comment\nnot an assignment\n');
  const target = { QA_OVERRIDE: 'launcher' };
  assert.equal(await loadPrivateRuntimeEnv(file, target), 3);
  assert.deepEqual(target, { QA_A: '中文🙂', QA_B: '', QA_C: 'literal # content', QA_OVERRIDE: 'launcher' });
});
test('an unreadable or oversized private env fails without applying defaults or modifying its contents', async t => {
  const f = await fixture(t), file = path.join(f.root, 'runtime.env'), alias = path.join(f.root, 'alias.env');
  await writeFile(file, 'QA_KEY=fixture-value\n'); await symlink(file, alias);
  const target = {}; await assert.rejects(loadPrivateRuntimeEnv(alias, target)); assert.deepEqual(target, {});
  const large = 'QA_KEY=' + 'x'.repeat(2 * 1024 * 1024); await writeFile(file, large);
  await assert.rejects(loadPrivateRuntimeEnv(file, target)); assert.deepEqual(target, {});
  assert.equal(await readFile(file, 'utf8'), large);
  assert.equal(await loadPrivateRuntimeEnv(path.join(f.root, 'missing.env'), target), 0);
});
test('independent installations cannot inherit another private directory environment', async t => {
  const f = await fixture(t);
  const a = await prepareRuntimePaths(f.project, f.options);
  const b = await prepareRuntimePaths(f.project, { ...f.options, env: { GUAN_WORKBENCH_DATA_DIR: path.join(f.root, 'private-b') } });
  await writeFile(a.paths.envFile, 'QA_OWNER=mac-a-fixture\n', { mode: 0o600 });
  await writeFile(b.paths.envFile, 'QA_OWNER=mac-b-fixture\n', { mode: 0o600 });
  const aa = {}, bb = {}; await loadPrivateRuntimeEnv(a.paths.envFile, aa); await loadPrivateRuntimeEnv(b.paths.envFile, bb);
  assert.equal(aa.QA_OWNER, 'mac-a-fixture'); assert.equal(bb.QA_OWNER, 'mac-b-fixture');
});
test('actual server startup loads private env only, with no legacy overlay', async () => {
  const source = await readFile(new URL('../src/server/index.mjs', import.meta.url), 'utf8');
  assert.match(source, /await loadPrivateRuntimeEnv\(privatePaths\.envFile\)/);
  assert.doesNotMatch(source, /loadLocalEnvFile/);
});
