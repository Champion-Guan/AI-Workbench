import { randomUUID, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';
import { readPrivateFile, writePrivateFile } from './runtime-paths.mjs';
import { CREDENTIAL_ACCOUNT, CredentialError } from './keychain-vault.mjs';

const kinds = new Set(['openai', 'gemini', 'webdav', 'agent', 'github']);
const digest = value => createHash('sha256').update(value).digest('hex');
function equal(a, b) { return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export function validateCredentialEndpoint(value, kind) {
  try {
    if (typeof value !== 'string' || value.length > 4096 || !kinds.has(kind)) throw Error();
    const url = new URL(value);
    const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)
      || kind === 'agent' && !loopback || kind === 'github' && (url.origin !== 'https://api.github.com' || url.pathname !== '/')) throw Error();
    if (/\/(?:local-secure-api|local-app)(?:\/|$)/.test(url.pathname) || /[\\\x00-\x20]/.test(value)) throw Error();
    const normalized = url.href.replace(/\/+$/, '');
    if (normalized.length > 4096) throw Error();
    return normalized;
  } catch { throw new CredentialError('invalid_endpoint'); }
}
export function validateCredentialProfile({ kind, endpoint, secret, username = '' }) {
  const normalized = validateCredentialEndpoint(endpoint, kind);
  if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret) > 16384 || secret.includes('\0')
    || ['openai', 'gemini', 'github'].includes(kind) && /[\r\n]/.test(secret)) throw new CredentialError('invalid_secret');
  if (typeof username !== 'string' || Buffer.byteLength(username) > 1024 || /[\r\n\0]/.test(username)
    || kind === 'webdav' && username.includes(':')) throw new CredentialError('invalid_request');
  return normalized;
}
function validateIndex(value) {
  if (value?.version !== 1 || Object.keys(value).sort().join(',') !== 'profiles,snapshots,version' || !Array.isArray(value.profiles) || value.profiles.length > 4096 || !Array.isArray(value.snapshots) || value.snapshots.length > 256) throw new CredentialError('private_index_invalid');
  const ids = new Set(), accounts = new Set();
  for (const item of value.profiles) {
    if (!item || !CREDENTIAL_ACCOUNT.test(item.id) || !CREDENTIAL_ACCOUNT.test(item.account) || ids.has(item.id) || accounts.has(item.account)
      || !kinds.has(item.kind) || Object.keys(item).sort().join(',') !== 'account,endpoint,id,kind,username'
      || typeof item.username !== 'string' || Buffer.byteLength(item.username) > 1024 || /[\r\n\0]/.test(item.username)) throw new CredentialError('private_index_invalid');
    validateCredentialEndpoint(item.endpoint, item.kind); ids.add(item.id); accounts.add(item.account);
  }
  for (const item of value.snapshots) {
    if (!item || !CREDENTIAL_ACCOUNT.test(item.id) || !CREDENTIAL_ACCOUNT.test(item.account) || ids.has(item.id) || accounts.has(item.account)
      || !/^[a-f0-9]{64}$/.test(item.digest) || Object.keys(item).sort().join(',') !== 'account,digest,id') throw new CredentialError('private_index_invalid');
    ids.add(item.id); accounts.add(item.account);
  }
  return value;
}
export class CredentialRegistry {
  constructor({ directory, vault }) {
    if (!path.isAbsolute(directory) || !vault) throw new CredentialError('invalid_request');
    this.directory = directory; this.file = path.join(directory, 'credential-index.json'); this.vault = vault; this.queue = Promise.resolve();
  }
  async index() {
    try { const text = await readPrivateFile(this.file, { maxBytes: 24 * 1024 * 1024 }); return text === null ? { version: 1, profiles: [], snapshots: [] } : validateIndex(JSON.parse(text)); }
    catch { throw new CredentialError('private_index_invalid'); }
  }
  serial(operation) {
    const work = this.queue.catch(() => undefined).then(operation);
    this.queue = work; void work.catch(() => undefined); return work;
  }
  async insertVerified(secret) {
    if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret) > 16384 || secret.includes('\0')) throw new CredentialError('invalid_secret');
    const account = randomUUID();
    await this.vault.insert(account, secret);
    if (!equal(await this.vault.read(account), secret)) throw new CredentialError('keychain_verification_failed');
    return account; // Failed verification never publishes a usable reference.
  }
  createProfile({ kind, endpoint, secret, username = '' }) {
    return this.serial(async () => {
      const index = await this.index(), normalized = validateCredentialProfile({ kind, endpoint, secret, username });
      if (index.profiles.length >= 4096) throw new CredentialError('invalid_request');
      // Each change gets a fresh immutable account; previous credentials remain
      // available to in-flight requests and encrypted recovery records.
      const account = await this.insertVerified(secret), id = randomUUID();
      const profile = { id, account, kind, endpoint: normalized, username };
      index.profiles.push(profile);
      await writePrivateFile(this.file, JSON.stringify(index, null, 2));
      return { id, kind, credentialRef: `guan-vault:${id}` };
    });
  }
  async publicStatus() {
    const index = await this.index();
    return { profiles: index.profiles.map(({ id, kind }) => ({ id, kind, hasCredential: true })), encryptedSnapshots: index.snapshots.length };
  }
  async resolve(id) {
    if (!CREDENTIAL_ACCOUNT.test(id)) throw new CredentialError('invalid_request');
    const profile = (await this.index()).profiles.find(item => item.id === id);
    if (!profile) throw new CredentialError('credential_not_found');
    const secret = await this.vault.read(profile.account);
    if (typeof secret !== 'string' || !secret) throw new CredentialError('authorization_required');
    return { ...profile, secret }; // Backend-only, never an HTTP response.
  }
  encryptRecovery(value) {
    return this.serial(async () => {
      if (typeof value !== 'string' || Buffer.byteLength(value) > 8 * 1024 * 1024) throw new CredentialError('invalid_request');
      const index = await this.index();
      if (index.snapshots.length >= 256) throw new CredentialError('recovery_capacity');
      const key = randomBytes(32), account = await this.insertVerified(key.toString('base64')), id = randomUUID(), iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(id));
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const snapshot = { version: 1, id, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: bytes.toString('base64') };
      const file = path.join(this.directory, 'recovery-' + id + '.json');
      if (!await writePrivateFile(file, JSON.stringify(snapshot), { exclusive: true })) throw new CredentialError('recovery_write_failed');
      // Read/decrypt the actual disk copy before registering its existence.
      const decoded = this.decrypt(JSON.parse(await readPrivateFile(file, { maxBytes: 16 * 1024 * 1024 })), key, id);
      if (!equal(decoded, value)) throw new CredentialError('recovery_verification_failed');
      index.snapshots.push({ id, account, digest: digest(value) });
      await writePrivateFile(this.file, JSON.stringify(index, null, 2));
      return { id, digest: digest(value), encrypted: true };
    });
  }
  decrypt(snapshot, key, id) {
    if (snapshot?.version !== 1 || snapshot.id !== id || !/^[A-Za-z0-9+/]*={0,2}$/.test(snapshot.data || '')) throw new CredentialError('recovery_invalid');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(snapshot.iv, 'base64'));
    decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(snapshot.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(snapshot.data, 'base64')), decipher.final()]).toString('utf8');
  }
  async recover(id) {
    try {
      if (!CREDENTIAL_ACCOUNT.test(id)) throw Error();
      const record = (await this.index()).snapshots.find(item => item.id === id);
      if (!record) throw Error();
      const secret = await this.vault.read(record.account);
      if (typeof secret !== 'string' || Buffer.from(secret, 'base64').length !== 32) throw Error();
      const value = this.decrypt(JSON.parse(await readPrivateFile(path.join(this.directory, 'recovery-' + id + '.json'), { maxBytes: 16 * 1024 * 1024 })), Buffer.from(secret, 'base64'), id);
      if (digest(value) !== record.digest) throw Error();
      return value; // Internal recovery only; no HTTP secret export endpoint.
    } catch { throw new CredentialError('recovery_invalid'); }
  }
}
