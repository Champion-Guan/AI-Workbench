import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { keyId, sha256 } from '../src/server/stable-manifest.mjs';
import { verifySignedStable } from '../scripts/lib/signed-stable.mjs';
import { validateZipArchive, verifyReleaseFiles } from '../scripts/lib/release-validation.mjs';

async function fixture(t, { big = false, edition = 'stable', commit = 'a'.repeat(40) } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'guan-signed-package-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), pem = publicKey.export({ type: 'spki', format: 'pem' }), id = keyId(pem), packages = [];
  for (const arch of ['arm64', 'x64']) {
    const name = `guan-ai-workbench-v1.2.3-macos-${arch}`, root = path.join(directory, name);
    const binary = Buffer.alloc(big ? 33 * 1024 * 1024 : 32); binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    const source = '// synthetic helper, not executable', native = { app: 'guan-ai-workbench', platform: 'darwin', unsigned: true, arch, binarySha256: sha256(binary), sourceSha256: sha256(source) };
    // Keep helper small; the sole large-file exemption is runtime/node.
    const helper = Buffer.from(binary.subarray(0, 32)); native.binarySha256 = sha256(helper);
    const files = { 'package.json': JSON.stringify({ name: 'guan-ai-workbench', version: '1.2.3' }), 'server.mjs': '// not executed', 'src/server/index.mjs': '// not executed',
      'public/index.html': '<title>fixture</title>', 'public/infinite-canvas/index.html': '<script src="/assets/fixture.js"></script>',
      'public/infinite-canvas/assets/fixture.js': '// synthetic UI', 'public/infinite-canvas/excel-prompts-bridge.js': '// bridge',
      'runtime/node': binary, 'scripts/start-stable.command': '#!/bin/sh\nexit 99\n', 'bin/guan-keychain': helper, 'src/native/keychain-helper.swift': source,
      'scripts/install-keychain-helper.mjs': '// installer', 'scripts/lib/native-keychain-build.mjs': '// verifier', 'bin/KEYCHAIN-BUILD.json': JSON.stringify(native) };
    const prefix = 'public/infinite-canvas/';
    const canvas = { app: 'guan-ai-workbench', format: 1, version: '1.2.3', sourceHash: 'b'.repeat(64), files: Object.fromEntries(Object.entries(files).filter(([n]) => n.startsWith(prefix)).map(([n, bytes]) => [n.slice(prefix.length), sha256(bytes)])) };
    files[prefix + 'CANVAS-BUILD.json'] = JSON.stringify(canvas);
    const manifest = { app: 'guan-ai-workbench', edition, channel: 'stable', version: '1.2.3', entry: 'server.mjs', commit, platform: 'darwin', arch,
      automaticInstallAllowed: false, runtime: 'v24.16.0', nativeHelper: native, canvasBuild: { version: '1.2.3', sourceHash: canvas.sourceHash },
      bundledRuntime: { runtimeSha256: sha256(binary), runtimeSize: binary.length }, files: Object.fromEntries(Object.entries(files).map(([n, bytes]) => [n, sha256(bytes)])) };
    files['RELEASE.json'] = JSON.stringify(manifest);
    for (const [n, bytes] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, n)), { recursive: true }); await writeFile(path.join(root, n), bytes); }
    const archive = path.join(directory, name + '.zip'); execFileSync('zip', ['-qr', archive, name], { cwd: directory });
    const bytes = await readFile(archive);
    packages.push({ platform: 'darwin', arch, name: name + '.zip', sha256: sha256(bytes), size: bytes.length, nodeVersion: 'v24.16.0', runtimeSha256: sha256(binary), runtimeSize: binary.length });
  }
  const manifest = { format: 1, app: 'guan-ai-workbench', channel: 'stable', version: '1.2.3', repository: 'owner/repo', commit: 'a'.repeat(40), builtAt: '2026-10-10T00:00:00.000Z', keyId: id, packages };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(directory, 'guan-stable-manifest.json'), bytes); await writeFile(path.join(directory, 'guan-stable-manifest.sig'), sign(null, bytes, privateKey));
  return { directory, manifest, options: { directory, repository: 'owner/repo', version: '1.2.3', arch: 'arm64', trustedKeys: { [id]: pem } } };
}
test('signed dual architecture package validates exact nested inventory without executing payload', async t => {
  const f = await fixture(t);
  for (const arch of ['arm64', 'x64']) { const r = await verifySignedStable({ ...f.options, arch }); assert.equal(r.signatureVerified, true); assert.equal(r.executed, false); }
});
test('signed package rejects mismatched commit and portable edition despite valid signature/hash', async t => {
  for (const config of [{ commit: 'c'.repeat(40) }, { edition: 'portable-unsigned' }]) {
    const f = await fixture(t, config); await assert.rejects(verifySignedStable(f.options), /identity mismatch/);
  }
});
test('large runtime exemption is narrowly bound to signed exact size/hash; unsigned/forged metadata fails', async t => {
  const f = await fixture(t, { big: true }), descriptor = f.manifest.packages[0], bytes = await readFile(path.join(f.directory, descriptor.name));
  assert.throws(() => validateZipArchive(bytes), /scan limit/);
  assert.throws(() => validateZipArchive(bytes, { trustedRuntime: { ...descriptor, runtimeSha256: '0'.repeat(64) } }), /runtime mismatch/);
  await assert.rejects(verifyReleaseFiles(path.join(f.directory, descriptor.name.slice(0, -4))), /scan limit/);
  assert.equal((await verifySignedStable(f.options)).signatureVerified, true);
  await assert.rejects(verifySignedStable({ ...f.options, trustedKeys: {} }), /untrusted/);
});
test('changed archive and a symlinked input are refused before extraction', async t => {
  const f = await fixture(t), file = path.join(f.directory, f.manifest.packages[0].name);
  const bytes = await readFile(file); bytes[100] ^= 1; await writeFile(file, bytes);
  await assert.rejects(verifySignedStable(f.options), /integrity/);
  await rm(file); await symlink(f.manifest.packages[1].name, file);
  await assert.rejects(verifySignedStable(f.options), /Unsafe/);
});
