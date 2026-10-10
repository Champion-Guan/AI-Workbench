import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateZipArchive, verifyReleaseFiles } from '../scripts/lib/release-validation.mjs';
import { startBuiltInImageProxy } from '../src/server/proxy-service.mjs';
async function fixture(t) {
  const temp = await mkdtemp(path.join(tmpdir(), 'guan-release-validation-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'fixture');
  const files = {
    'package.json': JSON.stringify({ name: 'guan-ai-workbench', version: '1.2.3' }),
    'server.mjs': '// fixture entry', 'src/server/index.mjs': '// fixture server',
    'public/index.html': '<!doctype html><title>fixture</title>',
    'public/infinite-canvas/index.html': '<script src="/assets/fixture.js"></script>',
    'public/infinite-canvas/assets/fixture.js': '// fixture bundle',
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const hashes = Object.fromEntries(Object.entries(files).map(([file, content]) => [file, createHash('sha256').update(content).digest('hex')]));
  const manifest = { app: 'guan-ai-workbench', edition: 'portable-unsigned', version: '1.2.3', entry: 'server.mjs', files: hashes };
  await writeFile(path.join(root, 'RELEASE.json'), JSON.stringify(manifest));
  return { temp, root, manifest };
}
test('release hashes must cover the complete inventory and match version/build assets', async t => {
  const f = await fixture(t);
  const result = await verifyReleaseFiles(f.root);
  assert.equal(result.files, 6);
  assert.deepEqual(result.assets, ['/assets/fixture.js']);
  assert.equal(result.buildId.length, 24);
  await writeFile(path.join(f.root, 'unlisted.txt'), 'unexpected');
  await assert.rejects(verifyReleaseFiles(f.root), /inventory/);
});

test('fresh build metadata must match its exact nested inventory and source identity', async t => {
  const f = await fixture(t), prefix = 'public/infinite-canvas/';
  const bridge = '// fixture bridge';
  await writeFile(path.join(f.root, prefix + 'excel-prompts-bridge.js'), bridge);
  f.manifest.files[prefix + 'excel-prompts-bridge.js'] = createHash('sha256').update(bridge).digest('hex');
  const build = { app: 'guan-ai-workbench', format: 1, version: '1.2.3', sourceHash: 'a'.repeat(64),
    files: Object.fromEntries(Object.entries(f.manifest.files).filter(([name]) => name.startsWith(prefix)).map(([name, hash]) => [name.slice(prefix.length), hash])) };
  async function writeBuild() {
    const text = JSON.stringify(build);
    await writeFile(path.join(f.root, prefix + 'CANVAS-BUILD.json'), text);
    f.manifest.files[prefix + 'CANVAS-BUILD.json'] = createHash('sha256').update(text).digest('hex');
    await writeFile(path.join(f.root, 'RELEASE.json'), JSON.stringify(f.manifest));
  }
  f.manifest.canvasBuild = { version: '1.2.3', sourceHash: build.sourceHash };
  await writeBuild(); await verifyReleaseFiles(f.root);
  build.sourceHash = 'b'.repeat(64); await writeBuild();
  await assert.rejects(verifyReleaseFiles(f.root), /identity mismatch/);
  build.sourceHash = f.manifest.canvasBuild.sourceHash;
  delete build.files['excel-prompts-bridge.js']; await writeBuild();
  await assert.rejects(verifyReleaseFiles(f.root), /canvas inventory mismatch/);
});
test('tampering, package version mismatch and personal editions fail verification', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'server.mjs'), 'modified');
  await assert.rejects(verifyReleaseFiles(f.root), /verification failed/);
  f.manifest.edition = 'personal-private';
  await writeFile(path.join(f.root, 'RELEASE.json'), JSON.stringify(f.manifest));
  await assert.rejects(verifyReleaseFiles(f.root), /Sensitive|manifest/);
});
test('native package verifies source, architecture and nested helper identity even when outer hashes are updated', async t => {
  const f = await fixture(t);
  const binary = Buffer.alloc(32); binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x0100000c, 4);
  const source = '// synthetic native fixture';
  const native = { app: 'guan-ai-workbench', platform: 'darwin', unsigned: true, arch: 'arm64',
    binarySha256: createHash('sha256').update(binary).digest('hex'), sourceSha256: createHash('sha256').update(source).digest('hex') };
  async function put(name, content) {
    await mkdir(path.dirname(path.join(f.root, name)), { recursive: true });
    await writeFile(path.join(f.root, name), content);
    f.manifest.files[name] = createHash('sha256').update(content).digest('hex');
  }
  await put('bin/guan-keychain', binary); await put('src/native/keychain-helper.swift', source);
  await put('scripts/install-keychain-helper.mjs', '// installer'); await put('scripts/lib/native-keychain-build.mjs', '// verifier');
  const save = async () => { await put('bin/KEYCHAIN-BUILD.json', JSON.stringify(native)); f.manifest.nativeHelper = { ...native }; await writeFile(path.join(f.root, 'RELEASE.json'), JSON.stringify(f.manifest)); };
  await save(); await verifyReleaseFiles(f.root);
  native.arch = 'x64'; await save(); await assert.rejects(verifyReleaseFiles(f.root), /architecture mismatch/);
  native.arch = 'arm64'; await save(); await put('src/native/keychain-helper.swift', '// changed');
  await writeFile(path.join(f.root, 'RELEASE.json'), JSON.stringify(f.manifest));
  await assert.rejects(verifyReleaseFiles(f.root), /identity mismatch/);
});
test('a correctly hashed package with a different version still fails identity validation', async t => {
  const f = await fixture(t);
  const content = JSON.stringify({ name: 'guan-ai-workbench', version: '1.2.4' });
  await writeFile(path.join(f.root, 'package.json'), content);
  f.manifest.files['package.json'] = createHash('sha256').update(content).digest('hex');
  await writeFile(path.join(f.root, 'RELEASE.json'), JSON.stringify(f.manifest));
  await assert.rejects(verifyReleaseFiles(f.root), /version\/entry mismatch/);
});
test('release config symlinks and private credential/data files are rejected', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.env.local'), 'fixture');
  await assert.rejects(verifyReleaseFiles(f.root), /Sensitive/);
  await rm(path.join(f.root, '.env.local'));
  await symlink('server.mjs', path.join(f.root, 'linked.mjs'));
  await assert.rejects(verifyReleaseFiles(f.root), /links/);
});
test('ZIP validation rejects traversal, symlinks and corrupted directory metadata before extraction', async t => {
  const f = await fixture(t);
  const archive = path.join(f.temp, 'fixture.zip');
  execFileSync('zip', ['-qr', archive, 'fixture'], { cwd: f.temp });
  const good = await readFile(archive);
  assert.equal(validateZipArchive(good).root, 'fixture');
  const traversal = Buffer.from(good);
  const center = traversal.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  traversal.write('../', center + 46, 'utf8');
  assert.throws(() => validateZipArchive(traversal), /Unsafe/);
  const link = Buffer.from(good);
  link.writeUInt32LE((0o120777 << 16) >>> 0, center + 38);
  assert.throws(() => validateZipArchive(link), /links/);
  assert.throws(() => validateZipArchive(good.subarray(0, good.length - 1)));
});
test('ZIP local filename mismatch and deceptive expansion sizes fail before disk extraction', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'compressible.txt'), 'A'.repeat(1024 * 1024));
  const archive = path.join(f.temp, 'fixture.zip');
  execFileSync('zip', ['-qr', archive, 'fixture'], { cwd: f.temp });
  const good = await readFile(archive), mismatch = Buffer.from(good);
  const central = mismatch.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const local = mismatch.readUInt32LE(central + 42);
  mismatch.write('X', local + 30);
  assert.throws(() => validateZipArchive(mismatch), /local path/);
  const bomb = Buffer.from(good);
  let offset = central;
  while (offset >= 0) {
    const length = bomb.readUInt16LE(offset + 28);
    if (bomb.subarray(offset + 46, offset + 46 + length).toString().endsWith('compressible.txt')) break;
    offset = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 4);
  }
  assert.ok(offset >= 0);
  bomb.writeUInt32LE(1, offset + 24);
  assert.throws(() => validateZipArchive(bomb));
});
test('explicit disabled-core verification mode never reads private config or starts installed Mihomo', async t => {
  const old = process.env.IMAGE_RELAY_MIHOMO_DISABLED;
  t.after(() => { if (old === undefined) delete process.env.IMAGE_RELAY_MIHOMO_DISABLED; else process.env.IMAGE_RELAY_MIHOMO_DISABLED = old; });
  process.env.IMAGE_RELAY_MIHOMO_DISABLED = 'true';
  assert.equal(await startBuiltInImageProxy({ projectRoot: '/does-not-exist', privateConfigFile: '/does-not-exist/private.yaml' }), null);
});
