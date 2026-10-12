import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, realpath, mkdir, readdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { UpdateTaskLedger } from '../src/server/update-task-ledger.mjs';
import { SignedUpdaterRuntime } from '../src/server/update-runtime.mjs';
import { UpdaterDeployment, UserLaunchdJobs } from '../src/server/update-deployment.mjs';
import { OperatorUpdateAuthority } from '../src/server/update-operator-authority.mjs';
import { SupervisedUpdateService, supervisorCapability } from '../src/server/update-supervisor.mjs';
import { UpdateManagerClient } from '../src/server/update-manager-client.mjs';
import { OwnedUpdateService } from '../src/server/update-service.mjs';
import { signedUpdateFixture, testSigningIdentity } from './helpers/signed-update.mjs';
import { localRuntime } from './helpers/owned-runtime.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('actual signed runtime + user launchd + operator consent + independent scheduler bootstrap, update and failed-start rollback', {
  timeout: 600000, skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-install-e2e-')));
  const privateRoot = path.join(base, 'p'), dataRoot = path.join(privateRoot, 'data'), updates = path.join(privateRoot, 'updates');
  const agents = path.join(base, 'agents');
  for (const dir of [dataRoot, updates, agents]) await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ['config', 'proxy', 'runtime']) await mkdir(path.join(dataRoot, name), { mode: 0o700 });
  const sentinel = path.join(dataRoot, 'business-sentinel'); await writeFile(sentinel, 'retain canvases/history/media/config');
  await writeFile(path.join(dataRoot, 'config/runtime.env'), '');
  await writeFile(path.join(dataRoot, 'proxy/profile.yaml'), 'proxies: []\nrules: []\n');
  await writeFile(path.join(dataRoot, 'proxy/state.json'), JSON.stringify({ version: 1, enabled: false, relayEnabled: false,
    source: null, cachedConfig: null, configName: 'isolated QA' }));
  await writeFile(path.join(dataRoot, 'runtime/image-relay-transports.json'), '{}');
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); assert.notEqual(port, 5174);
  const origin = `http://127.0.0.1:${port}`, signing = testSigningIdentity(), files = {};
  async function include(relative) {
    const target = new URL('../' + relative, import.meta.url);
    for (const entry of await readdir(target, { withFileTypes: true })) {
      const file = relative + '/' + entry.name;
      if (entry.isDirectory()) await include(file);
      else files[file] = await readFile(new URL('../' + file, import.meta.url));
    }
  }
  for (const relative of ['src/server', 'src/shared', 'scripts/lib', 'node_modules/undici']) await include(relative);
  for (const relative of ['scripts/run-update-manager.mjs', 'scripts/run-update-supervisor.mjs', 'scripts/run-browser-bridge.mjs'])
    files[relative] = await readFile(new URL('../' + relative, import.meta.url));
  // These three QA-only changes are inside a locally test-signed payload.
  // Never alter the source trust root, user browsers, production port or census.
  files['src/server/stable-trust.mjs'] = 'export const STABLE_TRUSTED_KEYS = Object.freeze(' + JSON.stringify(signing.keys) + ');';
  files['src/server/workbench-page-census.mjs'] = 'export async function workbenchPageCensus() { return { workbenchPagesClosed: true, blockers: [], inventoryVerified: false }; }';
  files['src/server/update-supervisor.mjs'] = files['src/server/update-supervisor.mjs'].toString()
    .replace('} catch (e) { reply({ ok: false,', '} catch (e) { console.error(publicError(e)); reply({ ok: false,');
  files['src/server/update-manager.mjs'] = files['src/server/update-manager.mjs'].toString()
    .replace('} catch {\n        let current;', '} catch (error) { console.error(/^(install|update|service)_[a-z_]+$/.test(error.message) ? error.message : "QA bootstrap failure");\n        let current;');
  for (const entry of ['scripts/run-update-manager.mjs', 'scripts/run-update-supervisor.mjs']) {
    files[entry] = files[entry].toString().replace("repository: 'Champion-Guan/guan-ai-workbench' });", "repository: 'Champion-Guan/guan-ai-workbench', origin: '" + origin + "' });");
  }
  files['scripts/run-update-supervisor.mjs'] = files['scripts/run-update-supervisor.mjs']
    .replace('privateRoot: paths.root, verify:', "privateRoot: paths.root, origin: '" + origin + "', disableProxy: true, startupTimeout: 30000, verify:");
  const manager = new UpdateManager({ root: path.join(privateRoot, 'installation'), dataRoot, repository: 'Champion-Guan/guan-ai-workbench',
    trustedKeys: signing.keys, origin, freeSpace: async () => 4e9 }); await manager.initialize();
  const executable = { runtime: (await localRuntime()).bytes, repository: manager.repository, files,
    backend: await readFile(new URL('../server.mjs', import.meta.url)), startup: '// actual startup in src/server' };
  const first = await manager.stage(await signedUpdateFixture(base, signing, '1.0.5', executable));
  const standalone = new OwnedUpdateService({ versionsRoot: path.join(manager.root, 'versions'), privateRoot, dataRoot, origin,
    disableProxy: true, verify: pointer => manager.verifyInstalled(pointer), startupTimeout: 10000 });
  await standalone.start({ ...first, directory: path.join(manager.root, 'versions', first.id), dataRoot, origin });
  await standalone.stop({ allowed: [first] });
  const nextInput = await signedUpdateFixture(base, signing, '1.0.6', executable);
  const brokenInput = await signedUpdateFixture(base, signing, '1.0.7', { ...executable, backend: 'process.exit(71);' });
  const runtime = new SignedUpdaterRuntime({ directory: path.join(base, 'updater-runtime'), manager }); await runtime.prepare(first);
  const ledger = new UpdateTaskLedger({ file: path.join(updates, 'task-ledger.json'), version: '1.0.5' }); await ledger.initialize();
  await supervisorCapability(path.join(updates, 'supervisor.capability'), { create: true });
  const preference = enabled => JSON.stringify({ version: 1, repository: manager.repository, autoCheck: false, autoDownload: false, autoInstall: enabled, network: 'direct' });
  await writeFile(path.join(updates, 'preferences.json'), preference(false), { mode: 0o600 });
  const service = new SupervisedUpdateService({ socketPath: path.join(updates, 's.sock'), capabilityFile: path.join(updates, 'supervisor.capability') });
  const client = new UpdateManagerClient({ socketPath: path.join(updates, 'u.sock'), timeoutMs: 5000 });
  const jobs = new UserLaunchdJobs(), suffix = '.qa.' + randomUUID();
  const deployment = new UpdaterDeployment({ runtime, directory: path.join(base, 'deployment'), agents, privateRoot,
    logs: path.join(base, 'logs'), jobs, suffix, health: async () => {
      for (let i = 0; i < 300; i++) {
        if ((await client.status()).state !== 'unavailable') {
          if (await manager.readCurrent()) return;
          try { await service.connect(); await service.inspectOwned(); return; }
          catch { service.disconnect(); }
        }
        await pause(100);
      }
      throw Error('QA daemon health timeout');
    } });
  let installed = false;
  t.after(async () => {
    service.disconnect();
    if (installed) {
      const receipt = await deployment.read();
      const managerDescriptor = (await deployment.descriptors(receipt.phase === 'committed' ? receipt.next : receipt.previous || first)).manager;
      const supervisorDescriptor = (await deployment.descriptors(receipt.supervisor)).supervisor;
      await jobs.stop(deployment.labels.manager, managerDescriptor);
      // Only this test's supervisor and signature-verified QA versions exist.
      let connected = false;
      for (let i = 0; i < 400; i++) { try { await service.connect(); connected = true; break; } catch {} await pause(100); }
      assert.equal(connected, true, 'QA supervisor controller must settle before cleanup');
      const current = await manager.readCurrent(), journal = await manager.readJournal();
      await service.stop({ allowed: journal ? [journal.previous, journal.next] : [current || first] });
      service.disconnect(); await jobs.stop(deployment.labels.supervisor, supervisorDescriptor);
    }
    await rm(base, { recursive: true, force: true });
  });
  await deployment.deploy(first, { assertValid: async () => {} }); installed = true;
  console.info('QA signed launchd deployment ready (isolated only)');
  manager.service = service;
  const authority = new OperatorUpdateAuthority({ file: path.join(updates, 'operator-consent.json'), manager, service, ledger });
  // Explicit QA operator + backup attestations; NOT a claim about real user data.
  await service.connect(); await authority.approveBootstrap(first, { acknowledgement: 'saved-and-all-tasks-ended', backupVerified: true });
  service.disconnect(); await pause(100);
  await writeFile(path.join(updates, 'preferences.json'), preference(true), { mode: 0o600 });
  async function waitTerminal(version, phase, consentState = 'completed') {
    for (let i = 0; i < 1200; i++) {
      const bootstrap = await manager.readBootstrap(), journal = await manager.readJournal();
      const consent = JSON.parse(await readFile(authority.file));
      if ((phase === 'activated' ? bootstrap?.phase : journal?.phase) === phase && consent.state === consentState) {
        const response = await fetch(origin + '/local-app/health'), health = await response.json();
        assert.equal(health.version, version); assert.equal(health.origin, origin); assert.equal(health.maintenance, false);
        assert.equal((await fetch(origin + '/')).status, 200); return health;
      }
      await pause(100);
    }
    const status = await client.status();
    const raw = await client.request({ op: 'status' }, 5000);
    assert.fail('QA scheduler did not reach terminal state: ' + JSON.stringify({ status, raw,
      bootstrap: (await manager.readBootstrap())?.phase, journal: (await manager.readJournal())?.phase,
      consent: JSON.parse(await readFile(authority.file)).state,
      logs: (await readFile(path.join(base, 'logs/supervisor-error.log'), 'utf8')).slice(-1000) }));
  }
  const initial = await waitTerminal('1.0.5', 'activated');
  console.info('QA confirmed native bootstrap passed');
  async function approve(input) {
    const downloadId = 'verified-' + randomUUID(); await cp(input.directory, path.join(updates, 'packages', downloadId), { recursive: true });
    await client.approve({ downloadId, version: input.version, repository: manager.repository }, 'saved-and-all-tasks-ended');
  }
  await approve(nextInput); const upgraded = await waitTerminal('1.0.6', 'committed'); assert.notEqual(initial.pid, upgraded.pid);
  console.info('QA confirmed native upgrade passed');
  const current = await manager.readCurrent(); await runtime.prepare(current);
  await deployment.deploy(current, { assertValid: async () => {} });
  const afterManagerUpgrade = await (await fetch(origin + '/local-app/health')).json();
  assert.equal(afterManagerUpgrade.pid, upgraded.pid, 'upgrading only manager must not restart/adopt the app');
  console.info('QA signed manager upgrade retained supervisor/app PID');
  await approve(brokenInput); await waitTerminal('1.0.6', 'rolled-back');
  console.info('QA actual failed-start rollback passed');
  // Simulate a clean logout/reboot of only these QA jobs. Pending evidence is
  // not cleared, and the independently signed manager may run only the already
  // settled current release, without authorising any new update.
  const receipt = await deployment.read();
  const managerDescriptor = (await deployment.descriptors(receipt.next)).manager;
  const supervisorDescriptor = (await deployment.descriptors(receipt.supervisor)).supervisor;
  await jobs.stop(deployment.labels.manager, managerDescriptor);
  await service.connect(); await service.stop({ allowed: [current] }); service.disconnect();
  await jobs.stop(deployment.labels.supervisor, supervisorDescriptor);
  await jobs.start(deployment.labels.supervisor, supervisorDescriptor);
  await jobs.start(deployment.labels.manager, managerDescriptor);
  let rebooted = false;
  for (let attempt = 0; attempt < 600; attempt++) {
    try { const h = await (await fetch(origin + '/local-app/health')).json();
      if (h.version === '1.0.6' && h.maintenance === false) { rebooted = true; break; }
    } catch {}
    await pause(100);
  }
  assert.equal(rebooted, true, 'completed current must resume after QA jobs reboot');
  console.info('QA settled current cold startup passed without another installation');
  assert.equal(await readFile(sentinel, 'utf8'), 'retain canvases/history/media/config');
  assert.equal((await ledger.snapshot()).pending, 0);
  // An active scheduler may still hold the cold-start lock after health becomes
  // ready. Respect that lock; retry only its explicit contention result.
  let recovered;
  const recoveryDeadline = Date.now() + 60000;
  while (!recovered) {
    try { recovered = await deployment.recover({ assertValid: async () => {} }); }
    catch (error) {
      if (error.message !== 'update_in_progress' || Date.now() >= recoveryDeadline) throw error;
      await pause(100);
    }
  }
  assert.equal(recovered.state, 'committed');
});
