import { readFile, lstat, mkdtemp, mkdir, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sha256 } from '../src/server/stable-manifest.mjs';
import { privateDirectory, writePrivateFile } from '../src/server/runtime-paths.mjs';

async function main() {
  if (process.argv.length !== 2 || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Local QA only');
  const root = fileURLToPath(new URL('../', import.meta.url)), directory = path.join(root, 'output/phase4');
  const archiveFile = path.join(root, 'output/gitleaks-qa-complete.tar.gz'), archive = await readFile(archiveFile);
  if (archive.length !== 5574778 || sha256(archive) !== 'b90f13bb8c90ab72083d9b0c842e39dafb82c0e5c3f872f407366b7a58909013') throw Error('Scanner archive not trusted');
  const executable = path.join(directory, 'gitleaks-qa'), info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o100)) throw Error('Scanner not installed safely');
  const expected = execFileSync('/usr/bin/tar', ['-xOzf', archiveFile, 'gitleaks'], { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!expected.equals(await readFile(executable))) throw Error('Scanner binary changed');
  const temporary = await mkdtemp(path.join(tmpdir(), 'guan-source-scan-')); await chmod(temporary, 0o700);
  await privateDirectory(directory);
  try {
    const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 1024 * 1024 }).toString().split('\0').filter(Boolean);
    let count = 0;
    for (const name of new Set(names)) {
      const source = path.resolve(root, name);
      if (!source.startsWith(root) || name.split('/').some(x => !x || x === '.' || x === '..')) throw Error('Unsafe source path');
      let s; try { s = await lstat(source); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (!s.isFile() || s.isSymbolicLink() || s.size > 32 * 1024 * 1024) throw Error('Source not fully scannable');
      const destination = path.join(temporary, name); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination); await chmod(destination, 0o600); count++;
    }
    const scopes = [{ label: 'current', source: temporary }, { label: 'canvas-build', source: path.join(root, 'src/canvas/dist') }], results = [];
    for (const scope of scopes) {
      const report = path.join(directory, scope.label + '-' + randomUUID() + '-independent-private.json');
      if (!await writePrivateFile(report, '[]', { exclusive: true })) throw Error('Previous scan report preserved');
      let code = 0;
      try { execFileSync(executable, ['dir', scope.source, '--redact=100', '--no-banner', '--exit-code=1', '--report-format=json', '--report-path=' + report],
        { cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH } }); }
      catch (e) { if (e.status !== 1) throw Error('Source scanner incomplete'); code = 1; }
      await chmod(report, 0o600); const findings = JSON.parse(await readFile(report, 'utf8'));
      if (!Array.isArray(findings) || code === 1 && !findings.length) throw Error('Source scan did not complete');
      results.push({ scope: scope.label, ok: code === 0 && findings.length === 0, findings: findings.length, rules: [...new Set(findings.map(f => f.RuleID))] });
    }
    const summary = { scanner: 'gitleaks 8.24.3', ok: results.every(r => r.ok), candidates: count, results };
    await writePrivateFile(path.join(directory, 'current-independent-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary)); if (!summary.ok) process.exitCode = 1;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
main().catch(() => { console.error('Current-source independent scan incomplete; no findings exposed and original files unchanged.'); process.exitCode = 1; });
