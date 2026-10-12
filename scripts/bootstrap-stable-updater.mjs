import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { runtimePaths, privateDirectory, readPrivateFile } from '../src/server/runtime-paths.mjs';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { SignedUpdaterRuntime } from '../src/server/update-runtime.mjs';
import { OwnedUpdateService } from '../src/server/update-service.mjs';
import { SupervisedUpdateService, supervisorCapability } from '../src/server/update-supervisor.mjs';
import { UserLaunchdJobs, UpdaterDeployment } from '../src/server/update-deployment.mjs';
import { UpdateManagerClient } from '../src/server/update-manager-client.mjs';
import { UpdateTaskLedger } from '../src/server/update-task-ledger.mjs';
import { OperatorUpdateAuthority } from '../src/server/update-operator-authority.mjs';
import { ClosedBrowserCoordinator } from '../src/server/update-closed-browser-coordinator.mjs';
import { workbenchPageCensus } from '../src/server/workbench-page-census.mjs';
import { createMaintenanceBackup } from '../src/server/update-maintenance-backup.mjs';

// Trusted native installer, no HTTP invocation and no arbitrary shell/URL/path
// inputs. Preparing does not stop/start jobs. Bootstrap requires a new typed
// maintenance confirmation, an already stopped legacy service and actual backup.
async function main() {
  const [mode, downloadId, version] = process.argv.slice(2);
  if (process.platform !== 'darwin' || process.arch !== 'arm64'
    || (mode === '--upgrade-manager' ? process.argv.length !== 3 : process.argv.length !== 5
      || !['--prepare', '--bootstrap'].includes(mode)
      || !/^verified-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(downloadId || '')
      || !/^\d+\.\d+\.\d+$/.test(version || ''))) throw Error('update_bootstrap_arguments_invalid');
  const projectRoot = fileURLToPath(new URL('../', import.meta.url)), paths = runtimePaths({ projectRoot });
  const manager = new UpdateManager({ root: path.join(paths.root, 'installation'), dataRoot: paths.data, projectRoot,
    repository: 'MrGuAm/guan-ai-workbench' });
  const pointer = mode === '--upgrade-manager' ? await manager.readCurrent()
    : await manager.stage({ directory: path.join(paths.updates, 'packages', downloadId), version });
  if (!pointer) throw Error('update_bootstrap_required');
  const runtime = new SignedUpdaterRuntime({ directory: path.join(paths.root, 'updater-runtime'), manager });
  await runtime.prepare(pointer);
  if (mode === '--prepare') { console.log('Signed independent runtime prepared; no service or user data was changed.'); return; }
  const portProbe = new OwnedUpdateService({ versionsRoot: path.join(manager.root, 'versions'), dataRoot: paths.data,
    privateRoot: paths.root, verify: value => manager.verifyInstalled(value) });
  const closed = async () => {
    const value = await workbenchPageCensus();
    if (!value.workbenchPagesClosed || value.blockers.length) throw Error('install_browsers_running');
  };
  await closed();
  if (mode === '--upgrade-manager') {
    const ledger = new UpdateTaskLedger({ file: path.join(paths.updates, 'task-ledger.json'), version: pointer.version });
    const service = new SupervisedUpdateService({ socketPath: path.join(paths.updates, 's.sock'), capabilityFile: path.join(paths.updates, 'supervisor.capability') });
    const client = new UpdateManagerClient({ socketPath: path.join(paths.updates, 'u.sock') });
    const authority = new OperatorUpdateAuthority({ file: path.join(paths.updates, 'operator-consent.json'), manager, service, ledger });
    const grant = await authority.read();
    if (!grant || grant.state !== 'completed' || grant.next.id !== pointer.id || Date.now() > grant.expiresAt)
      throw Error('install_operator_confirmation_required');
    let managerStopped = false;
    const lease = { assertValid: async () => {
      await closed(); const current = await authority.read(), evidence = await ledger.snapshot();
      if (JSON.stringify(current) !== JSON.stringify(grant) || Date.now() > grant.expiresAt
        || evidence.pending || evidence.revision !== grant.ledgerRevision) throw Error('install_permit_invalid');
      if (!managerStopped) {
        const ready = await client.request({ op: 'service-ready' }, 10000);
        if (ready?.owned !== true || ready.currentVersion !== pointer.version) throw Error('service_ownership_lost');
      } else {
        const owned = await service.inspectOwned();
        if (owned.stopped || !owned.active || ['id', 'version', 'commit', 'buildId'].some(key => owned.pointer[key] !== pointer[key]))
          throw Error('service_ownership_lost');
      }
    } };
    const deployment = new UpdaterDeployment({ runtime, directory: path.join(paths.root, 'updater-deployment'),
      agents: path.join(homedir(), 'Library/LaunchAgents'), privateRoot: paths.root, logs: path.join(paths.root, 'logs/updater'),
      jobs: new UserLaunchdJobs(), onStep: async phase => { if (phase === 'manager-stopped') managerStopped = true; },
      health: async () => {
        for (let attempt = 0; attempt < 100; attempt++) { if ((await client.status()).state !== 'unavailable') return; await new Promise(resolve => setTimeout(resolve, 100)); }
        throw Error('updater_deployment_health_unconfirmed');
      } });
    try { await deployment.deploy(pointer, lease); console.log('Signed manager upgraded; supervisor/app ownership and private data were retained.'); }
    finally { service.disconnect(); }
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('install_operator_confirmation_required');
  if (await manager.readCurrent() !== null) throw Error('update_bootstrap_already_installed');
  // The independent daemon must not race this native first-handoff installer
  // for the supervisor controller or consent. Do not silently change preferences.
  const preferences = await readPrivateFile(path.join(paths.updates, 'preferences.json'), { maxBytes: 4096 });
  if (preferences !== null && JSON.parse(preferences).autoInstall !== false)
    throw Error('update_bootstrap_disable_auto_install_required');
  if (!await portProbe.isStopped()) throw Error('service_port_occupied');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try { answer = await input.question('请确认：旧服务已正常停止；所有工作台页面已关闭（其他网站可以保留）；画布已保存；生成、Agent、WebDAV 全部结束。输入「确认首次接管」继续：'); }
  finally { input.close(); }
  if (answer !== '确认首次接管') throw Error('install_operator_confirmation_required');
  const backup = await createMaintenanceBackup({ directory: path.join(paths.root, 'backups'), dataRoot: paths.data,
    browserRoot: path.join(homedir(), 'Library/Application Support/Google/Chrome') });
  await closed();
  const ledger = new UpdateTaskLedger({ file: path.join(paths.updates, 'task-ledger.json'), version });
  // Only the explicit first-maintenance boundary may seed an absent ledger.
  // Existing unknown records and crashed locks remain blocking and untouched.
  await privateDirectory(paths.updates); await ledger.initialize();
  if ((await ledger.snapshot()).pending) throw Error('install_tasks_pending');
  const capabilityFile = path.join(paths.updates, 'supervisor.capability');
  try { await lstat(capabilityFile); await supervisorCapability(capabilityFile); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await supervisorCapability(capabilityFile, { create: true }); }
  const service = new SupervisedUpdateService({ socketPath: path.join(paths.updates, 's.sock'), capabilityFile });
  const client = new UpdateManagerClient({ socketPath: path.join(paths.updates, 'u.sock') });
  const agents = path.join(homedir(), 'Library/LaunchAgents'); await mkdir(agents, { recursive: true, mode: 0o700 });
  const lease = { assertValid: async () => { await closed(); if ((await ledger.snapshot()).pending) throw Error('install_tasks_pending'); } };
  const deployment = new UpdaterDeployment({ runtime, directory: path.join(paths.root, 'updater-deployment'), agents,
    privateRoot: paths.root, logs: path.join(paths.root, 'logs/updater'), jobs: new UserLaunchdJobs(),
    health: async () => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if ((await client.status()).state !== 'unavailable') {
          try { await service.connect(); await service.inspectOwned(); return; }
          catch { service.disconnect(); }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('updater_deployment_health_unconfirmed');
    } });
  await deployment.deploy(pointer, lease);
  manager.service = service;
  const authority = new OperatorUpdateAuthority({ file: path.join(paths.updates, 'operator-consent.json'), manager, service, ledger });
  manager.coordinator = new ClosedBrowserCoordinator({ service, ledger, authority });
  try {
    await authority.approveBootstrap(pointer, { acknowledgement: 'saved-and-all-tasks-ended', backupVerified: backup.verified });
    await manager.bootstrap(pointer);
    console.log('Signed first handoff activated at http://127.0.0.1:5174; verified private/Chrome backup retained. No profile or configuration was reset.');
  } finally { service.disconnect(); }
}
main().catch(error => {
  console.error(/^(?:update|updater|install|service)_[a-z_]{1,80}$/.test(error?.message || '') ? error.message : 'update_bootstrap_safely_blocked');
  process.exitCode = 1;
});
