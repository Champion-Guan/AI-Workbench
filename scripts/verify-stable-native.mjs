// Build-job QA only. Validates locally built bytes before native execution.
// Remote update packages must use verify-signed-stable, which never executes.
import { readFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { validateZipArchive, verifyReleaseFiles } from './lib/release-validation.mjs';
import { verifyStableArchive } from '../src/server/stable-manifest.mjs';
import { writePrivateFile } from '../src/server/runtime-paths.mjs';
import { machArchitecture } from './lib/stable-runtime.mjs';

async function main() {
  if (process.argv.slice(2).some(x => !['--qa', '--qa-final', '--qa-checkpoint'].includes(x)) || process.argv.length > 3 || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Native arm64 build QA only');
  const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root,
    process.argv.includes('--qa-checkpoint') ? 'output/phase4/native-qa-checkpoint' : process.argv.includes('--qa-final') ? 'output/phase4/native-qa-final' : process.argv.includes('--qa') ? 'output/phase4/native-qa' : 'output/stable');
  const record = JSON.parse(await readFile(path.join(output, 'package-' + process.arch + '.json'), 'utf8')), descriptor = record.descriptor;
  if (descriptor?.arch !== process.arch || descriptor.name !== `guan-ai-workbench-v${record.version}-macos-${process.arch}.zip`) throw Error('Native QA identity mismatch');
  const archive = await readFile(path.join(output, descriptor.name)); verifyStableArchive(archive, descriptor);
  const zip = validateZipArchive(archive, { trustedRuntime: descriptor });
  const temporary = await mkdtemp(path.join(tmpdir(), 'guan-native-smoke-')); await chmod(temporary, 0o700);
  let child, exited = false, exit;
  try {
    const local = path.join(temporary, 'package.zip'); await writePrivateFile(local, archive, { exclusive: true });
    execFileSync('unzip', ['-q', local, '-d', temporary], { stdio: 'pipe' });
    const app = path.join(temporary, zip.root), checked = await verifyReleaseFiles(app, { trustedRuntime: descriptor });
    if (checked.manifest.arch !== process.arch || checked.manifest.commit !== record.commit || checked.manifest.edition !== 'stable'
      || machArchitecture(await readFile(path.join(app, 'runtime/node'))) !== process.arch) throw Error('Native package identity mismatch');
    const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    if (port === 5174) throw Error('Production port forbidden');
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(path.join(app, 'runtime/node'), ['server.mjs'], { cwd: app,
      env: { PATH: '/usr/bin:/bin', PORT: String(port), GUAN_WORKBENCH_DATA_DIR: path.join(temporary, 'private-data'),
        IMAGE_RELAY_MIHOMO_AUTO_DOWNLOAD: 'false', IMAGE_RELAY_MIHOMO_DISABLED: 'true', IMAGE_RELAY_PROXY: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    exit = new Promise(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; resolve(); }); });
    let healthy = false;
    for (let attempt = 0; attempt < 50 && !exited; attempt++) {
      try {
        const response = await fetch(origin + '/local-app/health', { signal: AbortSignal.timeout(500) });
        const h = await response.json();
        if (h.ready && h.pid === child.pid && h.version === record.version && h.buildId === checked.buildId && h.origin === origin) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!healthy || exited) throw Error('Bundled Node cannot start verified service');
    for (const route of ['/', '/canvas/qa', '/canvas/excel-prompts-bridge.js', ...checked.assets]) {
      const response = await fetch(origin + route, { signal: AbortSignal.timeout(3000) });
      if (!response.ok || !(await response.arrayBuffer()).byteLength) throw Error('Native asset smoke failed');
    }
    const response = await fetch(origin + '/local-app/updates/status', { headers: { origin } });
    const updates = await response.json();
    if (!response.ok || updates.install.allowed || updates.preferences.autoInstall || updates.preferences.repository !== '') throw Error('Native update state unsafe');
    console.log(JSON.stringify({ ok: true, arch: process.arch, version: record.version, bundledRuntimeExecuted: true, privateDataIsolated: true, installAllowed: false }));
  } finally {
    if (child && !exited) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000); timer.unref();
      await exit; clearTimeout(timer);
    }
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => { console.error('Native stable smoke failed safely; production service and private data untouched.'); process.exitCode = 1; });
