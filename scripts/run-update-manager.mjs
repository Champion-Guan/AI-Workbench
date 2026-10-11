import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from '../src/server/runtime-paths.mjs';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { serveUpdateManager } from '../src/server/update-manager-ipc.mjs';
import { SupervisedUpdateService } from '../src/server/update-supervisor.mjs';

// Stable, independently launched entry point. Never loads user runtime.env or
// invokes shell commands; full installation remains closed until stage-5's
// authoritative coordinator and first-service handoff are wired and verified.
async function main() {
  if (process.argv.length !== 2 || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error();
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const paths = runtimePaths({ projectRoot });
  const manager = new UpdateManager({ root: path.join(paths.root, 'installation'), dataRoot: paths.data,
    projectRoot, repository: 'MrGuAm/guan-ai-workbench' });
  await manager.initialize();
  // Lazy connection: read-only diagnostics/staging remain available if the
  // separately installed owner is absent. No PID/port fallback is allowed.
  manager.service = new SupervisedUpdateService({ socketPath: path.join(paths.updates, 's.sock'),
    capabilityFile: path.join(paths.updates, 'supervisor.capability') });
  const ipc = await serveUpdateManager({ manager, socketPath: path.join(paths.updates, 'u.sock'), downloadsDirectory: path.join(paths.updates, 'packages') });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await ipc.close(); manager.service.disconnect(); };
  process.on('SIGTERM', () => { void close(); }); process.on('SIGINT', () => { void close(); });
  console.log('Independent update manager ready; installation remains disabled.');
}
main().catch(() => { console.error('Update manager refused to start safely; existing software and user data were not changed.'); process.exitCode = 1; });
