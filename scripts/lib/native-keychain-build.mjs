import { lstat, readFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { privateDirectory, writePrivateFile } from '../../src/server/runtime-paths.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function verifyNativeKeychainBuild(projectRoot, directory) {
  const binaryFile = path.join(directory, 'guan-keychain'), manifestFile = path.join(directory, 'KEYCHAIN-BUILD.json');
  for (const file of [binaryFile, manifestFile]) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw Error('Unsafe native helper input'); }
  const binary = await readFile(binaryFile), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const arch = binary.length > 8 && binary.readUInt32LE(0) === 0xfeedfacf ? ({ 0x0100000c: 'arm64', 0x01000007: 'x64' })[binary.readUInt32LE(4)] : null;
  if (!arch || manifest.app !== 'guan-ai-workbench' || manifest.platform !== 'darwin' || manifest.unsigned !== true
    || manifest.arch !== arch || manifest.binarySha256 !== hash(binary)
    || manifest.sourceSha256 !== hash(await readFile(path.join(projectRoot, 'src/native/keychain-helper.swift')))) throw Error('Native helper identity/integrity mismatch');
  return { manifest, binary };
}
// Install a local developer-built helper once. Never replace an installed
// helper; future upgrades need the separately verified updater/Keychain flow.
export async function installNativeKeychainBuild(projectRoot, directory, paths) {
  const { manifest, binary } = await verifyNativeKeychainBuild(projectRoot, directory);
  if (manifest.arch !== process.arch || process.platform !== 'darwin') throw Error('Native helper architecture mismatch');
  await privateDirectory(paths.root); await privateDirectory(paths.data); await privateDirectory(paths.runtime);
  const destination = path.join(paths.runtime, 'guan-keychain');
  const installed = await writePrivateFile(destination, binary, { exclusive: true });
  const info = await lstat(destination);
  if (!info.isFile() || info.isSymbolicLink() || !binary.equals(await readFile(destination))) throw Error('Existing native helper retained; unsafe replacement refused');
  await chmod(destination, 0o700);
  const manifestDestination = path.join(paths.runtime, 'KEYCHAIN-BUILD.json');
  const text = JSON.stringify(manifest, null, 2) + '\n';
  if (!await writePrivateFile(manifestDestination, text, { exclusive: true }) && await readFile(manifestDestination, 'utf8') !== text) throw Error('Existing native helper manifest retained');
  return { ok: true, installed, arch: manifest.arch, keychainAccessed: false, existingCredentialsChanged: false };
}
