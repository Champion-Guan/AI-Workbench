import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { keyId, sha256, verifyStableManifest, verifyStableArchive } from '../src/server/stable-manifest.mjs';
import { StableDownload } from '../src/server/stable-download.mjs';
import { readReleaseAsset } from '../src/server/github-assets.mjs';
import { SoftwareUpdates } from '../src/server/software-updates.mjs';

const token = ['synthetic', 'download', 'credential'].join('_');
function signed() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }), id = keyId(pem);
  const archive = Buffer.from('synthetic archive bytes, never executed');
  const manifest = { format: 1, app: 'guan-ai-workbench', channel: 'stable', version: '1.1.0', repository: 'owner/repo',
    commit: 'a'.repeat(40), builtAt: '2026-10-10T00:00:00.000Z', keyId: id,
    packages: ['arm64', 'x64'].map(arch => ({ platform: 'darwin', arch, name: `guan-ai-workbench-v1.1.0-macos-${arch}.zip`,
      sha256: sha256(archive), size: archive.length, nodeVersion: 'v24.16.0', runtimeSha256: 'b'.repeat(64), runtimeSize: 100 })) };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const signature = sign(null, bytes, privateKey), keys = { [id]: pem };
  const assets = [{ name: 'guan-stable-manifest.json', id: 1, size: bytes.length }, { name: 'guan-stable-manifest.sig', id: 2, size: 64 },
    ...manifest.packages.map((p, i) => ({ name: p.name, id: i + 3, size: archive.length }))];
  return { bytes, signature, keys, manifest, archive, privateKey, release: { version: '1.1.0', assets },
    options: { trustedKeys: keys, repository: 'owner/repo', releaseVersion: '1.1.0', currentVersion: '1.0.3', arch: 'arm64', platform: 'darwin' } };
}
async function fixture(t, changes = {}) {
  const f = signed(), directory = await mkdtemp(path.join(tmpdir(), 'guan-stable-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let reads = 0;
  const downloader = new StableDownload({ directory, trustedKeys: f.keys, arch: 'arm64', platform: 'darwin', freeSpace: async () => 1e9,
    readAsset: async ({ asset, onChunk, signal }) => {
      reads++; signal.throwIfAborted();
      const bytes = asset.id === 1 ? f.bytes : asset.id === 2 ? f.signature : f.archive;
      if (!onChunk) return bytes;
      await onChunk(bytes.subarray(0, 5)); await onChunk(bytes.subarray(5)); return bytes.length;
    }, ...changes });
  const options = { repository: 'owner/repo', token, release: f.release, currentVersion: '1.0.3' };
  return { ...f, directory, downloader, options, reads: () => reads };
}
test('manifest verifies pinned Ed25519 before trusting package metadata, binds repository/version/architecture', () => {
  const f = signed(); const v = verifyStableManifest(f.bytes, f.signature, f.options);
  assert.equal(v.selected.arch, 'arm64'); assert.equal(verifyStableArchive(f.archive, v.selected), true);
  for (const opts of [{ trustedKeys: {} }, { repository: 'other/repo' }, { releaseVersion: '1.2.0' }, { currentVersion: '1.1.0' }, { arch: 'ia32' }])
    assert.throws(() => verifyStableManifest(f.bytes, f.signature, { ...f.options, ...opts }));
  assert.throws(() => verifyStableArchive(Buffer.from('corrupt'), v.selected));
});
test('corrupted signature, forged key, duplicate JSON fields and noncanonical manifest fail closed', () => {
  const f = signed();
  assert.throws(() => verifyStableManifest(f.bytes, Buffer.alloc(64), f.options), /signature_invalid/);
  assert.throws(() => verifyStableManifest(Buffer.from(f.bytes.toString().replace('1.1.0', '1.2.0')), f.signature, f.options));
  const duplicate = Buffer.from(f.bytes.toString().replace('"format": 1,', '"format": 1, "format": 1,'));
  assert.throws(() => verifyStableManifest(duplicate, sign(null, duplicate, f.privateKey), f.options), /stable_manifest_invalid/);
  const bad = Buffer.from(JSON.stringify({ ...f.manifest, packages: [] }, null, 2) + '\n');
  assert.throws(() => verifyStableManifest(bad, sign(null, bad, f.privateKey), f.options), /stable_manifest_invalid/);
});
test('verified download is private, size/hash checked, coalesced and never executes or exposes a path/token', async t => {
  const f = await fixture(t), a = f.downloader.download(f.options), b = f.downloader.download(f.options);
  assert.equal(a, b); await a;
  const s = f.downloader.status('owner/repo'); assert.equal(s.state, 'verified'); assert.equal(s.progress, 100); assert.equal(f.reads(), 3);
  assert.ok(!JSON.stringify(s).includes(f.directory)); assert.ok(!JSON.stringify(s).includes(token));
  assert.deepEqual(await readFile(path.join(f.downloader.verified.directory, 'package.zip')), f.archive);
  assert.equal((await stat(f.downloader.verified.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.downloader.verified.directory, 'package.zip'))).mode & 0o777, 0o600);
  assert.equal(f.downloader.status('other/repo').state, 'idle');
});
test('empty trust rejects before network; bad signature rejects before package or private staging', async t => {
  const f = await fixture(t, { trustedKeys: {} }); await f.downloader.download(f.options);
  assert.equal(f.reads(), 0); assert.equal(f.downloader.status('owner/repo').error, 'signing_trust_not_configured');
  const g = await fixture(t); g.signature.fill(0); await g.downloader.download(g.options);
  assert.equal(g.reads(), 2); assert.equal(g.downloader.status('owner/repo').error, 'signature_invalid');
  assert.deepEqual(await readdir(g.directory), []);
});
test('insufficient or unknown disk capacity refuses package without touching business files', async t => {
  for (const capacity of [1, NaN]) {
    const f = await fixture(t, { freeSpace: async () => capacity }); await f.downloader.download(f.options);
    assert.equal(f.reads(), 2); assert.equal(f.downloader.status('owner/repo').error, 'disk_space_insufficient');
    assert.deepEqual(await readdir(f.directory), []);
  }
});
test('truncation and corrupt content never mark downloaded package verified', async t => {
  for (const corrupt of [Buffer.from('wrong'), Buffer.alloc(38)]) {
    const f = await fixture(t); const base = f.downloader.readAsset;
    f.downloader.readAsset = async opts => opts.onChunk ? (await opts.onChunk(corrupt), corrupt.length) : base(opts);
    await f.downloader.download(f.options);
    assert.equal(f.downloader.status('owner/repo').state, 'error'); assert.equal(f.downloader.verified, null);
    for (const dir of await readdir(f.directory)) assert.ok(!(await readdir(path.join(f.directory, dir))).includes('package.part'));
  }
});
test('cancel interrupts download, removes only this partial file and does not grant installation', async t => {
  const f = await fixture(t); const base = f.downloader.readAsset; let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.downloader.readAsset = async opts => {
    if (!opts.onChunk) return base(opts);
    await opts.onChunk(f.archive.subarray(0, 5)); started();
    await new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Error('cancel')), { once: true }));
  };
  const operation = f.downloader.download(f.options); await ready; f.downloader.cancel(); await operation;
  assert.equal(f.downloader.status('owner/repo').state, 'error'); assert.equal(f.downloader.verified, null);
});
test('GitHub asset redirects strip authorization; bounded CDN response only uses pinned https hosts', async () => {
  const requests = [];
  const bytes = await readReleaseAsset({ repository: 'owner/repo', asset: { id: 12 }, token, maxBytes: 10, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/private?signature=test' } }) : new Response('package');
  } });
  assert.equal(bytes.toString(), 'package'); assert.equal(requests[0].options.headers.authorization, 'Bearer ' + token);
  assert.equal(requests[1].options.headers.authorization, undefined);
  for (const location of ['http://release-assets.githubusercontent.com/x', 'https://evil.example/x', 'https://api.github.com/x', 'https://objects.githubusercontent.com/x#fragment'])
    await assert.rejects(readReleaseAsset({ repository: 'owner/repo', asset: { id: 12 }, token, maxBytes: 10, fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }), /asset_redirect_rejected/);
});
test('asset body overflow, upstream exception and authorization expiry yield fixed nonsecret errors', async () => {
  for (const response of [() => new Response('x'.repeat(11)), () => new Response(token, { status: 401 }), () => { throw Error(token); }])
    await assert.rejects(readReleaseAsset({ repository: 'owner/repo', asset: { id: 12 }, token, maxBytes: 10, fetchImpl: async () => response() }), e => !e.message.includes(token));
});
test('SoftwareUpdates triggers background trusted download, hides asset IDs, and cancels on repository switch', async t => {
  const f = await fixture(t);
  const updates = new SoftwareUpdates({ directory: f.directory, currentVersion: '1.0.3', downloader: f.downloader,
    auth: { metadata: async () => ({ repository: 'owner/repo' }), token: async () => token },
    readRelease: async () => ({ ...f.release, publishedAt: '2026-10-10T00:00:00.000Z', notes: 'notes', verification: 'not-verified' }) });
  await updates.configure({ repository: 'owner/repo' }); await updates.check();
  while (!f.downloader.pending && !['verified', 'error'].includes(f.downloader.state.state)) await new Promise(resolve => setImmediate(resolve));
  await f.downloader.pending;
  const status = await updates.status(); assert.equal(status.download.state, 'verified'); assert.equal(status.latest.verification, 'verified'); assert.equal(status.latest.assets, undefined); assert.equal(status.install.allowed, false);
  await updates.configure({ repository: 'other/repo' }); assert.equal((await updates.status()).download.state, 'idle');
});
test('late check completion cannot start a new download after update service shutdown', async t => {
  const f = await fixture(t); let unblock;
  const updates = new SoftwareUpdates({ directory: f.directory, currentVersion: '1.0.3', downloader: f.downloader,
    auth: { metadata: async () => ({ repository: 'owner/repo' }), token: async () => token },
    readRelease: async () => { await new Promise(resolve => { unblock = resolve; }); return f.release; } });
  await updates.configure({ repository: 'owner/repo' }); const check = updates.check();
  while (!unblock) await new Promise(resolve => setImmediate(resolve));
  updates.stop(); unblock(); await check; await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reads(), 0); assert.equal(f.downloader.pending, null);
  await assert.rejects(updates.download(), /update_service_stopped/);
});
