// Developer verification only, not a signed update installer.
import { mkdtemp, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { validateZipArchive, verifyReleaseFiles } from './lib/release-validation.mjs';
import { privateDirectory, writePrivateJson } from '../src/server/runtime-paths.mjs';
import { STABLE_REPOSITORY } from '../src/server/workbench-identity.mjs';

async function verify() {
const archive = process.argv[2];
if (!archive || !path.isAbsolute(archive)) throw new Error('Usage: node scripts/verify-release.mjs /absolute/path/release.zip');
const zip = validateZipArchive(await readFile(archive));
execFileSync('unzip', ['-tq', archive], { stdio: 'pipe' });
const directory = await mkdtemp(path.join(tmpdir(), 'guan-release-check-'));
await chmod(directory, 0o700);
execFileSync('unzip', ['-q', archive, '-d', directory], { stdio: 'pipe' });
const root = path.join(directory, zip.root);
const { manifest, assets, files, buildId } = await verifyReleaseFiles(root);
// Do not probe/run release verification on the user's normal service port.
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dataRoot = path.join(directory, 'isolated-private-runtime');
await privateDirectory(path.join(dataRoot, 'updates'));
await writePrivateJson(path.join(dataRoot, 'updates/preferences.json'), { version: 1, repository: STABLE_REPOSITORY,
  autoCheck: false, autoDownload: false, autoInstall: false, network: 'direct' });
// A fresh env AND private data root are mandatory. Never write real user data.
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root, env: { PATH: process.env.PATH, PORT: String(port), GUAN_WORKBENCH_DATA_DIR: dataRoot,
    IMAGE_RELAY_MIHOMO_AUTO_DOWNLOAD: 'false', IMAGE_RELAY_MIHOMO_DISABLED: 'true', IMAGE_RELAY_PROXY: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false;
const exit = new Promise(resolve => { child.once('exit', code => { exited = true; resolve(code); }); child.once('error', () => { exited = true; resolve(1); }); });
// Consume output without echoing credentials or third-party command diagnostics.
child.stderr.resume(); child.stdout.resume();
try {
  let health;
  for (let attempt = 0; attempt < 40 && !exited; attempt++) {
    try {
      const reply = await fetch(origin + '/local-app/health', { signal: AbortSignal.timeout(500) });
      if (reply.ok) { const candidate = await reply.json(); if (candidate.pid === child.pid && candidate.ready && candidate.app === 'guan-ai-workbench' && candidate.version === manifest.version && candidate.buildId === buildId && candidate.origin === origin) { health = candidate; break; } }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!health || exited) throw new Error('Extracted release failed its own process/version/build/origin health check');
  const alias = await fetch(`http://localhost:${port}/local-app/health`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
  if (alias.status !== 307 || alias.headers.get('location') !== origin + '/local-app/health') throw Error('Localhost alias failed');
  const urls = ['/', '/canvas/release-verification', '/canvas/excel-prompts-bridge.js', '/data-contract/index.js',
    '/local-app/port-migration', '/data-contract/port-migration.mjs', '/data-contract/browser-backup-codec.mjs', ...assets];
  for (const url of urls) {
    const reply = await fetch(origin + url, { signal: AbortSignal.timeout(3000) });
    if (!reply.ok || !(await reply.arrayBuffer()).byteLength) throw new Error('Release HTTP asset verification failed');
  }
  const updateReply = await fetch(origin + '/local-app/updates/status', { headers: { origin }, signal: AbortSignal.timeout(3000) });
  if (!updateReply.ok) throw new Error('Isolated update route unavailable');
  const updates = await updateReply.json();
  if (updates.currentVersion !== manifest.version || updates.preferences.repository !== STABLE_REPOSITORY || updates.install.allowed !== false
    || updates.preferences.autoInstall !== false || updates.latest !== null) throw new Error('Isolated update state unsafe');
  console.log(JSON.stringify({ ok: true, files, routes: urls.length + 1, version: manifest.version, testDirectory: directory,
    isolatedData: true, signatureVerified: false, installAllowed: false }, null, 2));
} finally {
  if (!exited) child.kill('SIGTERM');
  await Promise.race([exit, new Promise(resolve => { const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); resolve(); }, 5000); timer.unref(); exit.then(() => clearTimeout(timer)); })]);
}
}
verify().catch(() => {
  console.error('Release verification failed safely; no production service or user data was changed.');
  process.exitCode = 1;
});
