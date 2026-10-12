// Operator CLI only. Secrets remain in memory; never impersonates Actions.
import { readFile, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ProxyAgent } from 'undici';
import { localStableOwner } from './lib/local-stable-owner.mjs';
import { signStableRelease } from './sign-stable-release.mjs';
import { publishStableRelease } from './publish-stable-release.mjs';
import { MacKeychainVault } from '../src/server/keychain-vault.mjs';
import { runtimePaths } from '../src/server/runtime-paths.mjs';
import { keyId, sha256 } from '../src/server/stable-manifest.mjs';
import { STABLE_TRUSTED_KEYS } from '../src/server/stable-trust.mjs';
import { sameWorkbenchRepository } from '../src/server/workbench-identity.mjs';

let stage = 'approval';
try {
  const [mode, sourceRoot, commit, tag, backupDirectory, confirmation] = process.argv.slice(2);
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.length !== 8
    || !['sign', 'publish'].includes(mode) || !path.isAbsolute(sourceRoot || '') || !path.isAbsolute(backupDirectory || '')) throw Error();
  const approval = localStableOwner({ root: sourceRoot, commit, tag, confirmation });
  const directory = path.join(sourceRoot, 'output/stable');
  if (mode === 'sign') {
    stage = 'encrypted-key-verification';
    const bounded = async (file, limit) => {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > limit) throw Error();
      const bytes = await readFile(file); if (bytes.length > limit) throw Error(); return bytes;
    };
    const info = await lstat(backupDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) throw Error();
    const record = JSON.parse(await bounded(path.join(backupDirectory, 'BOOTSTRAP.json'), 8192));
    const signingRepositoryMatches = sameWorkbenchRepository(record.repository, approval.repository);
    if (!signingRepositoryMatches || !record.backupVerified || record.keychainNamespace !== 'production'
      || record.encryptedPrivateFile !== 'signing-key.encrypted.pem' || !Object.hasOwn(STABLE_TRUSTED_KEYS, record.keyId)) throw Error();
    const encrypted = await bounded(path.join(backupDirectory, record.encryptedPrivateFile), 8192);
    if (sha256(encrypted) !== record.encryptedSha256) throw Error();
    const root = fileURLToPath(new URL('../', import.meta.url)), paths = runtimePaths({ projectRoot: root });
    const vault = new MacKeychainVault({ executable: path.join(paths.runtime, 'guan-keychain') });
    const passphrase = await vault.read(record.account);
    if (!passphrase) throw Error();
    const privateKey = createPrivateKey({ key: encrypted, format: 'pem', passphrase });
    if (keyId(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })) !== record.keyId) throw Error();
    stage = 'sign';
    await signStableRelease({ approval, directory, root: sourceRoot, privateKey });
  } else {
    stage = 'publish';
    const token = execFileSync('gh', ['auth', 'token'], { env: { ...process.env, GH_DEBUG: '' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).toString().trim();
    const dispatcher = new ProxyAgent('http://127.0.0.1:7890');
    try { await publishStableRelease({ approval, directory, token, root: sourceRoot, dispatcher }); }
    finally { await dispatcher.destroy(); }
  }
} catch {
  console.error(JSON.stringify({ ok: false, stage, message: 'Local release stopped safely. Credentials not logged; inspect existing artifacts/Drafts before retrying. Production was not restarted.' }));
  process.exitCode = 1;
}
