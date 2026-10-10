import { lstat, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { scanContent, MAX_SCAN_BYTES } from './secret-scan.mjs';

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export function validateZipArchive(buffer, { trustedRuntime } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ARCHIVE_BYTES) throw new Error('Release archive exceeds size limit');
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('ZIP end record missing');
  const entries = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== entries || !entries || entries > 20000 || start + size !== end) throw new Error('Unsupported ZIP layout');
  let cursor = start, total = 0;
  const roots = new Set(), names = new Set();
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const packedBytes = buffer.readUInt32LE(cursor + 20), bytes = buffer.readUInt32LE(cursor + 24), length = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32);
    const attrs = buffer.readUInt32LE(cursor + 38), local = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + length + extra + comment > end || local >= start || (flags & 1) || ![0, 8].includes(method) || buffer.readUInt16LE(cursor + 34)) throw new Error('Unsupported ZIP entry');
    const name = buffer.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    const segments = name.replace(/\/$/, '').split('/');
    if (!name || /[\\:\x00-\x1f\x7f\ufffd]/.test(name) || segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Unsafe ZIP path');
    const canonical = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
    if (names.has(canonical)) throw new Error('Duplicate ZIP path');
    names.add(canonical); roots.add(segments[0]);
    const type = (attrs >>> 16) & 0o170000;
    if (type && ![0o100000, 0o040000].includes(type)) throw new Error('ZIP links and special files forbidden');
    const runtime = segments.length === 3 && segments.slice(1).join('/') === 'runtime/node' && trustedRuntime;
    if ((name.endsWith('/') && bytes !== 0) || bytes > (runtime ? Math.min(trustedRuntime.runtimeSize, 160 * 1024 * 1024) : MAX_SCAN_BYTES)) throw new Error('ZIP entry exceeds scan limit');
    if (local + 30 > start || buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method) throw new Error('ZIP local header mismatch');
    const localNameLength = buffer.readUInt16LE(local + 26), localExtraLength = buffer.readUInt16LE(local + 28);
    const bodyStart = local + 30 + localNameLength + localExtraLength;
    if (bodyStart + packedBytes > start || !buffer.subarray(local + 30, local + 30 + localNameLength).equals(buffer.subarray(cursor + 46, cursor + 46 + length))) throw new Error('ZIP local path/body mismatch');
    for (const [offset, extraLength] of [[cursor + 46 + length, extra], [local + 30 + localNameLength, localExtraLength]]) {
      let position = offset;
      while (position < offset + extraLength) {
        if (position + 4 > offset + extraLength) throw new Error('Invalid ZIP extra field');
        const type = buffer.readUInt16LE(position), fieldLength = buffer.readUInt16LE(position + 2);
        if (position + 4 + fieldLength > offset + extraLength || ![0x5455, 0x7875, 0x5855, 0x7075].includes(type)) throw new Error('Unsupported ZIP extra field');
        if (type === 0x7075 && (fieldLength < 5 || buffer.subarray(position + 9, position + 4 + fieldLength).toString('utf8') !== name)) throw new Error('ZIP alternate Unicode path forbidden');
        position += 4 + fieldLength;
      }
    }
    const packed = buffer.subarray(bodyStart, bodyStart + packedBytes);
    const decoded = method === 8 ? inflateRawSync(packed, { maxOutputLength: Math.max(1, bytes) }) : packed;
    if (decoded.length !== bytes) throw new Error('ZIP expansion size mismatch');
    if (runtime && (bytes !== trustedRuntime.runtimeSize || createHash('sha256').update(decoded).digest('hex') !== trustedRuntime.runtimeSha256)) throw Error('Trusted runtime mismatch');
    total += bytes;
    if (total > 512 * 1024 * 1024) throw new Error('ZIP expansion exceeds size limit');
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end || roots.size !== 1) throw new Error('ZIP must contain exactly one release root');
  return { root: [...roots][0], entries, bytes: total };
}

export async function verifyReleaseFiles(root, { trustedRuntime } = {}) {
  const actual = new Map();
  async function inventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), name = path.relative(root, file).split(path.sep).join('/');
      const info = await lstat(file);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('Release links and special files forbidden');
      if (info.isDirectory()) { await inventory(file); continue; }
      const runtime = name === 'runtime/node' && trustedRuntime;
      if (info.size > (runtime ? Math.min(trustedRuntime.runtimeSize, 160 * 1024 * 1024) : MAX_SCAN_BYTES)) throw new Error('Release file exceeds scan limit');
      const content = await readFile(file);
      if (runtime) {
        if (content.length !== trustedRuntime.runtimeSize || createHash('sha256').update(content).digest('hex') !== trustedRuntime.runtimeSha256) throw Error('Trusted runtime mismatch');
      } else if (scanContent(name, content).length) throw new Error('Sensitive or private release content detected');
      actual.set(name, { hash: createHash('sha256').update(content).digest('hex'), content });
    }
  }
  await inventory(root);
  const manifest = JSON.parse(actual.get('RELEASE.json')?.content.toString() || 'null');
  if (manifest?.app !== 'guan-ai-workbench' || manifest.edition === 'personal-private' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version || '') || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('Invalid release manifest');
  const expected = Object.entries(manifest.files);
  if (!expected.length || expected.length !== actual.size - 1 || Object.hasOwn(manifest.files, 'RELEASE.json')) throw new Error('Release inventory must match every file exactly');
  for (const [name, hash] of expected) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !actual.has(name) || actual.get(name).hash !== hash) throw new Error('Release file verification failed');
  }
  const packageInfo = JSON.parse(actual.get('package.json')?.content.toString() || 'null');
  if (packageInfo?.name !== 'guan-ai-workbench' || packageInfo.version !== manifest.version || manifest.entry !== 'server.mjs') throw new Error('Release version/entry mismatch');
  for (const required of ['server.mjs', 'src/server/index.mjs', 'public/index.html', 'public/infinite-canvas/index.html']) if (!actual.has(required)) throw new Error('Release runtime file missing');
  const html = actual.get('public/infinite-canvas/index.html').content.toString();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
  if (!assets.some(asset => asset.endsWith('.js'))) throw new Error('Release canvas build missing');
  for (const asset of assets) if (!actual.has('public/infinite-canvas' + asset)) throw new Error('Release canvas asset missing');
  if (manifest.canvasBuild != null) {
    const prefix = 'public/infinite-canvas/';
    const build = JSON.parse(actual.get(prefix + 'CANVAS-BUILD.json')?.content.toString() || 'null');
    if (build?.app !== 'guan-ai-workbench' || build.format !== 1 || build.version !== manifest.version
      || build.version !== manifest.canvasBuild.version || !/^[a-f0-9]{64}$/.test(build.sourceHash || '')
      || build.sourceHash !== manifest.canvasBuild.sourceHash || !build.files || typeof build.files !== 'object' || Array.isArray(build.files)) throw new Error('Release canvas identity mismatch');
    const members = [...actual.keys()].filter(name => name.startsWith(prefix) && name !== prefix + 'CANVAS-BUILD.json');
    if (members.length !== Object.keys(build.files).length) throw new Error('Release canvas inventory mismatch');
    for (const name of members) if (build.files[name.slice(prefix.length)] !== actual.get(name).hash) throw new Error('Release canvas integrity mismatch');
    if (!actual.has(prefix + 'excel-prompts-bridge.js')) throw new Error('Release canvas bridge missing');
  }
  if (manifest.nativeHelper != null) {
    const native = JSON.parse(actual.get('bin/KEYCHAIN-BUILD.json')?.content.toString() || 'null');
    const binary = actual.get('bin/guan-keychain'), source = actual.get('src/native/keychain-helper.swift');
    if (!native || native.app !== 'guan-ai-workbench' || native.platform !== 'darwin' || native.unsigned !== true
      || !['arm64', 'x64'].includes(native.arch) || JSON.stringify(native) !== JSON.stringify(manifest.nativeHelper)
      || binary?.hash !== native.binarySha256 || source?.hash !== native.sourceSha256
      || !actual.has('scripts/install-keychain-helper.mjs') || !actual.has('scripts/lib/native-keychain-build.mjs')) throw new Error('Native helper release identity mismatch');
    const cpu = binary.content.length > 8 && binary.content.readUInt32LE(0) === 0xfeedfacf ? binary.content.readUInt32LE(4) : 0;
    if ((native.arch === 'arm64' ? 0x0100000c : 0x01000007) !== cpu) throw new Error('Native helper architecture mismatch');
  }
  return { manifest, assets, files: actual.size - 1, buildId: createHash('sha256').update(actual.get('src/server/index.mjs').content).update(actual.get('public/infinite-canvas/index.html').content).digest('hex').slice(0, 24) };
}
