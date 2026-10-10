import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyNativeKeychainBuild, installNativeKeychainBuild } from '../scripts/lib/native-keychain-build.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'guan-native-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'bin'); await mkdir(directory); await mkdir(path.join(root, 'src/native'), { recursive: true });
  const source = '// synthetic fixture'; await writeFile(path.join(root, 'src/native/keychain-helper.swift'), source);
  const binary = Buffer.alloc(32); binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  const manifest = { app: 'guan-ai-workbench', platform: 'darwin', unsigned: true, arch: process.arch, binarySha256: hash(binary), sourceSha256: hash(source) };
  await writeFile(path.join(directory, 'guan-keychain'), binary); await writeFile(path.join(directory, 'KEYCHAIN-BUILD.json'), JSON.stringify(manifest));
  const privateRoot = path.join(root, 'private'), data = path.join(privateRoot, 'data'), runtime = path.join(data, 'runtime');
  return { root, directory, binary, manifest, paths: { root: privateRoot, data, runtime } };
}
test('native build rejects changed source, binary and symlink inputs', async t => {
  const f = await fixture(t); await verifyNativeKeychainBuild(f.root, f.directory);
  await writeFile(path.join(f.root, 'src/native/keychain-helper.swift'), '// changed');
  await assert.rejects(verifyNativeKeychainBuild(f.root, f.directory), /integrity mismatch/);
  await rm(path.join(f.directory, 'guan-keychain')); await symlink('../src/native/keychain-helper.swift', path.join(f.directory, 'guan-keychain'));
  await assert.rejects(verifyNativeKeychainBuild(f.root, f.directory), /Unsafe/);
});
test('native install is copy-once, private and never replaces a mismatched helper', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  assert.equal((await installNativeKeychainBuild(f.root, f.directory, f.paths)).installed, true);
  assert.equal((await installNativeKeychainBuild(f.root, f.directory, f.paths)).installed, false);
  const destination = path.join(f.paths.runtime, 'guan-keychain');
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.paths.runtime, 'KEYCHAIN-BUILD.json'))).mode & 0o777, 0o600);
  await writeFile(destination, 'retained-old-helper');
  await assert.rejects(installNativeKeychainBuild(f.root, f.directory, f.paths), /replacement refused/);
  assert.equal(await readFile(destination, 'utf8'), 'retained-old-helper');
});
