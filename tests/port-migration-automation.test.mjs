import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { inspectMigrationPorts } from '../scripts/lib/port-migration-preflight.mjs';
import { migrationPackage } from '../scripts/lib/port-migration-package.mjs';

const refused = () => { throw Object.assign(Error(), { cause: { code: 'ECONNREFUSED' } }); };
const health = port => ({ ok: true, json: async () => ({ app: 'guan-ai-workbench', ready: true,
  maintenance: false, origin: `http://127.0.0.1:${port}`, version: '1.0.8' }) });
test('already migrated workbench is a no-op and does not access old origin', async () => {
  const calls = [];
  assert.deepEqual(await inspectMigrationPorts(async url => { calls.push(url); return health(8888); }), { state: 'already-migrated', version: '1.0.8' });
  assert.equal(calls.length, 1);
});
test('only a refused destination and healthy source permit migration', async () => {
  assert.equal((await inspectMigrationPorts(async url => url.includes(':8888/') ? refused() : health(5174))).state, 'ready');
  await assert.rejects(inspectMigrationPorts(async () => refused()), /source_service_missing/);
  await assert.rejects(inspectMigrationPorts(async () => { throw Error('timeout'); }), /port_state_unknown/);
  await assert.rejects(inspectMigrationPorts(async () => ({ ok: true, json: async () => ({ app: 'other' }) })), /port_occupied_unknown/);
});

test('automatic package retrieval is public, rejects old releases and rechecks signed inventory before use', async () => {
  const calls = [];
  class Downloader {
    constructor() { this.verified = { directory: '/fixture/verified' }; }
    async download(options) { calls.push(options); }
    status() { return { state: 'verified' }; }
  }
  const options = { updates: '/fixture/updates', currentVersion: '1.0.7', Downloader,
    readRelease: async options => { assert.equal(options.repository, 'Champion-Guan/infinite-canvas'); assert.equal(options.token, undefined); return { version: '1.0.8' }; },
    verify: async options => { assert.equal(options.archiveName, 'package.zip'); assert.equal(options.currentVersion, '1.0.7'); return { startupProtocol: 1 }; } };
  assert.deepEqual(await migrationPackage(options), { directory: '/fixture/verified', version: '1.0.8' });
  assert.equal(calls[0].token, undefined);
  await assert.rejects(migrationPackage({ ...options, readRelease: async () => ({ version: '1.0.7' }) }), /migration_version_invalid/);
  await assert.rejects(migrationPackage({ ...options, verify: async () => { throw Error('signature_invalid'); } }), /signature_invalid/);
  await assert.rejects(migrationPackage({ ...options, verify: async () => ({ startupProtocol: null }) }), /migration_startup_unsupported/);
  class Failed extends Downloader { status() { return { state: 'error' }; } }
  await assert.rejects(migrationPackage({ ...options, Downloader: Failed }), /migration_download_failed/);
});

async function background(existing = []) {
  const events = { addListener() {} }, actions = [], owned = new Map();
  let phase = 'waiting-source', next = 10;
  const url = 'http://127.0.0.1:8888/migration-12345678-1234-1234-1234-123456789abc';
  const context = vm.createContext({ URL, AbortSignal, crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
    setInterval() {}, clearInterval() {}, console,
    fetch: async (target, options) => {
      if (options?.method === 'POST' && target.endsWith('/status')) {
        assert.equal(target, url + '/status');
        const status = JSON.parse(options.body);
        assert.equal(status.version, '1.0.2');
        actions.push(['status', status.state]);
      }
      return { ok: true, json: async () => { assert.equal(target, 'http://127.0.0.1:8888/local-migration/session'); return { protocol: 1, migrationUrl: url, phase }; } };
    },
    chrome: { runtime: { id: 'test', onConnect: events, onStartup: events, onInstalled: events,
      connectNative: () => ({ onMessage: events, onDisconnect: events, postMessage() {} }) },
    action: { onClicked: events, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    windows: {}, webNavigation: { onCommitted: events, onHistoryStateUpdated: events, onErrorOccurred: events },
    tabs: { onCreated: events, onRemoved: events, onReplaced: events, onUpdated: events,
      query: async ({ url }) => typeof url === 'string' ? [] : existing,
      create: async value => { const tab = { id: next++, status: 'complete', ...value }; owned.set(tab.id, tab); actions.push(['create', value.url]); return tab; },
      get: async id => owned.get(id),
      sendMessage: async (id, value) => { assert.ok(owned.has(id)); actions.push(['export', value.url]); },
      remove: async id => { assert.ok(owned.has(id), 'never remove an unowned tab'); owned.delete(id); actions.push(['remove', id]); },
    } } });
  vm.runInContext(await readFile(new URL('../browser/managed-workbench/background.js', import.meta.url), 'utf8'), context);
  return { actions, owned, tick: () => vm.runInContext('migrationTick()', context), phase: value => { phase = value; } };
}
test('extension copies through temporary tabs and closes only tabs it created', async () => {
  const client = await background(); await client.tick();
  assert.equal(client.actions.find(x => x[0] === 'create')[1], 'http://127.0.0.1:5174/local-app/health');
  assert.ok(client.actions.some(x => x[0] === 'status' && x[1] === 'export-requested'));
  assert.ok(client.actions.some(x => x[0] === 'export'));
  await client.tick(); assert.equal(client.actions.filter(x => x[0] === 'export').length, 1);
  client.phase('source-backed-up'); await client.tick();
  assert.equal(client.owned.size, 1);
  client.phase('browser-verified'); await client.tick(); assert.equal(client.owned.size, 0);
});
test('open customer workbench pages prevent automatic export and tab closure', async () => {
  const client = await background([{ id: 99 }]); await client.tick();
  assert.deepEqual(client.actions.filter(x => x[0] !== 'status'), []);
  assert.ok(client.actions.some(x => x[0] === 'status' && x[1] === 'pages-open'));
});
test('a temporary tab navigated into a customer canvas must not be closed', async () => {
  const client = await background(); await client.tick();
  const source = [...client.owned.values()][0]; source.url = 'http://127.0.0.1:5174/canvas/customer';
  client.phase('source-backed-up'); await client.tick();
  assert.equal(client.owned.size, 1); assert.equal(client.actions.filter(x => x[0] === 'remove').length, 0);
});
test('relay refuses foreign origin, wrong page and malformed export destinations', async () => {
  let listener; const scripts = [];
  const location = { origin: 'http://127.0.0.1:5174', pathname: '/local-app/health' };
  const window = {}; window.top = window;
  const context = vm.createContext({ URL, location, window, chrome: { runtime: { id: 'ours', onMessage: { addListener: value => { listener = value; } } } },
    document: { createElement: () => ({}), documentElement: { appendChild: value => scripts.push(value) } } });
  vm.runInContext(await readFile(new URL('../browser/managed-workbench/migration-relay.js', import.meta.url), 'utf8'), context);
  const valid = { op: 'guan-port-migration-export', url: 'http://127.0.0.1:8888/migration-12345678-1234-1234-1234-123456789abc/export.js' };
  listener(valid, { id: 'foreign' }); listener({ ...valid, url: 'https://example.com/export.js' }, { id: 'ours' });
  location.pathname = '/'; listener(valid, { id: 'ours' }); assert.equal(scripts.length, 0);
  location.pathname = '/local-app/health'; listener(valid, { id: 'ours' }); assert.equal(scripts.length, 1);
});
