// Fixed local acceptance batch. Never publishes, migrates or restarts production.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyCanvasBuild } from './lib/canvas-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 2) throw Error('This verifier accepts no commands or production targets');
const steps = [];
function command(name, executable, args) {
  const started = Date.now();
  console.log(`Checking: ${name}`);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', exceeded = false;
    child.stderr.resume(); // Never echo private diagnostics or credential values.
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > 4 * 1024 * 1024) { exceeded = true; child.kill(); }
      else stdout += chunk;
    });
    child.once('error', () => reject(Error(`Check could not start: ${name}`)));
    child.once('close', code => {
      steps.push({ name, ok: code === 0 && !exceeded, elapsedMs: Date.now() - started });
      if (code !== 0 || exceeded) reject(Error(`Check failed: ${name}; run its named command for diagnostics`));
      else resolve(stdout);
    });
  });
}
let report;
try {
  await command('typecheck', 'npm', ['--prefix', 'src/canvas', 'run', 'typecheck']);
  const tests = await command('unit-and-isolated-integration-tests', 'npm', ['test']);
  const totalTests = Number(tests.match(/tests (\d+)/)?.[1]);
  if (!totalTests || !/fail 0/.test(tests)) throw Error('Test completion not confirmed');
  await command('source-secret-scan', 'npm', ['run', 'secrets:scan']);
  await command('history-secret-scan', 'npm', ['run', 'secrets:history']);
  await command('staged-secret-scan', 'npm', ['run', 'secrets:staged']);
  await command('current-source-canvas-build', 'npm', ['run', 'build:canvas']);
  const build = await verifyCanvasBuild(root, path.join(root, 'src/canvas/dist'));
  const packed = JSON.parse(await command('local-unsigned-package', process.execPath, ['scripts/create-release.mjs', '--canvas-build']));
  if (typeof packed.zip !== 'string' || !packed.zip.startsWith(path.join(root, 'output/releases') + path.sep)) throw Error('Unexpected package path');
  const verification = JSON.parse(await command('isolated-package-runtime', process.execPath, ['scripts/verify-release.mjs', packed.zip]));
  if (!verification.ok || verification.installAllowed !== false || !verification.isolatedData) throw Error('Isolated verification not confirmed');
  report = { localBatchPassed: true, fullPhase2Accepted: false, acceptanceScope: 'original-phase2-data-isolation', automaticInstallAllowed: false,
    totalTests, version: build.version, canvasSourceHash: build.sourceHash, packageSha256: packed.sha256,
    packageFiles: verification.files, packageRoutes: verification.routes, steps,
    // This local runner cannot attest historical real backups/manual cutover.
    // Whole-phase acceptance is recorded separately with those actual proofs.
    remaining: ['review-backup-restore-and-production-handoff-evidence'],
    followOnWork: ['phase3-private-GitHub-auth-and-update-UI', 'phase4-signed-release-and-CI',
      'phase5-trusted-inventory-complete-admission-and-install-coordinator',
      'explicit-provider-credential-migration-with-edit-export-and-script-compatibility', 'phase6-two-physical-Macs'],
    excluded: ['real-user-data-mutation', 'production-service-switch', 'GitHub-push-or-release', 'signed-install', 'two-physical-Macs'] };
} catch (error) {
  report = { localBatchPassed: false, fullPhase2Accepted: false, automaticInstallAllowed: false, steps,
    reason: error instanceof Error && /^Check |^Test |^Unexpected |^Isolated /.test(error.message) ? error.message : 'Local verification failed; production untouched' };
  process.exitCode = 1;
}
await mkdir(path.join(root, 'output/phase2'), { recursive: true, mode: 0o700 });
await writeFile(path.join(root, 'output/phase2/latest-verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
