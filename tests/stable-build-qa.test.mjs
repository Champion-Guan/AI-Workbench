import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkStableBuildQa } from '../scripts/lib/stable-build-qa.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'guan-build-only-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-b', 'main']);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.4' }));
  git(['add', 'package.json']);
  git(['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'QA fixture']);
  const commit = git(['rev-parse', 'HEAD']); git(['update-ref', 'refs/remotes/origin/main', commit]);
  return { root, expectedCommit: commit, expectedArch: 'arm64', defaultBranch: 'main', platform: 'darwin', arch: 'arm64' };
}
test('build-only QA accepts clean exact native source without release tags and grants no publication or installation', async t => {
  const input = await fixture(t), result = await checkStableBuildQa(input);
  assert.equal(result.commit, input.expectedCommit); assert.equal(result.version, '1.0.4');
  assert.equal(result.signed, false); assert.equal(result.publishAllowed, false); assert.equal(result.installAllowed, false);
  assert.equal(execFileSync('git', ['tag', '--list'], { cwd: input.root, encoding: 'utf8' }).trim(), '');
});
test('build-only QA rejects source dirtiness without modifying it', async t => {
  const input = await fixture(t); await writeFile(path.join(input.root, 'unsaved.txt'), 'retain');
  await assert.rejects(checkStableBuildQa(input), /Dirty/);
  assert.equal(await readFile(path.join(input.root, 'unsaved.txt'), 'utf8'), 'retain');
});
test('build-only QA rejects a changed immutable commit', async t => {
  const input = await fixture(t);
  await assert.rejects(checkStableBuildQa({ ...input, expectedCommit: 'a'.repeat(40) }), /commit changed/);
});
test('build-only QA rejects wrong native architecture and nonmacOS', async t => {
  const input = await fixture(t);
  await assert.rejects(checkStableBuildQa({ ...input, arch: 'x64' }), /identity/);
  await assert.rejects(checkStableBuildQa({ ...input, platform: 'linux' }), /identity/);
});
test('build-only QA requires the committed default branch and rejects malformed branch identity', async t => {
  const input = await fixture(t);
  await assert.rejects(checkStableBuildQa({ ...input, defaultBranch: 'missing' }));
  await assert.rejects(checkStableBuildQa({ ...input, defaultBranch: '../main' }), /identity/);
});
test('build-only QA refuses prerelease package identity', async t => {
  const input = await fixture(t); await writeFile(path.join(input.root, 'package.json'), JSON.stringify({ version: '1.0.4-beta.1' }));
  execFileSync('git', ['add', 'package.json'], { cwd: input.root });
  execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'prerelease fixture'], { cwd: input.root, stdio: 'pipe' });
  input.expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.root, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', input.expectedCommit], { cwd: input.root });
  await assert.rejects(checkStableBuildQa(input), /Stable package version/);
});
test('native QA workflow is manual, dual-native, immutable and read-only with no signing secret or release path', async () => {
  const qa = await readFile(new URL('../.github/workflows/stable-build-qa.yml', import.meta.url), 'utf8');
  assert.match(qa, /workflow_dispatch:/); assert.match(qa, /contents: read/);
  assert.doesNotMatch(qa, /contents: write|secrets\.|stable:sign|publish-stable|release create|environment:|pull_request_target|\n  push:|\n  pull_request:/);
  for (const value of ['BUILD-ONLY', 'github.event.repository.default_branch', 'macos-15-intel', 'arch: arm64', 'arch: x64', 'ref: ${{ github.sha }}', 'check-stable-build-qa.mjs', 'verify-stable-native.mjs', 'stable-build-qa-${{ matrix.arch }}']) assert.ok(qa.includes(value));
  const release = await readFile(new URL('../.github/workflows/stable-release.yml', import.meta.url), 'utf8');
  for (const value of ['npm ci --prefix src/canvas --ignore-scripts --legacy-peer-deps', 'npm run native:build', 'npm run stable:runtime', 'npm run stable:build', 'node scripts/verify-stable-native.mjs']) assert.ok(qa.includes(value) && release.includes(value));
  for (const action of qa.matchAll(/uses: (actions\/[^\s]+)/g)) assert.match(action[1], /@[a-f0-9]{40}$/);
});
