import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { readGitHubStable } from '../src/server/github-stable.mjs';
import { readReleaseAsset } from '../src/server/github-assets.mjs';
import { UpdateAuth } from '../src/server/update-auth.mjs';
import { planSecureProviderRequest } from '../src/server/secure-provider-proxy.mjs';
import { workbenchTabScript } from '../src/server/workbench-page-census.mjs';
const repository = 'Champion-Guan/infinite-canvas';
test('public updates never access Keychain or send an authorization header', async () => {
  const auth = new UpdateAuth({ directory: '/unused', vault: { read() { throw Error('must not read'); } } });
  assert.equal(await auth.token(repository), '');
  const fetchImpl = async (url, options) => {
    assert.ok(url.includes('/Champion-Guan/infinite-canvas/'));
    assert.equal(options.headers.authorization, undefined);
    return new Response('[]');
  };
  assert.equal(await readGitHubStable({ repository, token: '', fetchImpl }), null);
  const bytes = await readReleaseAsset({ repository, token: '', asset: { id: 1 }, maxBytes: 8,
    fetchImpl: async (_url, options) => { assert.equal(options.headers.authorization, undefined); return new Response('signed'); } });
  assert.equal(bytes.toString(), 'signed');
  await assert.rejects(readGitHubStable({ repository: 'untrusted/repo', token: '', fetchImpl }));
});
test('scripts bind requests to one local credential and backend supplies provider authentication', () => {
  const source = readFileSync(new URL('../src/canvas/services/api/plugin-credential-scope.ts', import.meta.url), 'utf8').replace(/export /g, '');
  const ctx = vm.createContext({ URL });
  vm.runInContext(ts.transpileModule(source + '\nglobalThis.api = {scopedPluginUrl, scopedPluginHeaders};', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const ref = 'guan-vault:11111111-1111-4111-8111-111111111111', origin = 'http://127.0.0.1:8888';
  const base = origin + '/local-secure-api/' + ref.slice(11);
  assert.equal(ctx.api.scopedPluginUrl(base, base + '/v1/images/generations', origin), base + '/v1/images/generations');
  for (const url of ['https://foreign.test/v1/models', '../other/v1/models', base.replace('11111111', '22222222') + '/v1/models', '//foreign.test/v1/models'])
    assert.throws(() => ctx.api.scopedPluginUrl(base, url, origin));
  assert.throws(() => ctx.api.scopedPluginHeaders(ref, { Authorization: 'Bearer different' }));
  const headers = ctx.api.scopedPluginHeaders(ref);
  assert.equal(headers['x-goog-api-key'], ref);
  const planned = planSecureProviderRequest({ kind: 'gemini', endpoint: 'https://provider.test', secret: randomBytes(24).toString('hex') }, '/v1beta/models/example:generateContent', 'POST', headers);
  assert.ok(planned);
});
test('page census script is syntactically valid for both browser families', () => {
  for (const id of ['com.google.Chrome', 'com.apple.Safari']) assert.doesNotThrow(() => new Function(workbenchTabScript(id, 1)));
});
