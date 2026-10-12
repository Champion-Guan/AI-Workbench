import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, copyFile } from 'node:fs/promises';
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
import { migrationInstallationMode, inspectPortableService, stopPortableService, verifyPortableBackup } from './lib/portable-handoff.mjs';
import { compareVersions } from '../src/server/stable-version.mjs';

// Trusted native installer, no HTTP invocation and no arbitrary shell/URL/path
// inputs. Preparing does not stop/start jobs. Bootstrap requires a new typed
// maintenance confirmation, an already stopped legacy service and actual backup.
async function main() {
  const [mode, downloadId, argument] = process.argv.slice(2);
  const migration = mode === '--migration-bootstrap';
  let version = argument;
  if (process.platform !== 'darwin' || process.arch !== 'arm64'
    || (migration ? process.argv.length !== 5 || !path.isAbsolute(downloadId || '') || !path.isAbsolute(argument || '')
      : mode === '--upgrade-manager' ? process.argv.length !== 3 : process.argv.length !== 5
      || !['--prepare', '--bootstrap'].includes(mode)
      || !/^verified-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(downloadId || '')
      || !/^\d+\.\d+\.\d+$/.test(version || ''))) throw Error('update_bootstrap_arguments_invalid');
  const projectRoot = fileURLToPath(new URL('../', import.meta.url)), paths = runtimePaths({ projectRoot });
  let backup, legacy;
  if (migration) {
    if (await migrationInstallationMode(paths.root) !== 'portable') throw Error('update_bootstrap_already_installed');
    backup = await verifyPortableBackup(argument, paths);
    legacy = JSON.parse(await readPrivateFile(path.join(argument, 'PORTABLE-SERVICE.json'), { maxBytes: 16384 }));
    if (JSON.stringify(await inspectPortableService({ version: legacy.version, privateRoot: paths.root })) !== JSON.stringify(legacy))
      throw Error('migration_service_identity_changed');
    const manifest = JSON.parse(await readFile(path.join(downloadId, 'guan-stable-manifest.json'), 'utf8'));
    version = manifest.version;
    if (compareVersions(version, '1.0.8') < 0 || compareVersions(version, legacy.version) <= 0)
      throw Error('migration_version_invalid');
    try { await lstat(path.join(downloadId, 'package.zip')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!/^(?:AI-Workbench|guan-ai-workbench)-v\d+\.\d+\.\d+-macos-arm64\.zip$/.test(manifest.packages[0]?.name || '')) throw Error('migration_artifact_invalid');
      await copyFile(path.join(downloadId, manifest.packages[0].name), path.join(downloadId, 'package.zip'), 1);
    }
  }
  const manager = new UpdateManager({ root: path.join(paths.root, 'installation'), dataRoot: paths.data, projectRoot,
    repository: 'Champion-Guan/AI-Workbench' });
  const pointer = mode === '--upgrade-manager' ? await manager.readCurrent()
    : await manager.stage({ directory: migration ? downloadId : path.join(paths.updates, 'packages', downloadId), version });
  if (!pointer) throw Error('update_bootstrap_required');
  const runtime = new SignedUpdaterRuntime({ directory: path.join(paths.root, 'updater-runtime'), manager });
  await runtime.prepare(pointer);
  if (mode === '--prepare') { console.log('Signed independent runtime prepared; no service or user data was changed.'); return; }
  const portProbe = new OwnedUpdateService({ versionsRoot: path.join(manager.root, 'versions'), dataRoot: paths.data,
    privateRoot: paths.root, verify: value => manager.verifyInstalled(value) });
  const closed = async () => {
    const value = await workbenchPageCensus({ ports: migration ? [5174, 8888] : [8888] });
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
  if (!migration && (!process.stdin.isTTY || !process.stdout.isTTY)) throw Error('install_operator_confirmation_required');
  if (await manager.readCurrent() !== null) throw Error('update_bootstrap_already_installed');
  // The independent daemon must not race this native first-handoff installer
  // for the supervisor controller or consent. Do not silently change preferences.
  const preferences = await readPrivateFile(path.join(paths.updates, 'preferences.json'), { maxBytes: 4096 });
  if (preferences !== null && JSON.parse(preferences).autoInstall !== false)
    throw Error('update_bootstrap_disable_auto_install_required');
  if (!await portProbe.isStopped()) throw Error('service_port_occupied');
  if (!migration) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try { answer = await input.question('请确认：旧服务已正常停止；所有工作台页面已关闭（其他网站可以保留）；画布已保存；生成、Agent、WebDAV 全部结束。输入「确认首次接管」继续：'); }
  finally { input.close(); }
  if (answer !== '确认首次接管') throw Error('install_operator_confirmation_required');
  backup = await createMaintenanceBackup({ directory: path.join(paths.root, 'backups'), dataRoot: paths.data,
    browserRoot: path.join(homedir(), 'Library/Application Support/Google/Chrome') });
  }
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
  // Prepare and validate descriptors before the only signal to the legacy app.
  const descriptors = await deployment.descriptors(pointer);
  for (const role of ['manager', 'supervisor']) {
    if (await deployment.jobs.inspect(deployment.labels[role], descriptors[role])) throw Error('updater_deployment_job_exists');
    // Refuse even an unloaded existing plist; never overwrite another installation.
    try { await lstat(descriptors[role].plist); throw Error('updater_deployment_job_conflict'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (migration) {
    await verifyPortableBackup(argument, paths);
    await stopPortableService(legacy, { closed, inspect: () => inspectPortableService({ version: legacy.version, privateRoot: paths.root }) });
    try {
      await fetch('http://127.0.0.1:5174/local-app/health', { signal: AbortSignal.timeout(2000), redirect: 'error' });
      throw Error('migration_legacy_port_not_released');
    } catch (error) { if (error?.cause?.code !== 'ECONNREFUSED') throw Error('migration_legacy_port_not_released'); }
    console.log('已正常停止核实过的 5174 服务，开始首次接管。旧便携目录和浏览器数据保留。');
  }
  manager.service = service;
  const authority = new OperatorUpdateAuthority({ file: path.join(paths.updates, 'operator-consent.json'), manager, service, ledger, pageOnly: migration });
  manager.coordinator = new ClosedBrowserCoordinator({ service, ledger, authority, pageOnly: migration,
    census: async () => { await closed(); return { workbenchPagesClosed: true, blockers: [] }; } });
  try {
    await deployment.deploy(pointer, lease);
    await authority.approveBootstrap(pointer, { acknowledgement: 'saved-and-all-tasks-ended', backupVerified: backup.verified });
    await manager.bootstrap(pointer);
    const ready = await client.request({ op: 'service-ready' }, 10000);
    if (!ready?.owned || ready.currentVersion !== version) throw Error('service_ownership_lost');
    console.log('Signed first handoff activated at http://127.0.0.1:8888; verified private/Chrome backup retained. No profile or configuration was reset.');
  } catch (error) {
    if (migration) {
      // Before the app pointer commits, a proven stopped service permits exact
      // initial-deployment rollback. After commit, reconciliation takes priority.
      try {
        if (!await manager.readCurrent() && await service.isStopped()) {
          const record = await deployment.read();
          if (record && record.previous === null && record.phase === 'committed') await deployment.rollback(record, lease);
        }
      } catch { console.error('独立服务停止状态尚未核实，保留全部记录，请勿另启动旧服务。'); }
      // No blind legacy restart after an uncertain commit: retain the journal
      // and immutable versions for reconciliation, never restore user data.
      console.error(`首次接管未完成。旧便携目录：${legacy.directory}\n备份：${argument}\n不要重复迁移或清空 8888 数据；确认新服务已停止后可从旧目录启动 5174。`);
    }
    throw error;
  } finally { service.disconnect(); }
}
main().catch(error => {
  console.error(/^(?:update|updater|install|service)_[a-z_]{1,80}$/.test(error?.message || '') ? error.message : 'update_bootstrap_safely_blocked');
  process.exitCode = 1;
});
