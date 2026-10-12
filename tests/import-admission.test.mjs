import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';
const read = file => readFileSync(new URL('../src/canvas/' + file, import.meta.url), 'utf8');
function load(file, bindings, expose) {
  const source = read(file).replace(/^import .*;\s*$/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({ secureConfig: async (config, webdav) => ({ config, webdav }), ...bindings,
    useConfigStore: { getState: () => ({}), ...bindings.useConfigStore } });
  vm.runInContext(ts.transpileModule(source + '\nglobalThis.api = ' + expose, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.api;
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const assertPortableCredentialBindings = load('lib/config-portability.ts', { URL }, 'assertPortableCredentialBindings');
const createPortableAppConfig = load('services/config-file.ts', { URL }, 'createPortableAppConfig');
const configFile = { app: 'infinite-canvas', version: 1, config: { channels: [] }, webdav: { directory: 'kept' }, promptSources: { sources: [], schedule: {} } };
test('portable config export omits credentials and machine-bound routes without changing the active configuration', () => {
  const id = randomUUID(), secret = 'qa-secret-value';
  const config = { apiKey: secret, baseUrl: `http://127.0.0.1:5174/local-secure-api/${id}`,
    channels: [{ apiKey: `guan-vault:${id}`, baseUrl: new URL('/v1?token=hidden', `https://${['user', 'pass'].join(':')}@example.test`).href, models: [{ name: 'fixture', script: `authorization: ${secret}` }] }] };
  const webdav = { url: `http://127.0.0.1:5174/local-secure-api/${id}`, password: secret, directory: 'workbench' };
  const exported = createPortableAppConfig(config, webdav, [], {});
  const serialized = JSON.stringify(exported);
  assert.equal(exported.credentialsOmitted, true);
  assert.equal(exported.config.apiKey, ''); assert.equal(exported.config.baseUrl, '');
  assert.equal(exported.config.channels[0].apiKey, ''); assert.equal(exported.config.channels[0].baseUrl, '');
  assert.equal(exported.config.channels[0].models[0].script, '');
  assert.equal(exported.webdav.password, ''); assert.equal(exported.webdav.url, '');
  assert.equal(exported.webdav.directory, 'workbench');
  assert.ok(!serialized.includes(secret) && !serialized.includes(`guan-vault:${id}`));
  assert.equal(config.apiKey, secret); assert.equal(webdav.password, secret);
});
test('actual configuration import rejects new roots before reading or changing data while paused', async () => {
  const f = createActivityFixture(), epoch = randomUUID(); let reads = 0, writes = 0;
  const importConfig = load('services/config-file.ts', { ...f, assertPortableCredentialBindings, TextEncoder, i18n: { t: key => key },
    useConfigStore: { setState: () => { writes++; } }, usePromptSourceStore: { setState: () => { writes++; } } }, 'importAppConfig');
  await f.barrier.drain(epoch);
  await assert.rejects(importConfig({ text: async () => { reads++; return JSON.stringify(configFile); } }), /update_quiescing/);
  assert.equal(reads, 0); assert.equal(writes, 0);
  f.barrier.resume(epoch); await importConfig({ text: async () => JSON.stringify(configFile) }); assert.equal(writes, 2);
});
test('already admitted config import remains busy across async file read and completes before drain confirmation', async () => {
  const f = createActivityFixture(), file = deferred(), writes = [], epoch = randomUUID();
  const importConfig = load('services/config-file.ts', { ...f, assertPortableCredentialBindings, TextEncoder, i18n: { t: key => key },
    useConfigStore: { setState: data => writes.push(['config', data]) }, usePromptSourceStore: { setState: data => writes.push(['prompts', data]) } }, 'importAppConfig');
  const importWork = importConfig({ text: () => file.promise }); let confirmed = false;
  const drain = f.barrier.drain(epoch).then(value => { confirmed = true; return value; });
  await Promise.resolve(); assert.equal(confirmed, false); assert.ok(f.registry.snapshot().storage > 0);
  file.resolve(JSON.stringify(configFile)); await importWork; await drain;
  assert.deepEqual(writes.map(item => item[0]), ['config', 'prompts']); assert.equal(f.registry.snapshot().storage, 0);
});
test('portable import rejects native account references and bound routes before either store changes', async () => {
  const f = createActivityFixture(); let writes = 0;
  const importConfig = load('services/config-file.ts', { ...f, assertPortableCredentialBindings, TextEncoder, i18n: { t: key => key },
    useConfigStore: { setState: () => { writes++; } }, usePromptSourceStore: { setState: () => { writes++; } } }, 'importAppConfig');
  const id = randomUUID();
  const mutations = [
    data => { data.config.apiKey = 'guan-vault:' + id; },
    data => { data.config.channels = [{ apiKey: ' GUAN-VAULT:' + id }]; },
    data => { data.webdav.password = 'guan-vault:' + id; },
    data => { data.config.baseUrl = 'http://127.0.0.1:5174/local-secure-api/' + id; },
    data => { data.config.channels = [{ baseUrl: '/local-secure-api/' + id }]; },
    data => { data.webdav.url = 'http://127.0.0.1:5174/old/../%6cocal-secure-api/' + id; },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(configFile); mutate(data);
    await assert.rejects(importConfig({ text: async () => JSON.stringify(data) }), /原配置未改变/);
    assert.equal(writes, 0); assert.equal(f.registry.snapshot().storage, 0);
  }
  // A prompt may mention a reference as plain content. It is not a credential.
  const normal = structuredClone(configFile);
  normal.config.systemPrompt = 'guan-vault: is a reference, not an API key';
  normal.config.channels = [{ apiKey: 'qa-legacy-value', baseUrl: 'https://api.example.com' }];
  await importConfig({ text: async () => JSON.stringify(normal) }); assert.equal(writes, 2);
});
test('invalid and oversized portable imports are bounded and cannot mutate stored configuration', async () => {
  const f = createActivityFixture(); let writes = 0, reads = 0;
  const importConfig = load('services/config-file.ts', { ...f, assertPortableCredentialBindings, TextEncoder, i18n: { t: key => key },
    useConfigStore: { setState: () => { writes++; } }, usePromptSourceStore: { setState: () => { writes++; } } }, 'importAppConfig');
  await assert.rejects(importConfig({ size: 4 * 1024 * 1024 + 1, text: async () => { reads++; return ''; } }), /config.invalidFile/);
  assert.equal(reads, 0);
  for (const text of ['null', '{broken', JSON.stringify({ ...configFile, config: { channels: {} } }),
    JSON.stringify({ ...configFile, config: { channels: [null] } }), JSON.stringify({ ...configFile, webdav: [] }),
    JSON.stringify({ ...configFile, promptSources: { sources: [], schedule: [] } }), '\u4e2d'.repeat(1400000)]) {
    await assert.rejects(importConfig({ text: async () => text }), /config.invalidFile/);
    assert.equal(writes, 0); assert.equal(f.registry.snapshot().storage, 0);
  }
});
test('configuration import cannot replace prompt store actions using extra JSON fields', async () => {
  const f = createActivityFixture(), action = () => 'kept', promptState = { addSource: action };
  const importConfig = load('services/config-file.ts', { ...f, assertPortableCredentialBindings, TextEncoder, i18n: { t: key => key },
    useConfigStore: { setState: () => {} }, usePromptSourceStore: { setState: data => Object.assign(promptState, data) } }, 'importAppConfig');
  const data = structuredClone(configFile); data.promptSources.addSource = 'untrusted replacement';
  await importConfig({ text: async () => JSON.stringify(data) });
  assert.equal(promptState.addSource, action);
  assert.deepEqual(Object.keys(promptState).sort(), ['addSource', 'schedule', 'sources']);
});
test('actual product import waits for all started file writes after a sibling fails and leaves projects untouched', async () => {
  const f = createActivityFixture(), pending = deferred(), replies = []; let listener, writes = 0, imported = 0;
  const parent = { postMessage: value => replies.push(value) }, project = { project: { id: 'fixture' }, files: [
    { path: 'failed', storageKey: 'image:failed', mimeType: 'image/png' }, { path: 'pending', storageKey: 'image:pending', mimeType: 'image/png' }] };
  // The listener checks instanceof File. A constructor shared with its VM
  // avoids inventing a fake admission/settle implementation for this test.
  const sharedFile = class {};
  load('services/product-recycle-bridge.ts', { ...f, window: { parent, addEventListener: (_type, callback) => { listener = callback; } },
    location: { origin: 'http://fixture.invalid' }, File: sharedFile, useCanvasStore: { getState: () => ({ hydrated: true, importProject: () => { imported++; } }) },
    readZip: async () => new Map([['projects.json', { text: async () => JSON.stringify({ projects: [project] }) }], ['failed', { type: 'image/png' }], ['pending', { type: 'image/png' }]]),
    setImageBlob: async key => { writes++; if (key.endsWith('failed')) throw Error('fixture write failure'); return pending.promise; },
  }, 'initProductRecycleBridge')();
  const work = listener({ origin: 'http://fixture.invalid', source: parent, data: { type: 'guan-canvas-import-project', file: new sharedFile(), requestId: 'fixture-request' } });
  while (writes !== 2) await Promise.resolve();
  assert.ok(f.registry.snapshot().storage > 0); assert.equal(replies.length, 0); assert.equal(imported, 0);
  pending.resolve(); await work; assert.equal(replies[0].ok, false); assert.equal(imported, 0); assert.equal(f.registry.snapshot().storage, 0);
  const epoch = randomUUID(); await f.barrier.drain(epoch);
  await listener({ origin: 'http://fixture.invalid', source: parent, data: { type: 'guan-canvas-create-project', requestId: 'fixture-new' } });
  assert.equal(replies.at(-1).ok, false); assert.match(replies.at(-1).error, /update_quiescing$/);
});
