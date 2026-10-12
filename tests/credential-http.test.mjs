import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CredentialRegistry } from '../src/server/credential-registry.mjs';
import { createCredentialHttpHandler } from '../src/server/credential-http.mjs';
import { prepareCredentialMigration } from '../src/server/credential-migration.mjs';
import { ActivityGate } from '../src/server/activity-gate.mjs';

function record(endpoint = 'https://api.example.com') {
  return JSON.stringify({ state: { config: { baseUrl: endpoint, apiKey: 'fixture-private-value', apiFormat: 'openai',
    channels: [{ id: 'default', baseUrl: endpoint, apiKey: 'fixture-private-value', apiFormat: 'openai', models: [{ name: 'fixture-model' }] }] },
    webdav: { url: '', username: '', password: '', directory: 'kept' } }, version: 0 });
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'guan-credential-http-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = new Map(), registry = new CredentialRegistry({ directory, vault: { insert: async (id, value) => keys.set(id, value), read: async id => keys.get(id) ?? null } });
  return { registry, keys, directory };
}
test('prepare saves verified encrypted original and returns references only, preserving duplicate channel identity', async t => {
  const f = await fixture(t), source = record();
  const prepared = await prepareCredentialMigration(f.registry, { configRecord: source }, 'http://127.0.0.1:5174');
  assert.equal(prepared.migrated, false); assert.equal(prepared.prepared, true); assert.equal(prepared.changes.length, 2);
  assert.equal(prepared.changes[0].credentialRef, prepared.changes[1].credentialRef);
  assert.ok(!JSON.stringify(prepared).includes('fixture-private-value'));
  assert.equal(JSON.parse(await f.registry.recover(prepared.recoveryId)).configRecord, source);
});
test('unsupported custom scripts/remote Agent/broken legacy records fail before any storage mutation', async t => {
  for (const mutation of ['script', 'agent', 'broken', 'oversized-secret', 'invalid-username', 'newline-key']) {
    const f = await fixture(t), source = JSON.parse(record());
    if (mutation === 'script') source.state.config.channels[0].models[0].script = 'return apiKey;';
    if (mutation === 'oversized-secret') source.state.config.channels[0].apiKey = 'x'.repeat(16385);
    if (mutation === 'newline-key') source.state.config.channels[0].apiKey = 'fixture\ninvalid';
    if (mutation === 'invalid-username') source.state.webdav = { url: 'https://dav.example.com', username: 'invalid:user', password: 'fixture' };
    await assert.rejects(prepareCredentialMigration(f.registry, { configRecord: mutation === 'broken' ? '{damaged' : JSON.stringify(source),
      ...(mutation === 'agent' ? { agent: { url: 'https://agent.example.com', token: 'fixture' } } : {}) }, 'http://127.0.0.1:5174'));
    assert.equal(f.keys.size, 0);
  }
});
test('Gemini channels migrate to the backend proxy without exposing their key', async t => {
  const f = await fixture(t), source = JSON.parse(record('https://generativelanguage.googleapis.com/v1beta'));
  source.state.config.apiKey = '';
  source.state.config.channels[0].apiFormat = 'gemini';
  source.state.config.channels[0].apiKey = 'gemini-fixture-key';
  const prepared = await prepareCredentialMigration(f.registry, { configRecord: JSON.stringify(source) }, 'http://127.0.0.1:5174');
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.changes.length, 1);
  assert.equal(prepared.changes[0].path.join('.'), 'state.config.channels.0');
  assert.ok(!JSON.stringify(prepared).includes('gemini-fixture-key'));
  assert.equal((await f.registry.publicStatus()).profiles[0].kind, 'gemini');
});
test('actual HTTP routes enforce exact Origin, do not export secrets or authorize installation, and reject changed references', async t => {
  const f = await fixture(t), gate = new ActivityGate(); let handler;
  const server = createServer(async (request, response) => { if (!await handler(request, response)) { response.writeHead(404); response.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  handler = createCredentialHttpHandler({ registry: f.registry, origin, activityGate: gate });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const request = (suffix, body, headers = {}) => fetch(origin + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await request('/local-app/credentials/status', undefined, { origin: 'https://evil.example' })).status, 403);
  const result = await request('/local-app/credentials/prepare', { configRecord: record() }); const prepared = await result.json();
  assert.equal(result.status, 200); assert.ok(!JSON.stringify(prepared).includes('fixture-private-value'));
  const savedSecret = ['new', 'fixture', 'value'].join('-');
  const saved = await request('/local-app/credentials/save', { kind: 'openai', endpoint: 'https://api.example.com', secret: savedSecret });
  assert.equal(saved.status, 200);
  const savedBinding = await saved.json();
  assert.ok(!JSON.stringify(savedBinding).includes(savedSecret));
  const binding = await (await request('/local-app/credentials/binding', { credentialRef: savedBinding.credentialRef })).json();
  assert.equal(binding.endpoint, 'https://api.example.com'); assert.equal(binding.kind, 'openai');
  assert.ok(!JSON.stringify(binding).includes(savedSecret));
  assert.equal((await request('/local-app/credentials/save', { kind: 'github', endpoint: 'https://api.github.com', secret: 'fixture' })).status, 409);
  const id = prepared.changes[0].credentialRef.slice('guan-vault:'.length);
  const mismatch = await request('/local-secure-api/' + id + '/v1/images/generations', {}, { authorization: 'Bearer changed-browser-key' });
  assert.equal(mismatch.status, 409); assert.ok(!(await mismatch.text()).includes('fixture-private-value'));
  assert.equal((await request('/local-app/credentials/export')).status, 405);
  const status = await (await request('/local-app/credentials/status')).json(); assert.ok(!JSON.stringify(status).includes('fixture-private-value'));
  assert.equal(gate.status().canInstall, false); assert.equal(gate.status().active, 0);
  for (const [suffix, body] of [['/local-app/credentials/prepare', '{broken'], ['/local-app/credentials/prepare', JSON.stringify({ unexpected: true })],
    ['/local-secure-api/not-an-id/v1/models', '{}']]) {
    const invalid = await fetch(origin + suffix, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
    assert.equal(invalid.status, 409); assert.equal(gate.status().active, 0);
  }
  const dav = await f.registry.createProfile({ kind: 'webdav', endpoint: 'https://dav.example.com', secret: 'fixture-dav', username: 'expected-user' });
  const davResponse = await fetch(origin + '/local-secure-api/' + dav.id + '/file', { headers: { origin,
    authorization: 'Basic ' + Buffer.from('wrong-user:' + dav.credentialRef).toString('base64') } });
  assert.equal(davResponse.status, 409); assert.equal((await davResponse.json()).error.code, 'credential_reference_mismatch');
  assert.equal(gate.status().active, 0);
});
