import { createHash } from 'node:crypto';
import { CredentialError } from './keychain-vault.mjs';
import { validateCredentialProfile } from './credential-registry.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
// Prepare-only: retain encrypted original before creating any usable reference.
// Does not write browser data, connect providers or discard old configurations.
export async function prepareCredentialMigration(registry, { configRecord, agent }, origin) {
  let record;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash) throw Error();
    if (typeof configRecord !== 'string' || Buffer.byteLength(configRecord) > 4 * 1024 * 1024) throw Error();
    record = JSON.parse(configRecord);
    if (!record?.state?.config || !Array.isArray(record.state.config.channels) || record.state.config.channels.length > 256
      || !record.state.webdav || record.version !== 0) throw Error();
  } catch { throw new CredentialError('legacy_config_invalid'); }
  const plans = [], config = record.state.config;
  const add = (path, kind, endpoint, secret, username) => {
    if (!secret) return;
    if (typeof secret !== 'string' || secret.startsWith('guan-vault:')) throw new CredentialError('migration_not_supported');
    validateCredentialProfile({ kind, endpoint, secret, username });
    plans.push({ path, kind, endpoint, secret, username });
  };
  const channelIds = new Set();
  for (let index = 0; index < config.channels.length; index++) {
    const channel = config.channels[index];
    if (!channel || typeof channel.id !== 'string' || channelIds.has(channel.id) || !Array.isArray(channel.models)) throw new CredentialError('legacy_config_invalid');
    channelIds.add(channel.id);
    if (channel.models.some(model => model?.script?.trim())) throw new CredentialError('migration_not_supported');
    const kind = channel.apiFormat === 'gemini' ? 'gemini' : channel.apiFormat === 'openai' ? 'openai' : null;
    if (channel.apiKey && !kind) throw new CredentialError('migration_not_supported');
    add(['state', 'config', 'channels', index], kind, channel.baseUrl, channel.apiKey);
  }
  const configKind = config.apiFormat === 'gemini' ? 'gemini' : config.apiFormat === 'openai' ? 'openai' : null;
  if (config.apiKey && !configKind) throw new CredentialError('migration_not_supported');
  add(['state', 'config'], configKind, config.baseUrl, config.apiKey);
  add(['state', 'webdav'], 'webdav', record.state.webdav.url, record.state.webdav.password, record.state.webdav.username);
  if (agent) {
    if (typeof agent.url !== 'string' || typeof agent.token !== 'string') throw new CredentialError('legacy_config_invalid');
    add(['agent'], 'agent', agent.url, agent.token);
  }
  if (!plans.length) return { migrated: false, reason: 'no_legacy_credentials', changes: [] };
  // Snapshot also includes Agent's independent keys, without returning them.
  const source = JSON.stringify({ configRecord, ...(agent ? { agent } : {}) });
  const recovery = await registry.encryptRecovery(source), changes = [];
  const created = new Map();
  for (const plan of plans) {
    const identity = digest(JSON.stringify([plan.kind, plan.endpoint, plan.secret, plan.username || '']));
    let reference = created.get(identity);
    if (!reference) { reference = await registry.createProfile(plan); created.set(identity, reference); }
    changes.push({ path: plan.path, baseUrl: origin + '/local-secure-api/' + reference.id, credentialRef: reference.credentialRef });
  }
  return { migrated: false, prepared: true, recoveryId: recovery.id, sourceDigest: digest(source), changes };
}
