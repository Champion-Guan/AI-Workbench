import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { keyId, sha256 } from '../../src/server/stable-manifest.mjs';

export function testSigningIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }), id = keyId(pem);
  return { privateKey, id, keys: { [id]: pem } };
}
// Valid ZIP, signature, Mach-O headers and nested file inventories. Payload is
// synthetic and is never executed. Real runtime testing is a separate smoke test.
export async function signedUpdateFixture(parent, signing, version, executable = null) {
  const directory = path.join(parent, 'input-' + version), name = `guan-ai-workbench-v${version}-macos-arm64`, root = path.join(directory, name);
  const binary = Buffer.alloc(32); binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(0x0100000c, 4);
  const source = '// synthetic helper', commit = sha256(version).slice(0, 40);
  const native = { app: 'guan-ai-workbench', platform: 'darwin', unsigned: true, arch: 'arm64', binarySha256: sha256(binary), sourceSha256: sha256(source) };
  const runtime = executable?.runtime || binary;
  const files = { 'package.json': JSON.stringify({ name: 'guan-ai-workbench', version }), 'server.mjs': executable?.backend || '// not executed',
    'src/server/index.mjs': '// version ' + version, 'public/index.html': '<title>fixture</title>',
    'public/infinite-canvas/index.html': '<script src="/assets/fixture.js"></script>', 'public/infinite-canvas/assets/fixture.js': '// fixture',
    'public/infinite-canvas/excel-prompts-bridge.js': '// bridge', 'runtime/node': runtime,
    'bin/guan-keychain': binary, 'src/native/keychain-helper.swift': source, 'scripts/start-stable.command': '#!/bin/sh\nexit 99\n',
    'scripts/install-keychain-helper.mjs': '// installer', 'scripts/lib/native-keychain-build.mjs': '// verifier', 'bin/KEYCHAIN-BUILD.json': JSON.stringify(native) };
  if (executable) {
    Object.assign(files, executable.files || {});
    files['update-startup.mjs'] = executable.startup;
    files['fixture.json'] = JSON.stringify({ version, mode: executable.mode || 'normal',
      buildId: sha256(Buffer.concat([Buffer.from(files['src/server/index.mjs']), Buffer.from(files['public/infinite-canvas/index.html'])])).slice(0, 24) });
  }
  const prefix = 'public/infinite-canvas/', canvas = { app: 'guan-ai-workbench', format: 1, version, sourceHash: sha256(version),
    files: Object.fromEntries(Object.entries(files).filter(([n]) => n.startsWith(prefix)).map(([n, b]) => [n.slice(prefix.length), sha256(b)])) };
  files[prefix + 'CANVAS-BUILD.json'] = JSON.stringify(canvas);
  const release = { app: 'guan-ai-workbench', edition: 'stable', channel: 'stable', version, entry: 'server.mjs', commit, platform: 'darwin', arch: 'arm64',
    startupProtocol: executable ? 1 : undefined,
    automaticInstallAllowed: false, runtime: 'v24.16.0', nativeHelper: native, canvasBuild: { version, sourceHash: canvas.sourceHash },
    bundledRuntime: { runtimeSha256: sha256(runtime), runtimeSize: runtime.length }, files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha256(b)])) };
  files['RELEASE.json'] = JSON.stringify(release);
  for (const [n, b] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, n)), { recursive: true }); await writeFile(path.join(root, n), b); }
  execFileSync('zip', ['-qr', path.join(directory, name + '.zip'), name], { cwd: directory, stdio: 'pipe' });
  const archive = await readFile(path.join(directory, name + '.zip'));
  await writeFile(path.join(directory, 'package.zip'), archive);
  const descriptor = { platform: 'darwin', arch: 'arm64', name: name + '.zip', sha256: sha256(archive), size: archive.length,
    nodeVersion: 'v24.16.0', runtimeSha256: sha256(runtime), runtimeSize: runtime.length };
  const manifest = { format: 1, app: 'guan-ai-workbench', channel: 'stable', version, repository: executable?.repository || 'owner/repo', commit,
    builtAt: '2026-10-11T00:00:00.000Z', keyId: signing.id, packages: [descriptor] };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(directory, 'guan-stable-manifest.json'), bytes);
  await writeFile(path.join(directory, 'guan-stable-manifest.sig'), sign(null, bytes, signing.privateKey));
  return { directory, version, descriptor };
}
