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
  const root = fileURLToPath(new URL('../', import.meta.url)), version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  if (approval.tag !== 'v' + version) throw Error('Approved tag/version mismatch');
  const records = [];
  for (const arch of ['arm64', 'x64']) {
    const file = path.join(directory, 'package-' + arch + '.json'), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('Invalid artifact metadata');
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (record.version !== version || record.descriptor?.arch !== arch || record.commit !== process.env.GUAN_RELEASE_COMMIT) throw Error('Artifact commit/version mismatch');
    records.push(record);
  }
  // Owner-confirmed CI signing job only. No command-line key, chat key, output key,
  // subprocess logging or frontend access. A user-approved pinned public key
  // must already be committed to source before signing is permitted.
  const raw = process.env.GUAN_STABLE_SIGNING_KEY;
  delete process.env.GUAN_STABLE_SIGNING_KEY;
  if (!raw || raw.length > 4096) throw Error('Signing secret required');
  const privateKey = createPrivateKey(raw), publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 required');
  const id = keyId(publicKey);
  if (!Object.hasOwn(STABLE_TRUSTED_KEYS, id) || keyId(STABLE_TRUSTED_KEYS[id]) !== id) throw Error('Signing key is not pinned');
  const manifest = validateStableManifest({ format: 1, app: 'guan-ai-workbench', channel: 'stable', version, repository,
    commit: records[0].commit, builtAt: new Date().toISOString(), keyId: id, packages: records.map(r => r.descriptor) });
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), signature = sign(null, bytes, privateKey);
  for (const [name, content] of [['guan-stable-manifest.json', bytes], ['guan-stable-manifest.sig', signature]]) {
    if (!await writePrivateFile(path.join(directory, name), content, { exclusive: true })) throw Error('Existing signature retained');
  }
  for (const arch of ['arm64', 'x64']) await verifySignedStable({ directory, repository, version, arch });
  if (!await writePrivateFile(path.join(directory, 'SHA256SUMS.txt'), manifest.packages.map(p => `${p.sha256}  ${p.name}\n`).join(''), { exclusive: true })) throw Error('Existing checksum file retained');
  console.log(JSON.stringify({ ok: true, version, packages: 2, keyId: id, privateKeyExported: false }));
}
main().catch(() => { console.error('Stable signing failed safely; nothing was published. Verify owner approval, signing secret, pinned public key and artifact identity.'); process.exitCode = 1; });
