// Explicit one-time operator action; no release, installation or key output.
import { generateKeyPairSync, randomBytes, randomUUID, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, lstat, mkdtemp, chmod } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runtimePaths, writePrivateFile } from '../src/server/runtime-paths.mjs';
import { MacKeychainVault } from '../src/server/keychain-vault.mjs';
import { keyId, sha256 } from '../src/server/stable-manifest.mjs';

const repository = 'Champion-Guan/guan-ai-workbench', secretName = 'GUAN_STABLE_SIGNING_KEY';
let stage = 'preflight', directory;
try {
  const [confirmation, backupRoot] = process.argv.slice(2), root = fileURLToPath(new URL('../', import.meta.url));
  if (process.platform !== 'darwin' || process.argv.length !== 4 || confirmation !== 'BOOTSTRAP-SIGNING'
    || !path.isAbsolute(backupRoot || '') || backupRoot === process.env.HOME
    || backupRoot === '/' || backupRoot === root.slice(0, -1) || backupRoot.startsWith(root)) throw Error();
  const info = await lstat(backupRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error();
  const ghEnv = { ...process.env, GH_DEBUG: '', HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890' };
  const gh = args => execFileSync('gh', args, { env: ghEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).toString();
  const repo = JSON.parse(gh(['api', `repos/${repository}`]));
  if (repo.full_name !== repository || repo.private !== true || repo.owner?.id !== 87700227 || repo.permissions?.admin !== true) throw Error();
  const secrets = JSON.parse(gh(['secret', 'list', '--repo', repository, '--json', 'name']));
  if (!Array.isArray(secrets) || secrets.some(s => s.name === secretName)) throw Error(); // Never overwrite an existing key.
  directory = await mkdtemp(path.join(backupRoot, 'stable-signing-20261011-')); await chmod(directory, 0o700);
  const paths = runtimePaths({ projectRoot: root }), vault = new MacKeychainVault({ executable: path.join(paths.runtime, 'guan-keychain') });
  const pair = generateKeyPairSync('ed25519'), publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }), id = keyId(publicPem);
  const password = randomBytes(32).toString('base64'), account = randomUUID();
  const encrypted = pair.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: password });
  const record = { format: 1, repository, secretName, keyId: id, publicPem, account, keychainNamespace: 'production',
    createdAt: new Date().toISOString(), encryptedPrivateFile: 'signing-key.encrypted.pem', encryptedSha256: sha256(Buffer.from(encrypted)),
    backupVerified: false, githubSecretStored: false, offlineBackupComplete: false, releasePublished: false };
  const save = () => writePrivateFile(path.join(directory, 'BOOTSTRAP.json'), JSON.stringify(record, null, 2) + '\n');
  await save();
  stage = 'encrypted-backup';
  if (!await writePrivateFile(path.join(directory, record.encryptedPrivateFile), encrypted, { exclusive: true })) throw Error();
  await vault.insert(account, password);
  const recoveredPassword = await vault.read(account);
  if (recoveredPassword !== password) throw Error();
  const saved = await readFile(path.join(directory, record.encryptedPrivateFile));
  if (sha256(saved) !== record.encryptedSha256) throw Error();
  const recovered = createPrivateKey({ key: saved, format: 'pem', passphrase: recoveredPassword });
  if (keyId(createPublicKey(recovered).export({ type: 'spki', format: 'pem' })) !== id) throw Error();
  const challenge = Buffer.from('guan-ai-workbench/local-signing-backup-proof/v1');
  if (!verify(null, challenge, pair.publicKey, sign(null, challenge, recovered))) throw Error();
  record.backupVerified = true; await save();
  if (!await writePrivateFile(path.join(directory, 'public-key.pem'), publicPem, { exclusive: true })) throw Error();
  stage = 'github-secret';
  // Private PEM only through stdin; neither argument/env nor captured tool output.
  const raw = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('gh', ['secret', 'set', secretName, '--repo', repository, '--app', 'actions'],
        { env: ghEnv, stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error()); }, 60000);
      child.stdin.on('error', () => {});
      child.once('error', () => { clearTimeout(timer); reject(Error()); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error()); });
      child.stdin.end(raw);
    });
  } finally { raw.fill(0); }
  const stored = JSON.parse(gh(['secret', 'list', '--repo', repository, '--json', 'name,updatedAt'])).find(s => s.name === secretName);
  if (!stored) throw Error();
  record.githubSecretStored = true; record.githubSecretUpdatedAt = stored.updatedAt; await save();
  console.log(JSON.stringify({ ok: true, backupDirectory: directory, keyId: id, publicPem, backupVerified: true,
    githubSecretStored: true, remoteSecretValueReadBack: false, offlineBackupComplete: false, releasePublished: false }));
} catch {
  console.error(JSON.stringify({ ok: false, stage, backupDirectory: directory, message: 'Bootstrap stopped safely. Preserve partial backup and Keychain record; inspect secret metadata before any retry. No private values logged.' }));
  process.exitCode = 1;
}
