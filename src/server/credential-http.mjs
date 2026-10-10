import { CREDENTIAL_ACCOUNT, CredentialError } from './keychain-vault.mjs';
import { prepareCredentialMigration } from './credential-migration.mjs';
import { proxySecureProvider } from './secure-provider-proxy.mjs';

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new CredentialError('invalid_request');
  let bytes = 0; const chunks = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 5 * 1024 * 1024) throw new CredentialError('request_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CredentialError('invalid_request'); }
}
export function createCredentialHttpHandler({ registry, origin, activityGate, dispatcherForProfile }) {
  const reply = (response, status, value) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value));
  };
  return async (request, response) => {
    const raw = request.url || '/', isManagement = raw.startsWith('/local-app/credentials/'), isProxy = raw.startsWith('/local-secure-api/');
    if (!isManagement && !isProxy) return false;
    const browserRead = ['GET', 'HEAD'].includes(request.method);
    if (request.headers.host !== new URL(origin).host || request.headers.origin !== origin && !(browserRead && request.headers['sec-fetch-site'] === 'same-origin')) {
      reply(response, 403, { error: { code: 'local_origin_required' } }); return true;
    }
    let release;
    try {
      release = activityGate.acquire(isProxy ? 'relay' : 'storage');
      if (isManagement) {
        if (raw === '/local-app/credentials/status' && request.method === 'GET') reply(response, 200, { ok: true, ...await registry.publicStatus(), credentialReadback: 'not-checked' });
        else if (raw === '/local-app/credentials/prepare' && request.method === 'POST') {
          const data = await readJson(request);
          if (!data || Object.keys(data).some(key => !['configRecord', 'agent'].includes(key))) throw new CredentialError('invalid_request');
          reply(response, 200, { ok: true, ...await prepareCredentialMigration(registry, data, origin) });
        } else reply(response, 405, { error: { code: 'operation_not_allowed' } });
      } else {
        const match = /^\/local-secure-api\/([a-f0-9-]{36})(\/.*)$/.exec(raw);
        if (!match || !CREDENTIAL_ACCOUNT.test(match[1])) throw new CredentialError('invalid_request');
        const profile = await registry.resolve(match[1]);
        // References must agree with the immutable profile. Editing a legacy
        // API Key must never silently continue using the previous credential.
        const ref = 'guan-vault:' + match[1], url = new URL('http://request.invalid' + match[2]);
        const supplied = profile.kind === 'agent' ? url.searchParams.get('token')
          : profile.kind === 'gemini' ? request.headers['x-goog-api-key']
          : profile.kind === 'webdav' ? (request.headers.authorization === 'Basic ' + Buffer.from(profile.username + ':' + ref).toString('base64') ? ref : null)
          : String(request.headers.authorization || '').replace(/^Bearer /, '');
        if (supplied !== ref) throw new CredentialError('credential_reference_mismatch');
        await proxySecureProvider({ profile, suffix: match[2], request, response, dispatcher: dispatcherForProfile?.(profile) });
      }
    } catch (error) {
      if (response.headersSent) response.destroy();
      else reply(response, error instanceof CredentialError ? 409 : 503, { error: { code: error instanceof CredentialError ? error.code : 'credential_operation_failed', message: '安全凭据操作未完成，原配置已保留' } });
    } finally { release?.(); }
    return true;
  };
}
