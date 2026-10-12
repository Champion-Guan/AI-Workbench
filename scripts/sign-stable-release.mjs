import { readFile, lstat } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { keyId, validateStableManifest } from '../src/server/stable-manifest.mjs';
import { STABLE_TRUSTED_KEYS } from '../src/server/stable-trust.mjs';
import { validRepository } from '../src/server/stable-version.mjs';
import { writePrivateFile } from '../src/server/runtime-paths.mjs';
import { verifySignedStable } from './lib/signed-stable.mjs';
import { verifyStableOwnerEnvironment } from './lib/stable-owner-approval.mjs';

async function main() {
  const approval = await verifyStableOwnerEnvironment();
  const [repository, directory] = process.argv.slice(2);
  if (process.argv.length !== 4 || !validRepository(repository) || repository !== approval.repository
    || process.env.GUAN_RELEASE_COMMIT !== approval.commit || !path.isAbsolute(directory)) throw Error('Invalid signing inputs');
  const raw = process.env.GUAN_STABLE_SIGNING_KEY;
  delete process.env.GUAN_STABLE_SIGNING_KEY;
  if (!raw || raw.length > 4096) throw Error('Signing secret required');
  return signStableRelease({ approval, directory, root: fileURLToPath(new URL('../', import.meta.url)), privateKey: createPrivateKey(raw) });
}

// Shared by independently authenticated CI and local operator entry points.
// Never exposes the key or grants permission to install.
export async function signStableRelease({ approval, directory, root, privateKey }) {
  const { repository, commit } = approval;
  if (!validRepository(repository) || !/^[a-f0-9]{40}$/.test(commit) || !path.isAbsolute(directory)) throw Error('Invalid signing inputs');
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  if (approval.tag !== 'v' + version) throw Error('Approved tag/version mismatch');
  const records = [];
  for (const arch of ['arm64']) {
    const file = path.join(directory, 'package-' + arch + '.json'), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('Invalid artifact metadata');
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (record.version !== version || record.descriptor?.arch !== arch || record.commit !== commit) throw Error('Artifact commit/version mismatch');
    records.push(record);
  }
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 required');
  const id = keyId(publicKey);
  if (!Object.hasOwn(STABLE_TRUSTED_KEYS, id) || keyId(STABLE_TRUSTED_KEYS[id]) !== id) throw Error('Signing key is not pinned');
  const manifest = validateStableManifest({ format: 1, app: 'guan-ai-workbench', channel: 'stable', version, repository,
    commit: records[0].commit, builtAt: new Date().toISOString(), keyId: id, packages: records.map(r => r.descriptor) });
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), signature = sign(null, bytes, privateKey);
  for (const [name, content] of [['guan-stable-manifest.json', bytes], ['guan-stable-manifest.sig', signature]]) {
    if (!await writePrivateFile(path.join(directory, name), content, { exclusive: true })) throw Error('Existing signature retained');
  }
  await verifySignedStable({ directory, repository, version, arch: 'arm64' });
  if (!await writePrivateFile(path.join(directory, 'SHA256SUMS.txt'), manifest.packages.map(p => `${p.sha256}  ${p.name}\n`).join(''), { exclusive: true })) throw Error('Existing checksum file retained');
  console.log(JSON.stringify({ ok: true, version, packages: 1, keyId: id, privateKeyExported: false }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error('Stable signing failed safely; nothing was published. Verify owner approval, signing secret, pinned public key and artifact identity.'); process.exitCode = 1; });
