import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from '../src/server/runtime-paths.mjs';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { serveUpdateManager } from '../src/server/update-manager-ipc.mjs';
import { SupervisedUpdateService } from '../src/server/update-supervisor.mjs';
import { UpdateTaskLedger } from '../src/server/update-task-ledger.mjs';
import { OperatorUpdateAuthority } from '../src/server/update-operator-authority.mjs';
import { ClosedBrowserCoordinator } from '../src/server/update-closed-browser-coordinator.mjs';
import { UpdateInstallScheduler } from '../src/server/update-install-scheduler.mjs';
import { startSettledCurrent } from '../src/server/update-settled-startup.mjs';

// Stable, independently launched entry point. Never loads user runtime.env or
// invokes shell commands; full installation remains closed until stage-5's
// authoritative coordinator and first-service handoff are wired and verified.
async function main() {
  if (process.argv.length !== 2 || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error();
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const paths = runtimePaths({ projectRoot });
  const manager = new UpdateManager({ root: path.join(paths.root, 'installation'), dataRoot: paths.data,
    projectRoot, repository: 'Champion-Guan/infinite-canvas' });
  await manager.initialize();
  // Lazy connection: read-only diagnostics/staging remain available if the
  // separately installed owner is absent. No PID/port fallback is allowed.
  manager.service = new SupervisedUpdateService({ socketPath: path.join(paths.updates, 's.sock'),
    capabilityFile: path.join(paths.updates, 'supervisor.capability') });
  // Read-only access to existing durable task evidence. An absent/corrupt
  // ledger is NOT silently seeded by an automatic daemon startup.
  const ledger = new UpdateTaskLedger({ file: path.join(paths.updates, 'task-ledger.json'), version: '1.0.5' });
  const authority = new OperatorUpdateAuthority({ file: path.join(paths.updates, 'operator-consent.json'), manager,
    service: manager.service, ledger, pageOnly: true });
  manager.coordinator = new ClosedBrowserCoordinator({ service: manager.service, ledger, authority, pageOnly: true });
  manager.operator = authority;
  const scheduler = new UpdateInstallScheduler({ manager, authority, preferencesFile: path.join(paths.updates, 'preferences.json'),
    onInstalled: () => promisify(execFile)('/usr/bin/open', ['http://localhost:8888'], { timeout: 10000 }),
    restoreCurrent: () => startSettledCurrent({ manager, authority, ledger }) });
  manager.scheduler = scheduler;
  const ipc = await serveUpdateManager({ manager, socketPath: path.join(paths.updates, 'u.sock'), downloadsDirectory: path.join(paths.updates, 'packages') });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await scheduler.stop(); await ipc.close(); manager.service.disconnect(); };
  process.on('SIGTERM', () => { void close(); }); process.on('SIGINT', () => { void close(); });
  scheduler.start();
  console.log('Independent update manager ready; installation requires per-update confirmation and closed workbench pages.');
}
main().catch(() => { console.error('Update manager refused to start safely; existing software and user data were not changed.'); process.exitCode = 1; });
