// Local QA scanner bootstrap: checksum-pinned official Gitleaks 8.24.3,
// downloaded separately. Incomplete tools are never executed. CI uses the
// version-pinned Go module instead, with the Go checksum database.
import { readFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { privateDirectory, writePrivateFile } from '../src/server/runtime-paths.mjs';
import { sha256 } from '../src/server/stable-manifest.mjs';

async function main() {
  if (process.argv.slice(2).some(x => x !== '--reviewed') || process.argv.length > 3 || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Local arm64 QA only');
  const root = fileURLToPath(new URL('../', import.meta.url)), directory = path.join(root, 'output/phase4');
  const archive = await readFile(path.join(root, 'output/gitleaks-qa-complete.tar.gz'));
  if (archive.length !== 5574778 || sha256(archive) !== 'b90f13bb8c90ab72083d9b0c842e39dafb82c0e5c3f872f407366b7a58909013') throw Error('Official scanner download incomplete or corrupt');
  await privateDirectory(directory);
  const binary = execFileSync('/usr/bin/tar', ['-xOzf', path.join(root, 'output/gitleaks-qa-complete.tar.gz'), 'gitleaks'], { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const executable = path.join(directory, 'gitleaks-qa');
  if (!await writePrivateFile(executable, binary, { exclusive: true }) && !binary.equals(await readFile(executable))) throw Error('Existing scanner retained');
  await chmod(executable, 0o700);
  const reviewed = process.argv.includes('--reviewed');
  const privateReport = path.join(directory, reviewed ? 'independent-secrets-reviewed-private.json' : 'independent-secrets-private.json');
  if (!await writePrivateFile(privateReport, '[]', { exclusive: true })) throw Error('Existing scan report retained; inspect it before a new run');
  let code = 0;
  try { execFileSync(executable, ['git', '--log-opts=--all', '--redact=100', '--no-banner', '--exit-code=1', '--report-format=json', '--report-path=' + privateReport],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }); }
  catch (e) { if (!Number.isInteger(e.status) || ![0, 1].includes(e.status)) throw Error('Scanner failed'); code = e.status; }
  await chmod(privateReport, 0o600);
  const findings = JSON.parse(await readFile(privateReport, 'utf8'));
  if (!Array.isArray(findings) || findings.length > 10000 || code !== 0 && !findings.length) throw Error('Scanner did not complete');
  const summary = { ok: code === 0 && findings.length === 0, scanner: 'gitleaks', version: '8.24.3', archiveChecksumVerified: true,
    historyAllRefs: true, findings: findings.length, rules: [...new Set(findings.map(f => f.RuleID))] };
  await writePrivateFile(path.join(directory, reviewed ? 'independent-secrets-reviewed-summary.json' : 'independent-secrets-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary)); if (!summary.ok) process.exitCode = 1;
}
main().catch(() => { console.error('Independent scanner not run/completed; tool or scan validation failed. No unverified binary was executed and no findings are exposed.'); process.exitCode = 1; });
