import { createPublicKey, createHash, verify } from 'node:crypto';
import { parseVersion, compareVersions, validRepository } from './stable-version.mjs';
import { UpdateError } from './update-auth.mjs';
import { STABLE_TRUSTED_KEYS } from './stable-trust.mjs';

export const MAX_STABLE_PACKAGE_BYTES = 256 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
export function keyId(publicKey) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new UpdateError('signing_key_invalid');
  return sha256(key.export({ type: 'spki', format: 'der' }));
}
export function validateStableManifest(m) {
  const version = parseVersion(m?.version);
  if (!exact(m, ['format', 'app', 'channel', 'version', 'repository', 'commit', 'builtAt', 'keyId', 'packages'])
    || m.format !== 1 || m.app !== 'guan-ai-workbench' || m.channel !== 'stable' || !version || version.pre.length || version.version !== m.version
    || !validRepository(m.repository) || !/^[a-f0-9]{40}$/.test(m.commit) || !/^[a-f0-9]{64}$/.test(m.keyId)
    || typeof m.builtAt !== 'string' || !Number.isFinite(Date.parse(m.builtAt)) || new Date(m.builtAt).toISOString() !== m.builtAt
    || !Array.isArray(m.packages) || m.packages.length !== 2) throw new UpdateError('stable_manifest_invalid');
  const architectures = new Set();
  for (const p of m.packages) {
    if (!exact(p, ['platform', 'arch', 'name', 'sha256', 'size', 'nodeVersion', 'runtimeSha256', 'runtimeSize'])
      || p.platform !== 'darwin' || !['arm64', 'x64'].includes(p.arch) || architectures.has(p.arch)
      || p.name !== `guan-ai-workbench-v${m.version}-macos-${p.arch}.zip` || !/^[a-f0-9]{64}$/.test(p.sha256)
      || !Number.isSafeInteger(p.size) || p.size < 1 || p.size > MAX_STABLE_PACKAGE_BYTES
      || !/^v24\.\d+\.\d+$/.test(p.nodeVersion) || !/^[a-f0-9]{64}$/.test(p.runtimeSha256)
      || !Number.isSafeInteger(p.runtimeSize) || p.runtimeSize < 1 || p.runtimeSize > 160 * 1024 * 1024) throw new UpdateError('stable_manifest_invalid');
    architectures.add(p.arch);
  }
  return m;
}
export function verifyStableManifest(bytes, signature, { trustedKeys = STABLE_TRUSTED_KEYS, repository, releaseVersion, currentVersion, arch = process.arch, platform = process.platform } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 65536 || !Buffer.isBuffer(signature) || signature.length !== 64) throw new UpdateError('signature_invalid');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new UpdateError('stable_manifest_invalid'); }
  // Check a pinned key before trusting any remote metadata or hashes.
  const pem = trustedKeys[manifest?.keyId];
  if (!pem || !Object.hasOwn(trustedKeys, manifest.keyId)) throw new UpdateError('signing_key_untrusted');
  try {
    if (keyId(pem) !== manifest.keyId || !verify(null, bytes, createPublicKey(pem), signature)) throw Error();
  } catch { throw new UpdateError('signature_invalid'); }
  validateStableManifest(manifest);
  // Exact canonical roundtrip rejects duplicate keys and alternate encodings.
  if (!Buffer.from(JSON.stringify(manifest, null, 2) + '\n').equals(bytes)) throw new UpdateError('stable_manifest_invalid');
  if (!validRepository(repository) || manifest.repository.toLowerCase() !== repository.toLowerCase()
    || manifest.version !== releaseVersion) throw new UpdateError('release_identity_mismatch');
  if (currentVersion && compareVersions(manifest.version, currentVersion) <= 0) throw new UpdateError('version_not_newer');
  const selected = manifest.packages.find(p => p.platform === platform && p.arch === arch);
  if (!selected) throw new UpdateError('architecture_unsupported');
  return { manifest, selected };
}
export function verifyStableArchive(bytes, descriptor) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== descriptor.size || bytes.length > MAX_STABLE_PACKAGE_BYTES || sha256(bytes) !== descriptor.sha256) throw new UpdateError('package_integrity_failed');
  return true;
}
