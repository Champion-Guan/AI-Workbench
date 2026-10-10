import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-mihomo.mjs', import.meta.url));
const profile = 'proxies: []\nrules:\n  - MATCH,DIRECT\n# fixture-secret-do-not-expose\n';
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
async function freePort() {
  const server = netServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function portPair() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await freePort();
    const probe = netServer();
    try {
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port + 1, '127.0.0.1', resolve); });
      await new Promise(resolve => probe.close(resolve));
      return port;
    } catch {}
  }
  throw new Error('No test port pair available');
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'guan-runtime-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const sub of ['config', 'proxy', 'runtime']) await mkdir(path.join(root, 'data', sub), { recursive: true });
  // Seed every destination: never copy the developer's actual private files.
  await writeFile(path.join(root, 'data/config/runtime.env'), '');
  await writeFile(path.join(root, 'data/proxy/profile.yaml'), profile);
  await writeFile(path.join(root, 'data/runtime/image-relay-transports.json'), '{}');
  const stateFile = path.join(root, 'data/proxy/state.json');
  await writeFile(stateFile, JSON.stringify({ version: 1, enabled: false, relayEnabled: true, source: null, cachedConfig: null, configName: 'fixture.yaml' }));
  await chmod(fake, 0o700);
  const reservedApp = netServer();
  await new Promise(resolve => reservedApp.listen(0, '127.0.0.1', resolve));
  const appPort = reservedApp.address().port;
  let proxyPort;
  try { proxyPort = await portPair(); }
  finally { await new Promise(resolve => reservedApp.close(resolve)); }
  assert.notEqual(appPort, 5174);
  assert.notEqual(appPort, proxyPort);
  assert.notEqual(appPort, proxyPort + 1);
  const origin = `http://127.0.0.1:${appPort}`;
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([exit, new Promise((_, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Test service did not stop safely')); }, 8000);
      timer.unref();
      exit.finally(() => clearTimeout(timer));
    })]);
  }
  t.after(stop);
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, PORT: String(appPort), GUAN_WORKBENCH_DATA_DIR: root,
      IMAGE_RELAY_PROXY_PORT: String(proxyPort), IMAGE_RELAY_MIHOMO_BIN: fake,
      IMAGE_RELAY_MIHOMO_AUTO_DOWNLOAD: 'false', IMAGE_RELAY_MIHOMO_CONFIG_FILE: '',
      IMAGE_RELAY_SUBSCRIPTION_FILE: '', IMAGE_RELAY_SUBSCRIPTION_URL: '', IMAGE_RELAY_SUBSTORE_API_URL: '',
    } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error('Isolated service failed to start');
      try {
        const response = await fetch(`${origin}/local-app/health`);
        if (response.ok) return { health: await response.json(), output: () => output };
      } catch {}
      await pause();
    }
    throw new Error('Isolated service health timeout');
  }
  async function post(route, payload) {
    const response = await fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(payload) });
    const text = await response.text();
    assert.ok(!text.includes('fixture-secret-do-not-expose'));
    return { status: response.status, body: JSON.parse(text) };
  }
  return { root, stateFile, origin, start, stop, post };
}

test('real isolated server persists proxy configuration, rolls back failure, serializes toggles and restarts offline', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const first = await f.start();
  assert.equal(first.health.proxy.running, false);
  assert.equal(first.health.origin, f.origin);
  const activity = await (await fetch(f.origin + '/local-app/activity')).json();
  assert.equal(activity.unknown, true, 'legacy frontend coverage cannot authorize an install');
  assert.equal(activity.canInstall, false);
  assert.equal((await fetch(f.origin + '/local-app/activity', { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await fetch(f.origin + '/local-app/activity', { method: 'POST' })).status, 405);
  assert.equal((await fetch(f.origin + '/local-app/health', { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  const malformed = await fetch(f.origin + '/local-proxy/config', { method: 'POST', headers: { 'content-type': 'application/json', origin: f.origin }, body: '{"configText":"fixture-secret-do-not-expose\n"}' });
  assert.equal(malformed.status, 400);
  assert.ok(!(await malformed.text()).includes('fixture-secret-do-not-expose'));
  assert.equal((await f.post('/local-proxy/config', { configText: profile, fileName: 'private.yaml' })).status, 200);
  const before = await readFile(f.stateFile, 'utf8');
  const failed = await f.post('/local-proxy/config', { configText: profile + '\n# FAIL_FAKE_CORE' });
  assert.equal(failed.status, 400);
  assert.equal(await readFile(f.stateFile, 'utf8'), before);
  assert.equal((await (await fetch(f.origin + '/local-app/health')).json()).proxy.running, true);
  const toggles = await Promise.all(Array.from({ length: 3 }, () => f.post('/local-proxy/toggle', { enabled: true })));
  assert.ok(toggles.every(result => result.status === 200));
  assert.equal((await f.post('/local-proxy/toggle', { enabled: false, relay: true })).status, 200);
  await f.stop();
  const second = await f.start();
  assert.notEqual(second.health.instanceId, first.health.instanceId);
  assert.equal(second.health.proxy.running, true);
  const status = await (await fetch(f.origin + '/local-proxy/config')).json();
  assert.equal(status.relayEnabled, false);
  assert.equal(status.configName, 'private.yaml');
  assert.equal((await f.post('/local-proxy/toggle', { enabled: false })).status, 200);
  await f.stop();
  assert.equal((await f.start()).health.proxy.running, false);
  const subscription = createServer((req, res) => res.end(profile));
  await new Promise(resolve => subscription.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${subscription.address().port}/subscription`;
  t.after(() => new Promise(resolve => subscription.close(resolve)));
  assert.equal((await f.post('/local-proxy/config', { subscriptionUrl: url })).status, 200);
  subscription.closeAllConnections();
  await new Promise(resolve => subscription.close(resolve));
  await f.stop();
  assert.equal((await f.start()).health.proxy.running, true, 'cached subscription must work offline');
  assert.equal((await f.post('/local-proxy/toggle', { enabled: false })).status, 200);
  assert.equal((await f.post('/local-proxy/toggle', { enabled: true })).status, 200, 'offline re-enable must use cache');
  const saved = JSON.parse(await readFile(f.stateFile, 'utf8'));
  assert.deepEqual(saved.source, { kind: 'url', value: url });
  assert.equal(saved.cachedConfig, profile);
  assert.ok(!first.output().includes('fixture-secret-do-not-expose'));
});

test('corrupt private state is retained and blocks mutations without preventing local service startup', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(f.stateFile, '{broken-private-state');
  const { health } = await f.start();
  assert.equal(health.proxy.stateReadable, false);
  assert.equal(health.proxy.running, false);
  assert.equal((await f.post('/local-proxy/toggle', { enabled: true })).status, 400);
  assert.equal((await f.post('/local-proxy/config', { configText: profile })).status, 400);
  assert.equal(await readFile(f.stateFile, 'utf8'), '{broken-private-state');
});

test('browser reports are bounded same-origin diagnostics and can never authorize installation', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.start();
  const payload = { protocol: 1, pageId: '11111111-1111-4111-8111-111111111111', sequence: 0,
    counts: { canvas: 2, workbench: 0, agent: 1, webdav: 0, storage: 3 } };
  const post = (body, origin = f.origin, contentType = 'application/json') => fetch(f.origin + '/local-app/activity/report', {
    method: 'POST', headers: { 'content-type': contentType, ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await post(payload, 'https://untrusted.invalid')).status, 403);
  assert.equal((await post(payload, '')).status, 403);
  assert.equal((await post(payload, f.origin, 'text/plain')).status, 415);
  assert.equal((await post(payload)).status, 204);
  assert.equal((await post(payload)).status, 400);
  const forged = await post({ ...payload, sequence: 1, canInstall: true, token: 'fixture-secret-do-not-expose' });
  assert.equal(forged.status, 400);
  assert.ok(!(await forged.text()).includes('fixture-secret-do-not-expose'));
  const activity = await (await fetch(f.origin + '/local-app/activity')).json();
  assert.equal(activity.observedBrowser.pages, 1);
  assert.equal(activity.observedBrowser.counts.canvas, 2);
  assert.equal(activity.observedBrowser.counts.storage, 3);
  assert.equal(activity.unknown, true);
  assert.equal(activity.canInstall, false);
  assert.equal((await post({ ...payload, sequence: 1, counts: { canvas: 0, workbench: 0, agent: 0, webdav: 0, storage: 0 } })).status, 204);
  assert.equal((await (await fetch(f.origin + '/local-app/activity')).json()).canInstall, false, 'all self-reported zeros are not a trusted inventory');
});

test('state persistence failure restores the previous proxy switch and never follows a config symlink', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.start();
  const before = await readFile(f.stateFile, 'utf8');
  const retained = path.join(f.root, 'retained-state.json');
  await rename(f.stateFile, retained);
  await symlink(retained, f.stateFile);
  const result = await f.post('/local-proxy/toggle', { enabled: true });
  assert.equal(result.status, 400);
  assert.equal((await (await fetch(f.origin + '/local-app/health')).json()).proxy.running, false);
  assert.equal(await readFile(retained, 'utf8'), before);
});
