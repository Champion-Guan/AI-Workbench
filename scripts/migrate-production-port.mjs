// Native maintenance only. No HTTP/IPC endpoint invokes this installer.
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, copyFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runtimePaths, writePrivateFile, readPrivateFile } from '../src/server/runtime-paths.mjs';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { SignedUpdaterRuntime } from '../src/server/update-runtime.mjs';
import { UpdaterDeployment, UserLaunchdJobs } from '../src/server/update-deployment.mjs';
import { SupervisedUpdateService } from '../src/server/update-supervisor.mjs';
import { OperatorUpdateAuthority } from '../src/server/update-operator-authority.mjs';
import { ClosedBrowserCoordinator } from '../src/server/update-closed-browser-coordinator.mjs';
import { UpdateTaskLedger } from '../src/server/update-task-ledger.mjs';
import { UpdateManagerClient } from '../src/server/update-manager-client.mjs';
import { workbenchPageCensus } from '../src/server/workbench-page-census.mjs';

async function main() {
  const [mode, artifacts, backup] = process.argv.slice(2);
  const projectRoot = fileURLToPath(new URL('../', import.meta.url)), paths = runtimePaths({ projectRoot });
  if (!['prepare', 'install'].includes(mode) || process.argv.length !== 5 || !path.isAbsolute(artifacts || '')
    || path.dirname(backup || '') !== path.join(paths.root, 'backups') || !/^port8888-[a-f0-9-]{36}$/.test(path.basename(backup))) throw Error('port_migration_arguments');
  const receipt = JSON.parse(await readPrivateFile(path.join(backup, 'MIGRATION.json'), { maxBytes: 4096 }));
  if (receipt.phase !== 'browser-verified' || receipt.verified !== true || receipt.databases < 1 || receipt.records < 1) throw Error('port_migration_backup_unverified');
  if (createHash('sha256').update(await readFile(path.join(backup, 'browser-5174.json'))).digest('hex') !== receipt.sha256)
    throw Error('port_migration_backup_unverified');
  const manager = new UpdateManager({ root: path.join(paths.root, 'installation'), dataRoot: paths.data, projectRoot,
    repository: 'Champion-Guan/AI-Workbench', onStep: async phase => console.log(JSON.stringify({ phase })) });
  const manifest = JSON.parse(await readFile(path.join(artifacts, 'guan-stable-manifest.json')));
  const version = manifest.version; // Install the signed asset version, not the developer checkout version.
  const archive = path.join(artifacts, 'package.zip');
  try { await lstat(archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!/^guan-ai-workbench-v\d+\.\d+\.\d+-macos-arm64\.zip$/.test(manifest.packages[0]?.name || '')) throw Error('port_migration_artifact_invalid');
    await copyFile(path.join(artifacts, manifest.packages[0].name), archive, 1);
  }
  const next = await manager.stage({ directory: artifacts, version });
  const runtime = new SignedUpdaterRuntime({ directory: path.join(paths.root, 'updater-runtime'), manager });
  await runtime.prepare(next);
  if (mode === 'prepare') { console.log(JSON.stringify({ prepared: true, version, signed: true, productionChanged: false })); return; }
  const previous = await manager.readCurrent();
  const oldRoot = path.join(manager.root, 'versions', previous.id);
  const { workbenchPageCensus: oldCensus } = await import(path.join(oldRoot, 'src/server/workbench-page-census.mjs'));
  const closed = async () => {
    for (const census of [oldCensus, workbenchPageCensus]) {
      const result = await census(); if (!result.workbenchPagesClosed || result.blockers.length) throw Error('install_browsers_running');
    }
  };
  await closed();
  const saved = {};
  for (const file of ['installation/current.json', 'installation/transaction.json', 'updater-deployment/deployment.json', 'updates/operator-consent.json'])
    saved[file] = await readPrivateFile(path.join(paths.root, file), { maxBytes: 16384 });
  const deployment = new UpdaterDeployment({ runtime, directory: path.join(paths.root, 'updater-deployment'),
    agents: path.join(homedir(), 'Library/LaunchAgents'), privateRoot: paths.root, logs: path.join(paths.root, 'logs/updater'),
    jobs: new UserLaunchdJobs(), health: async () => {} });
  const old = await deployment.read(), oldManager = (await deployment.descriptors(old.next)).manager;
  const oldSupervisor = (await deployment.descriptors(old.supervisor)).supervisor;
  const upcoming = await deployment.descriptors(next);
  for (const [role, descriptor] of [['manager', oldManager], ['supervisor', oldSupervisor]]) {
    await deployment.plist(descriptor);
    if (!await deployment.jobs.inspect(deployment.labels[role], descriptor)) throw Error('service_ownership_lost');
    const prior = await readPrivateFile(path.join(backup, role + '.plist'), { maxBytes: 16384 });
    if (prior !== null && prior !== descriptor.bytes) throw Error('port_migration_backup_conflict');
    if (prior === null) await writePrivateFile(path.join(backup, role + '.plist'), descriptor.bytes, { exclusive: true });
  }
  const original = await readPrivateFile(path.join(backup, 'port-switch-original.json'), { maxBytes: 65536 });
  if (original !== null && original !== JSON.stringify(saved)) throw Error('port_migration_backup_conflict');
  if (original === null) await writePrivateFile(path.join(backup, 'port-switch-original.json'), JSON.stringify(saved), { exclusive: true });
  await closed(); await deployment.jobs.stop(deployment.labels.manager, oldManager);
  const serviceOptions = { socketPath: path.join(paths.updates, 's.sock'), capabilityFile: path.join(paths.updates, 'supervisor.capability') };
  let active = new SupervisedUpdateService(serviceOptions), switched = false, stopped = false;
  let supervisorStopped = false, supervisorWritten = false, managerWritten = false;
  const ledger = new UpdateTaskLedger({ file: path.join(paths.updates, 'task-ledger.json'), version });
  const wrapper = {
    requiredStartupProtocol: 1,
    inspectOwned: () => active.inspectOwned(), backendControl: command => active.backendControl(command),
    isStopped: () => active.isStopped(), recoverySafe: () => active.recoverySafe(),
    start: pointer => active.start(pointer), activate: pointer => active.activate(pointer),
    async stop(options) {
      console.log(JSON.stringify({ phase: 'owned-service-stop' }));
      await active.stop(options); stopped = true;
      if (!switched) {
        await closed(); active.disconnect();
        await deployment.jobs.stop(deployment.labels.supervisor, oldSupervisor);
        console.log(JSON.stringify({ phase: 'old-supervisor-stopped' }));
        supervisorStopped = true;
        await deployment.write(upcoming.supervisor, false, [oldSupervisor.bytes]);
        supervisorWritten = true;
        await deployment.write(upcoming.manager, false, [oldManager.bytes]);
        managerWritten = true;
        switched = true; // bootstrap may succeed even if its acknowledgement fails
        await deployment.jobs.start(deployment.labels.supervisor, upcoming.supervisor);
        console.log(JSON.stringify({ phase: 'new-supervisor-started' }));
        active = new SupervisedUpdateService(serviceOptions);
        for (let n = 0; n < 100; n++) {
          try { await active.inspectOwned(); return; } catch { active.disconnect(); await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        throw Error('service_supervisor_unavailable');
      }
    },
  };
  manager.service = wrapper;
  const authority = new OperatorUpdateAuthority({ file: path.join(paths.updates, 'operator-consent.json'), manager, service: wrapper, ledger, pageOnly: true });
  manager.coordinator = new ClosedBrowserCoordinator({ service: wrapper, ledger, authority, pageOnly: true,
    census: async () => { await closed(); return { workbenchPagesClosed: true, blockers: [] }; } });
  try {
    await authority.approve(next, 'saved-and-all-tasks-ended');
    const result = await manager.install(next);
    await writePrivateFile(deployment.file, JSON.stringify({ format: 1, phase: 'committed', previous: old.next, next, supervisor: next }));
    active.disconnect();
    await deployment.jobs.start(deployment.labels.manager, upcoming.manager);
    const client = new UpdateManagerClient({ socketPath: path.join(paths.updates, 'u.sock') });
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try { const value = await client.request({ op: 'service-ready' }, 1000); if (value.owned && value.currentVersion === version) { ready = true; break; } }
      catch { /* bounded wait for the newly pinned daemon */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw Error('port_migration_manager_health');
    await writePrivateFile(path.join(backup, 'PORT-SWITCH.json'), JSON.stringify({ ...result, origin: manager.origin, supervisorVersion: version, managerVersion: version }));
    console.log(JSON.stringify({ ...result, origin: manager.origin, managed: true, browserDataVerified: true }));
  } catch (error) {
    active.disconnect();
    // Keep immutable versions and browser copies. Rollback only startup/pointer
    // metadata after the owned app has been stopped; never restore user data.
    if (switched) {
      if (await deployment.jobs.inspect(deployment.labels.manager, upcoming.manager)) await deployment.jobs.stop(deployment.labels.manager, upcoming.manager);
      if (await deployment.jobs.inspect(deployment.labels.supervisor, upcoming.supervisor)) {
        active = new SupervisedUpdateService(serviceOptions);
        await active.stop({ allowed: [previous, next] }); active.disconnect();
        await deployment.jobs.stop(deployment.labels.supervisor, upcoming.supervisor);
      }
    }
    if (supervisorWritten) await deployment.write(oldSupervisor, false, [upcoming.supervisor.bytes]);
    if (managerWritten) await deployment.write(oldManager, false, [upcoming.manager.bytes]);
    for (const [file, bytes] of Object.entries(saved)) if (bytes !== null) await writePrivateFile(path.join(paths.root, file), bytes);
    if (supervisorStopped) await deployment.jobs.start(deployment.labels.supervisor, oldSupervisor);
    if (stopped || !switched) await deployment.jobs.start(deployment.labels.manager, oldManager);
    throw error;
  } finally { active.disconnect(); }
}
main().catch(error => { console.error(/^[a-z_]{1,80}$/.test(error?.message || '') ? error.message : 'port_migration_safely_stopped'); process.exitCode = 1; });
