import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

test('ordinary CI does not publish, uses read-only permissions and includes required quality gates', async () => {
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /contents: read/); assert.doesNotMatch(ci, /contents: write|stable:sign|publish-stable|pull_request_target/);
  for (const gate of ['typecheck', 'npm run lint', 'npm test', 'build:canvas', 'secrets:scan', 'secrets:history', 'gitleaks']) assert.ok(ci.includes(gate));
  for (const action of ci.matchAll(/uses: ([^\s]+)/g)) assert.match(action[1], /@[a-f0-9]{40}$/);
});
test('stable publication is manual, native dual architecture and immutable-source-bound with isolated signing job', async () => {
  const workflow = await readFile(new URL('../.github/workflows/stable-release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /pull_request_target|\n  push:|ref: \$\{\{ inputs.tag/);
  assert.equal([...workflow.matchAll(/ref: \$\{\{ github.sha \}\}/g)].length, 2);
  for (const value of ['RELEASE-STABLE', 'macos-15-intel', 'arch: arm64', 'arch: x64', 'environment: stable-release', 'verify-stable-native.mjs', 'cancel-in-progress: false']) assert.ok(workflow.includes(value));
  const [build, publish] = workflow.split('\n  publish:');
  assert.doesNotMatch(build, /GUAN_STABLE_SIGNING_KEY|contents: write/); assert.match(publish, /GUAN_STABLE_SIGNING_KEY/);
  for (const action of workflow.matchAll(/uses: (actions\/[^\s]+)/g)) assert.match(action[1], /@[a-f0-9]{40}$/);
});
test('production trusted key set is fail-closed until user bootstraps a reviewed public key', async () => {
  const { STABLE_TRUSTED_KEYS } = await import('../src/server/stable-trust.mjs');
  assert.equal(Object.isFrozen(STABLE_TRUSTED_KEYS), true);
  for (const pem of Object.values(STABLE_TRUSTED_KEYS)) assert.ok(!pem.includes('PRIVATE KEY'));
});
test('official Stable builder refuses this dirty uncommitted project without installing or publishing', () => {
  // Future CI uses clean committed source; do not require a dirty checkout there.
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
  if (!dirty) return;
  assert.throws(() => execFileSync(process.execPath, ['scripts/create-stable-release.mjs'], { stdio: 'pipe', env: { PATH: process.env.PATH } }), e => e.status === 1 && e.stderr.toString().includes('Stable build refused'));
});
test('independent scanner exclusions are exact immutable fingerprints with verified nonliteral historical byte ranges', async () => {
  const review = JSON.parse(await readFile(new URL('../config/security/gitleaks-reviewed.json', import.meta.url), 'utf8'));
  const ignored = (await readFile(new URL('../.gitleaksignore', import.meta.url), 'utf8')).split('\n').filter(line => line && !line.startsWith('#'));
  assert.equal(review.scanner, 'gitleaks 8.24.3'); assert.equal(review.entries.length, 24);
  assert.deepEqual(ignored, review.entries.map(e => e.fingerprint));
  for (const e of review.entries) {
    assert.equal(e.file, 'playground-settings/dist/assets/index.js');
    assert.equal(e.fingerprint, `${e.commit}:${e.file}:generic-api-key:${e.line}`);
    const spec = e.commit + ':' + e.file;
    assert.equal(execFileSync('git', ['rev-parse', spec], { encoding: 'utf8' }).trim(), e.blob);
    const source = execFileSync('git', ['show', spec], { maxBuffer: 32 * 1024 * 1024 }).toString();
    const line = Buffer.from(source.split('\n')[e.line - 1]);
    assert.match(line.subarray(e.byteOffset, e.byteOffset + 64).toString(), /^useNewApiKey:[A-Za-z_$]\.useNewApiKey===void 0\?/);
  }
});
