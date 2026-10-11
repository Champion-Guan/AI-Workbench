import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createUpdateStartup } from '../src/server/update-startup.mjs';

test('startup quarantine only accepts the exact parent IPC nonce and blocks all business routes', () => {
  const parent = new EventEmitter(), sent = []; parent.send = message => sent.push(message);
  const nonce = randomUUID(), env = { GUAN_UPDATE_QUARANTINE: '1', GUAN_UPDATE_NONCE: nonce }; let activated = 0;
  const startup = createUpdateStartup({ env, parent, onActivate: () => { activated++; } });
  assert.deepEqual(env, {}); assert.equal(startup.quarantined(), true);
  let status; const response = { writeHead: s => { status = s; }, end() {} };
  for (const route of ['/', '/local-app/updates/status', '/local-proxy/toggle', '/canvas/qa']) {
    assert.equal(startup.reject({ method: 'GET' }, response, route), true); assert.equal(status, 503);
  }
  assert.equal(startup.reject({ method: 'GET' }, response, '/local-app/health'), false);
  assert.equal(startup.reject({ method: 'POST' }, response, '/local-app/health'), true);
  for (const message of [{ op: 'guan-update-activate', nonce: randomUUID() }, { op: 'guan-update-activate', nonce, extra: true }, { op: 'other', nonce }]) parent.emit('message', message);
  assert.equal(startup.quarantined(), true); assert.equal(activated, 0);
  parent.emit('message', { op: 'guan-update-activate', nonce }); parent.emit('message', { op: 'guan-update-activate', nonce });
  assert.equal(activated, 1); assert.equal(startup.quarantined(), false); assert.equal(sent.length, 2);
});
test('normal launch is unchanged; requested quarantine without a real parent fails closed', () => {
  assert.equal(createUpdateStartup({ env: {} }).quarantined(), false);
  assert.throws(() => createUpdateStartup({ env: { GUAN_UPDATE_QUARANTINE: '1', GUAN_UPDATE_NONCE: randomUUID() }, parent: new EventEmitter() }), /startup_invalid/);
});
test('IPC acknowledgement failure after activation does not crash or re-quarantine an active version', () => {
  const parent = new EventEmitter(); parent.send = () => { throw Error('parent disconnected'); };
  const nonce = randomUUID(), startup = createUpdateStartup({ env: { GUAN_UPDATE_QUARANTINE: '1', GUAN_UPDATE_NONCE: nonce }, parent });
  assert.doesNotThrow(() => parent.emit('message', { op: 'guan-update-activate', nonce }));
  assert.equal(startup.quarantined(), false);
});
test('real isolated backend starts quarantined, exposes only health, and activates over inherited IPC', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'guan-startup-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['config', 'proxy', 'runtime']) await mkdir(path.join(root, 'data', name), { recursive: true });
  // Seed all copy-once files. No real credentials, subscriptions or proxy core.
  for (const [file, bytes] of [['config/runtime.env', ''], ['proxy/profile.yaml', 'proxies: []\nrules: []\n'],
    ['proxy/state.json', JSON.stringify({ version: 1, enabled: false, relayEnabled: false, source: null, cachedConfig: null, configName: 'QA' })],
    ['runtime/image-relay-transports.json', '{}']]) await writeFile(path.join(root, 'data', file), bytes);
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); assert.notEqual(port, 5174);
  const origin = `http://127.0.0.1:${port}`, nonce = randomUUID();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: '/usr/bin:/bin', PORT: String(port), GUAN_WORKBENCH_DATA_DIR: root,
      IMAGE_RELAY_MIHOMO_DISABLED: 'true', IMAGE_RELAY_MIHOMO_AUTO_DOWNLOAD: 'false', GUAN_UPDATE_QUARANTINE: '1', GUAN_UPDATE_NONCE: nonce } });
  const ended = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await ended; } });
  let health;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(origin + '/local-app/health', { signal: AbortSignal.timeout(300) }); if (r.ok) { health = await r.json(); break; } }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(health?.pid, child.pid); assert.equal(health.maintenance, true); assert.equal(health.ready, true);
  for (const route of ['/', '/canvas/qa', '/local-app/activity', '/local-app/updates/status', '/local-proxy/toggle'])
    assert.equal((await fetch(origin + route)).status, 503);
  child.send({ op: 'guan-update-activate', nonce: randomUUID() });
  assert.equal((await fetch(origin + '/')).status, 503);
  const ack = once(child, 'message'); child.send({ op: 'guan-update-activate', nonce });
  assert.deepEqual((await ack)[0], { op: 'guan-update-activated', nonce });
  assert.equal((await (await fetch(origin + '/local-app/health')).json()).maintenance, false);
  assert.equal((await fetch(origin + '/')).status, 200);
  const status = await (await fetch(origin + '/local-app/updates/status', { headers: { origin } })).json();
  assert.equal(status.install.allowed, false); assert.equal(status.preferences.autoInstall, false);
});
