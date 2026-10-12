import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch } from 'undici';
import { CredentialError } from './keychain-vault.mjs';

const methods = { openai: new Set(['GET', 'POST', 'DELETE']), gemini: new Set(['GET', 'POST']),
  agent: new Set(['GET', 'POST']), webdav: new Set(['GET', 'PUT', 'PROPFIND', 'MKCOL']), github: new Set(['GET']) };
function allowedPath(kind, pathname) {
  if (kind === 'openai') return /^\/v1\/(?:models(?:\/[\w.-]+)?|images\/(?:generations|edits|variations)|chat\/completions|responses(?:\/[\w-]+)?|audio\/(?:speech|transcriptions|translations)|videos(?:\/[\w-]+(?:\/content)?)?)$/.test(pathname);
  if (kind === 'gemini') return /^\/v1(?:beta)?\/(?:models(?:\/[\w.:-]+)?|operations\/[\w.-]+|files\/[\w.-]+(?::download)?)$/.test(pathname);
  if (kind === 'agent') return /^\/(?:events|canvas\/(?:state|activate|result)|agent\/(?:config|local-image|local-file\/reveal|attachments\/[\w-]+|message-assets\/[\w.-]+\/[\w.-]+|codex\/[\w./-]+))$/.test(pathname);
  if (kind === 'github') return /^\/repos\/[\w.-]+\/[\w.-]+\/(?:releases(?:\/(?:latest|\d+|assets\/\d+))?)$/.test(pathname);
  return kind === 'webdav';
}
export function planSecureProviderRequest(profile, suffix, method, incomingHeaders = {}) {
  if (!methods[profile.kind]?.has(method) || typeof suffix !== 'string' || suffix.length > 8192 || !suffix.startsWith('/') || suffix.startsWith('//')
    || /[\\\x00-\x20]/.test(suffix) || /%(?:2e|2f|5c|25|00)/i.test(suffix.split('?')[0])) throw new CredentialError('request_not_allowed');
  if (suffix.split('?')[0].split('/').some(segment => segment === '.' || segment === '..')) throw new CredentialError('request_not_allowed');
  const parsed = new URL('https://request.invalid' + suffix);
  if (parsed.hash || !allowedPath(profile.kind, parsed.pathname)) throw new CredentialError('request_not_allowed');
  // Neither browser request headers nor URL params select the credential/host.
  // Legacy Agent query authentication stays server-side for protocol compatibility.
  parsed.searchParams.delete('token'); parsed.searchParams.delete('key'); parsed.searchParams.delete('api_key');
  const endpoint = new URL(profile.endpoint);
  let pathname = parsed.pathname;
  if (['openai', 'gemini'].includes(profile.kind)) {
    const version = endpoint.pathname.match(/\/(v1(?:beta)?)$/)?.[1];
    if (version && pathname.startsWith('/' + version + '/')) pathname = pathname.slice(version.length + 1);
  }
  const url = new URL(endpoint.href.replace(/\/+$/, '') + pathname + parsed.search);
  if (url.origin !== endpoint.origin) throw new CredentialError('request_not_allowed');
  const headers = { accept: String(incomingHeaders.accept || 'application/json'), 'accept-encoding': 'identity' };
  for (const name of ['content-type', 'depth']) if (incomingHeaders[name]) headers[name] = String(incomingHeaders[name]);
  const secrets = [profile.secret, encodeURIComponent(profile.secret), JSON.stringify(profile.secret).slice(1, -1)];
  if (profile.kind === 'gemini') headers['x-goog-api-key'] = profile.secret;
  else if (profile.kind === 'webdav') { const encoded = Buffer.from(profile.username + ':' + profile.secret).toString('base64'); headers.authorization = 'Basic ' + encoded; secrets.push(encoded); }
  else if (profile.kind === 'agent') url.searchParams.set('token', profile.secret);
  else headers.authorization = 'Bearer ' + profile.secret;
  return { url, headers, secrets: [...new Set(secrets)].filter(Boolean) };
}
export async function* redactTextStream(body, secrets) {
  const decoder = new StringDecoder('utf8'), holdback = Math.max(1, ...secrets.map(secret => secret.length));
  let text = '';
  const redact = value => secrets.reduce((result, secret) => result.split(secret).join('[credential-redacted]'), value);
  for await (const chunk of body) {
    text = redact(text + decoder.write(Buffer.from(chunk)));
    if (text.length > holdback) { yield text.slice(0, -holdback); text = text.slice(-holdback); }
  }
  yield redact(text + decoder.end());
}
export async function proxySecureProvider({ profile, suffix, request, response, dispatcher, upstreamFetch = fetch }) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30 * 60_000);
  const onClose = () => { if (!response.writableEnded) controller.abort(); };
  response.once('close', onClose);
  try {
    const plan = planSecureProviderRequest(profile, suffix, request.method || 'GET', request.headers);
    let body;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw new CredentialError('request_too_large'); chunks.push(chunk); }
      body = Buffer.concat(chunks);
    }
    const reply = await upstreamFetch(plan.url, { method: request.method, headers: plan.headers, body, redirect: 'manual',
      signal: controller.signal, ...(dispatcher ? { dispatcher } : {}) });
    // Never follow or reveal Location/Set-Cookie/auth headers; cross-host
    // redirects must not carry a user's credential to another destination.
    if (reply.status >= 300 && reply.status < 400) { await reply.body?.cancel(); throw new CredentialError('upstream_redirect_refused'); }
    const type = reply.headers.get('content-type') || 'application/octet-stream';
    response.writeHead(reply.status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if (!reply.body) { response.end(); return; }
    const source = /(?:json|text|xml|event-stream)/i.test(type) ? Readable.from(redactTextStream(reply.body, plan.secrets)) : Readable.fromWeb(reply.body);
    await pipeline(source, response);
  } catch (error) {
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: { code: error instanceof CredentialError ? error.code : 'upstream_request_failed', message: '安全凭据请求失败，原配置已保留' } }));
    }
  } finally { clearTimeout(timeout); response.removeListener('close', onClose); }
}
