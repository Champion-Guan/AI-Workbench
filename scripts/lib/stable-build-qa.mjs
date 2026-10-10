import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseVersion } from '../../src/server/stable-version.mjs';

// Build-only identity proof. Does not create tags, sign, install or publish.
export async function checkStableBuildQa({ root, expectedCommit, expectedArch, defaultBranch,
  platform = process.platform, arch = process.arch }) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(expectedArch) || arch !== expectedArch
    || !/^[a-f0-9]{40}$/.test(expectedCommit || '') || typeof defaultBranch !== 'string'
    || !/^[A-Za-z0-9_./-]{1,128}$/.test(defaultBranch) || defaultBranch.includes('..')) throw Error('Invalid native QA identity');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw Error('Dirty QA source');
  const commit = git(['rev-parse', 'HEAD']);
  if (commit !== expectedCommit) throw Error('QA source commit changed');
  execFileSync('git', ['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${defaultBranch}`], { cwd: root, stdio: 'pipe' });
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const parsed = parseVersion(version);
  if (!parsed || parsed.pre.length) throw Error('Stable package version required');
  return { ok: true, commit, version, arch, signed: false, installAllowed: false, publishAllowed: false };
}
