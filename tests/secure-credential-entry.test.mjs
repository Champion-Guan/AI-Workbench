import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
function client(fetch) {
  const source = readFileSync(new URL('../src/canvas/services/secure-credentials.ts', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({ fetch, AbortSignal, location: { origin: 'http://127.0.0.1:5174' } });
  vm.runInContext(ts.transpileModule(source + '\nglobalThis.api = { secureCredential, secureChannel, secureConfig };', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.api;
}
const id = '11111111-1111-4111-8111-111111111111', ref = 'guan-vault:' + id, route = 'http://127.0.0.1:5174/local-secure-api/' + id;
test('new channel credentials publish only verified references and never mutate the submitted draft', async () => {
  const channel = { apiFormat: 'openai', baseUrl: 'https://api.example.test', apiKey: 'fixture-new-key', models: [] };
  const calls = [];
  const api = client(async (url, options) => { calls.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => ({ ok: true, credentialRef: ref, baseUrl: route }) }; });
  const secured = await api.secureChannel(channel);
  assert.equal(secured.apiKey, ref); assert.equal(secured.baseUrl, route); assert.equal(channel.apiKey, 'fixture-new-key');
  assert.equal(calls[0][0], '/local-app/credentials/save');
  assert.equal(calls[0][1].kind, 'openai');
});
test('failed native save, forged response, script and mismatched reference fail closed', async () => {
  for (const response of [{ ok: false }, { ok: true, credentialRef: ref, baseUrl: 'https://foreign.test' }]) {
    const api = client(async () => ({ ok: true, json: async () => response }));
    await assert.rejects(api.secureCredential('openai', 'https://api.example.test', 'fixture-new-key'));
  }
  let calls = 0;
  const api = client(async () => { calls++; return { ok: true, json: async () => ({ ok: true, credentialRef: ref, baseUrl: route, endpoint: 'https://api.example.test', kind: 'openai', username: '' }) }; });
  await assert.rejects(api.secureChannel({ apiKey: 'fixture', models: [{ script: 'return apiKey;' }] })); assert.equal(calls, 0);
  await assert.rejects(api.secureCredential('openai', 'https://different.test', ref));
  await assert.rejects(api.secureCredential('webdav', route, ref, 'different-user'));
  const binding = await api.secureCredential('openai', 'https://api.example.test', ref); assert.equal(binding.baseUrl, route);
});
test('existing local binding survives editing but rejects foreign origin and substituted identity', async () => {
  const response = { ok: true, credentialRef: ref, baseUrl: route, endpoint: 'https://api.example.test', kind: 'openai', username: '' };
  const api = client(async () => ({ ok: true, json: async () => response }));
  assert.equal((await api.secureCredential('openai', route, ref)).credentialRef, ref);
  assert.equal((await api.secureCredential('openai', route + '/', ref)).baseUrl, route);
  await assert.rejects(api.secureCredential('openai', route.replace('127.0.0.1', 'localhost'), ref));
  response.credentialRef = 'guan-vault:22222222-2222-4222-8222-222222222222';
  await assert.rejects(api.secureCredential('openai', route, ref));
  response.credentialRef = ref; response.baseUrl = route.replace('127.0.0.1', 'localhost');
  await assert.rejects(api.secureCredential('openai', response.endpoint, ref));
});
