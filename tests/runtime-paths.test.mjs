import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runtimePaths, prepareRuntimePaths, readPrivateFile, writePrivateFile, readProxyState, writePrivateJson, flushPrivateWrites } from '../src/server/runtime-paths.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'guan-private-path-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), dataRoot = path.join(root, 'private');
  await mkdir(path.join(project, 'config', 'examples'), { recursive: true });
  const options = { home: path.join(root, 'home'), env: { GUAN_WORKBENCH_DATA_DIR: dataRoot }, os: 'darwin' };
  return { root, project, dataRoot, options };
}

test('macOS private runtime layout is independent of version checkout and keeps origin separate', () => {
  const p = runtimePaths({ projectRoot: '/workspace/workbench', home: '/test/user', env: {}, os: 'darwin' });
  assert.equal(p.root, '/test/user/Library/Application Support/GuanAIWorkbench');
  assert.equal(p.proxyStateFile, `${p.root}/data/proxy/state.json`);
  for (const root of ['/', '/test/user', '/workspace/workbench', '/workspace/workbench/data', 'relative']) {
    assert.throws(() => runtimePaths({ projectRoot: '/workspace/workbench', home: '/test/user', env: { GUAN_WORKBENCH_DATA_DIR: root } }));
  }
});

test('legacy profile, env and routes are copied once, not removed or overwritten by new defaults', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, 'config/default-proxy.yaml'), 'legacy-private-profile');
  await writeFile(path.join(f.project, '.env.local'), 'TEST_SETTING=private-fixture');
  await writeFile(path.join(f.project, '.image-relay-transports.json'), '{"fixture":"proxy"}');
  const first = await prepareRuntimePaths(f.project, f.options);
  assert.equal(first.copiedProfile, true);
  assert.equal(await readFile(first.paths.proxyConfigFile, 'utf8'), 'legacy-private-profile');
  await writePrivateFile(first.paths.proxyConfigFile, 'user-edited-profile');
  await writeFile(path.join(f.project, 'config/default-proxy.yaml'), 'new-version-default');
  const second = await prepareRuntimePaths(f.project, f.options);
  assert.equal(second.copiedProfile, false);
  assert.equal(await readFile(first.paths.proxyConfigFile, 'utf8'), 'user-edited-profile');
  assert.equal(await readFile(path.join(f.project, '.env.local'), 'utf8'), 'TEST_SETTING=private-fixture');
  assert.equal((await stat(first.paths.root)).mode & 0o777, 0o700);
  assert.equal((await stat(first.paths.envFile)).mode & 0o777, 0o600);
});

test('clean installation uses only a public template and two Macs stay isolated', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, 'config/examples/default-proxy.yaml'), 'proxies: []\n');
  const a = await prepareRuntimePaths(f.project, f.options);
  const b = await prepareRuntimePaths(f.project, { ...f.options, env: { GUAN_WORKBENCH_DATA_DIR: path.join(f.root, 'mac-b') } });
  await writePrivateFile(a.paths.proxyConfigFile, 'mac-a-private');
  assert.equal(await readFile(b.paths.proxyConfigFile, 'utf8'), 'proxies: []\n');
});

test('unsafe directory/config symlinks fail closed without altering targets', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, f.dataRoot);
  await assert.rejects(prepareRuntimePaths(f.project, f.options));
  assert.deepEqual(await readdir(outside), []);
  const original = path.join(outside, 'original');
  await writeFile(original, 'keep');
  const alias = path.join(outside, 'alias');
  await symlink(original, alias);
  await assert.rejects(writePrivateFile(alias, 'replace'));
  await assert.rejects(readPrivateFile(alias));
  assert.equal(await readFile(original, 'utf8'), 'keep');
});

test('proxy snapshots persist enable switches and cached subscription; corruption does not become defaults', async t => {
  const f = await fixture(t), { paths } = await prepareRuntimePaths(f.project, f.options);
  const state = { version: 1, enabled: false, relayEnabled: false,
    source: { kind: 'url', value: 'https://example.invalid/private-subscription' }, cachedConfig: 'unit-profile', configName: 'subscription' };
  await writePrivateJson(paths.proxyStateFile, state);
  assert.deepEqual(await readProxyState(paths.proxyStateFile), state);
  await writePrivateFile(paths.proxyStateFile, '{broken');
  await assert.rejects(readProxyState(paths.proxyStateFile), /未使用默认配置覆盖/);
  assert.equal(await readFile(paths.proxyStateFile, 'utf8'), '{broken');
});

test('private concurrent writes are ordered, flushed and do not leave temporary files', async t => {
  const f = await fixture(t), { paths } = await prepareRuntimePaths(f.project, f.options);
  const writes = Array.from({ length: 8 }, (_, revision) => writePrivateJson(paths.transportsFile, { revision }));
  await flushPrivateWrites();
  await Promise.all(writes);
  assert.deepEqual(JSON.parse(await readFile(paths.transportsFile, 'utf8')), { revision: 7 });
  assert.equal((await stat(paths.transportsFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(paths.runtime)).filter(name => name.startsWith('.private-write-')), []);
  assert.equal(await writePrivateFile(paths.transportsFile, 'overwrite', { exclusive: true }), false);
});

test('a failed temporary write preserves the old file and removes its incomplete temporary file', async t => {
  const f = await fixture(t), { paths } = await prepareRuntimePaths(f.project, f.options);
  await writePrivateFile(paths.transportsFile, 'original');
  await assert.rejects(writePrivateFile(paths.transportsFile, { invalidWriteValue: true }));
  assert.equal(await readFile(paths.transportsFile, 'utf8'), 'original');
  assert.deepEqual((await readdir(paths.runtime)).filter(name => name.startsWith('.private-write-')), []);
});
test('bounded private reads preserve UTF8 and reject oversized records without touching their contents', async t => {
  const f = await fixture(t), file = path.join(f.root, 'bounded.json');
  const text = '中文🙂'.repeat(10000), bytes = Buffer.byteLength(text);
  await writeFile(file, text, { mode: 0o600 });
  assert.equal(await readPrivateFile(file, { maxBytes: bytes }), text);
  await assert.rejects(readPrivateFile(file, { maxBytes: bytes - 1 }));
  await assert.rejects(readPrivateFile(file, { maxBytes: 0 }));
  assert.equal(await readPrivateFile(file), text);
  assert.equal(await readPrivateFile(file + '.missing', { maxBytes: 1 }), null);
});
