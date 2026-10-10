import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../src/server/stable-manifest.mjs';

export const NODE_VERSION = 'v24.16.0';
export function machArchitecture(bytes) {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) throw Error('Runtime is not a supported Mach-O executable');
  const arch = ({ 0x0100000c: 'arm64', 0x01000007: 'x64' })[bytes.readUInt32LE(4)];
  if (!arch) throw Error('Runtime architecture unsupported');
  return arch;
}
export async function verifyStableRuntime(directory, arch) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'NODE-RUNTIME.json'), 'utf8'));
  const file = path.join(directory, 'node'), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 160 * 1024 * 1024 || !(info.mode & 0o111)) throw Error('Unsafe stable runtime');
  const bytes = await readFile(file);
  if (metadata.source !== `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${arch}.tar.gz`
    || metadata.nodeVersion !== NODE_VERSION || metadata.arch !== arch || metadata.runtimeSize !== bytes.length
    || metadata.runtimeSha256 !== sha256(bytes) || !/^[a-f0-9]{64}$/.test(metadata.archiveSha256 || '')
    || machArchitecture(bytes) !== arch) throw Error('Stable runtime identity mismatch');
  return { ...metadata, bytes };
}
