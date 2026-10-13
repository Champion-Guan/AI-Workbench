import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from '../src/server/runtime-paths.mjs';
import { UpdateManager } from '../src/server/update-manager.mjs';
import { OwnedUpdateService } from '../src/server/update-service.mjs';
import { serveUpdateSupervisor, supervisorCapability } from '../src/server/update-supervisor.mjs';

// Installed independently of both current application and manager versions.
// Capability provisioning and first launch belong to the approved bootstrap,
// never to a browser request. No runtime.env, adoption or automatic activation.
async function main() {
  if (process.argv.length !== 2 || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error();
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const paths = runtimePaths({ projectRoot });
  const verifier = new UpdateManager({ root: path.join(paths.root, 'installation'), dataRoot: paths.data,
    projectRoot, repository: 'Champion-Guan/infinite-canvas' });
  await verifier.initialize();
  const service = new OwnedUpdateService({ versionsRoot: path.join(verifier.root, 'versions'),
    dataRoot: paths.data, privateRoot: paths.root, verify: pointer => verifier.verifyInstalled(pointer) });
  const capability = await supervisorCapability(path.join(paths.updates, 'supervisor.capability'));
  const ipc = await serveUpdateSupervisor({ service, socketPath: path.join(paths.updates, 's.sock'), capability,
    versionsRoot: service.versionsRoot, dataRoot: paths.data, origin: service.origin });
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    try { await ipc.close(); }
    catch { closing = false; console.error('Supervisor remains running: its service must be safely stopped first.'); }
  };
  process.on('SIGTERM', () => { void close(); }); process.on('SIGINT', () => { void close(); });
  console.log('Independent service supervisor ready; no service has been adopted or started.');
}
main().catch(() => { console.error('Service supervisor refused to start safely; existing service and data were not changed.'); process.exitCode = 1; });
