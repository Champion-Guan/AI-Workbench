import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { planSecureProviderRequest, redactTextStream, proxySecureProvider } from '../src/server/secure-provider-proxy.mjs';

const profile = { kind: 'openai', endpoint: 'https://api.example.com/v1', secret: randomBytes(24).toString('base64url'), username: '' };
test('bound provider ignores browser auth and strips query credentials without changing the chosen host', () => {
  const plan = planSecureProviderRequest(profile, '/v1/images/generations?key=browser-ref', 'POST', { authorization: 'browser-ref', 'x-goog-api-key': 'browser-ref', 'content-type': 'application/json' });
  assert.equal(plan.url.href, 'https://api.example.com/v1/images/generations');
  assert.equal(plan.headers.authorization, 'Bearer ' + profile.secret); assert.equal(plan.headers['x-goog-api-key'], undefined);
});
test('provider rejects host override, traversal, scripts and unsupported methods before any Keychain request', () => {
  for (const suffix of ['//evil.example/v1/models', '/v1/../models', '/v1/%2e%2e/models', '/v1/%252e%252e/models', '/v1/models#fragment', '/v1/exec']) assert.throws(() => planSecureProviderRequest(profile, suffix, 'GET'));
  assert.throws(() => planSecureProviderRequest(profile, '/v1/models', 'PUT'));
});
test('Agent query-token compatibility stays backend-side and WebDAV credentials use native basic encoding', () => {
  const agent = planSecureProviderRequest({ ...profile, kind: 'agent', endpoint: 'http://127.0.0.1:17371' }, '/events?token=browser-ref&clientId=qa', 'GET');
  assert.equal(agent.url.searchParams.get('token'), profile.secret); assert.equal(agent.url.origin, 'http://127.0.0.1:17371');
  const dav = planSecureProviderRequest({ ...profile, kind: 'webdav', endpoint: 'https://dav.example.com/root', username: '用户' }, '/images/qa.png', 'PUT');
  assert.equal(dav.url.href, 'https://dav.example.com/root/images/qa.png');
  assert.equal(dav.headers.authorization, 'Basic ' + Buffer.from('用户:' + profile.secret).toString('base64'));
});
test('stream redaction survives every credential split point and multibyte UTF8 boundaries', async () => {
  const source = Buffer.from('中文 ' + profile.secret + ' done');
  for (let split = 1; split < source.length; split++) {
    async function* chunks() { yield source.subarray(0, split); yield source.subarray(split); }
    let result = ''; for await (const chunk of redactTextStream(chunks(), [profile.secret])) result += chunk;
    assert.equal(result, '中文 [credential-redacted] done');
  }
});
test('actual HTTP proxy adds backend credential, streams safe output and withholds redirect/errors', async t => {
  const received = [];
  const upstream = createServer((request, response) => {
    received.push(request.headers.authorization);
    if (request.url.endsWith('/models')) { response.writeHead(302, { location: 'https://other.example/?token=' + profile.secret }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'private-cookie' });
    response.write('data: ' + profile.secret.slice(0, 6)); response.end(profile.secret.slice(6) + '\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const localProfile = { ...profile, endpoint: 'http://127.0.0.1:' + upstream.address().port };
  const local = createServer((request, response) => void proxySecureProvider({ profile: localProfile, suffix: request.url, request, response }));
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  t.after(async () => { local.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(resolve => local.close(resolve)), new Promise(resolve => upstream.close(resolve))]); });
  const origin = 'http://127.0.0.1:' + local.address().port;
  const result = await fetch(origin + '/v1/responses', { method: 'POST', headers: { authorization: 'browser-ref' }, body: '{}' });
  assert.equal(await result.text(), 'data: [credential-redacted]\n\n'); assert.equal(result.headers.get('set-cookie'), null);
  const redirect = await fetch(origin + '/v1/models');
  assert.equal(redirect.status, 502); assert.ok(!(await redirect.text()).includes(profile.secret)); assert.equal(redirect.headers.get('location'), null);
  assert.deepEqual(received, ['Bearer ' + profile.secret, 'Bearer ' + profile.secret]);
});
