// One fixed stage-5 verification entry. Never installs/publishes/restarts
// production; local checks and whole-phase acceptance are different results.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { get } from 'node:http';
import { privateDirectory, writePrivateFile } from '../src/server/runtime-paths.mjs';
import { verifyCanvasBuild } from './lib/canvas-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 2) throw Error('This verifier accepts no commands or production targets');
const steps = [];
const privateRoot = path.join(homedir(), 'Library/Application Support/GuanAIWorkbench');
async function privateSnapshot() {
  const hashes = {};
  for (const relative of ['data/proxy/profile.yaml', 'data/proxy/state.json', 'data/runtime/image-relay-transports.json']) {
    try {
      const file = path.join(privateRoot, relative), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw Error();
      hashes[relative] = createHash('sha256').update(await readFile(file)).digest('hex');
    } catch (e) { if (e.code === 'ENOENT') hashes[relative] = null; else throw Error('private-baseline-unreadable'); }
  }
  return hashes;
}
function health() {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); req.destroy(); resolve(result); };
    const req = get('http://127.0.0.1:5174/local-app/health', { agent: false }, res => {
      const chunks = []; let size = 0;
      res.on('data', b => { size += b.length; if (size > 8192) finish(null); else chunks.push(b); });
      res.on('error', () => finish(null));
      res.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200 || v.app !== 'guan-ai-workbench' || v.origin !== 'http://127.0.0.1:5174'
            || !Number.isSafeInteger(v.pid) || typeof v.version !== 'string' || typeof v.instanceId !== 'string') throw Error();
          finish({ version: v.version, pid: v.pid, instanceId: v.instanceId, ready: v.ready === true });
        } catch { finish(null); }
      });
    });
    const timer = setTimeout(() => finish(null), 2000);
    req.on('error', () => finish(null));
  });
}
async function sourceSnapshot() {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    if (path.isAbsolute(file) || file.split('/').includes('..')) throw Error();
    hash.update(file + '\0');
    try {
      const info = await lstat(path.join(root, file));
      if (!info.isFile() || info.isSymbolicLink()) throw Error();
      hash.update(String(info.mode & 0o777) + '\0'); hash.update(await readFile(path.join(root, file)));
    } catch (e) { if (e.code === 'ENOENT') hash.update('deleted'); else throw e; }
  }
  return hash.digest('hex');
}
function command(name, executable, args, timeoutMs = 15 * 60 * 1000) {
  console.log(`Checking: ${name}`); const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', exceeded = false;
    child.stderr.resume(); // Do not echo potentially sensitive diagnostics.
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', b => { if (stdout.length + b.length > 8 * 1024 * 1024) { exceeded = true; child.kill('SIGTERM'); } else stdout += b; });
    child.once('error', () => { clearTimeout(timer); reject(Error('check-could-not-start')); });
    child.once('close', code => {
      clearTimeout(timer); steps.push({ name, passed: code === 0 && !exceeded, elapsedMs: Date.now() - started });
      if (code !== 0 || exceeded) reject(Error('local-check-failed')); else resolve(stdout);
    });
  });
}
let report, baseline, previousHealth;
try {
  const sourceHash = await sourceSnapshot(); baseline = await privateSnapshot(); previousHealth = await health();
  await command('typecheck', 'npm', ['--prefix', 'src/canvas', 'run', 'typecheck']);
  await command('lint', 'npm', ['run', 'lint']);
  const tests = await command('all-unit-and-isolated-integration-tests', 'npm', ['test']);
  const totalTests = Number(tests.match(/tests (\d+)/)?.[1]);
  if (!totalTests || !/fail 0/.test(tests)) throw Error('test-completion-unconfirmed');
  await command('source-secret-scan', 'npm', ['run', 'secrets:scan']);
  await command('history-secret-scan', 'npm', ['run', 'secrets:history']);
  await command('staged-secret-scan', 'npm', ['run', 'secrets:staged']);
  const launchd = JSON.parse(await command('real-isolated-user-launchd', process.execPath, ['scripts/verify-update-launchd.mjs']));
  if (launchd.userModeLaunchd !== true || launchd.gracefulBootout !== true || launchd.productionChanged !== false
    || launchd.installationEnabled !== false || launchd.supervisorVerified !== true
    || launchd.managerRestartPreservedSupervisor !== true) throw Error('launchd-proof-unconfirmed');
  await command('current-source-canvas-build', 'npm', ['run', 'build:canvas']);
  const build = await verifyCanvasBuild(root, path.join(root, 'src/canvas/dist'));
  const packed = JSON.parse(await command('unsigned-current-source-package', process.execPath, ['scripts/create-release.mjs', '--canvas-build']));
  if (typeof packed.zip !== 'string' || !packed.zip.startsWith(path.join(root, 'output/releases') + path.sep)) throw Error('package-path-invalid');
  const verified = JSON.parse(await command('actual-isolated-package-runtime', process.execPath, ['scripts/verify-release.mjs', packed.zip]));
  if (!verified.ok || !verified.isolatedData || verified.installAllowed !== false) throw Error('package-proof-unconfirmed');
  const afterHealth = await health();
  const privateFilesUnchanged = JSON.stringify(baseline) === JSON.stringify(await privateSnapshot());
  const productionIdentityUnchanged = JSON.stringify(previousHealth) === JSON.stringify(afterHealth);
  if (sourceHash !== await sourceSnapshot() || !privateFilesUnchanged || !productionIdentityUnchanged) throw Error('baseline-changed-during-verification');
  report = { format: 1, checkedAt: new Date().toISOString(), localChecksPassed: true, fullPhase5Accepted: false,
    sourceHash, totalTests, version: build.version, packageSha256: packed.sha256, packageFiles: verified.files, packageRoutes: verified.routes,
    userModeLaunchdVerified: true, independentSupervisorVerified: true,
    managerRestartPreservedSupervisor: true, privateFilesUnchanged, productionIdentityUnchanged,
    productionVersion: afterHealth?.version || null, productionObserved: Boolean(afterHealth),
    automaticInstallAllowed: false, steps,
    // No test fixture or fresh browser context can attest these actual gates.
    remaining: ['managed-browser-all-profile-authority-and-full-root-admission', 'legacy-remote-task-reconciliation-and-agent-protocol-verification',
      'signed-protocol1-bootstrap-and-independent-manager-upgrade',
      'confirmed-maintenance-handoff-and-production-proxy-helper-compatibility'],
    excluded: ['production-install-or-restart', 'real-browser-storage-mutation', 'formal-release', 'physical-power-loss', 'two-physical-Macs'] };
  process.exitCode = 2; // Passed local QA is deliberately not whole-phase acceptance.
} catch {
  report = { format: 1, checkedAt: new Date().toISOString(), localChecksPassed: false, fullPhase5Accepted: false,
    automaticInstallAllowed: false, steps, error: 'local-verification-failed', productionWasNotRestartedByVerifier: true };
  process.exitCode = 1;
}
const directory = path.join(root, 'output/phase5'); await privateDirectory(directory);
await writePrivateFile(path.join(directory, 'latest-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
