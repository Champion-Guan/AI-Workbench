import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseVersion } from '../src/server/stable-version.mjs';

async function main() {
  const tag = process.argv[2], version = JSON.parse(await readFile('package.json', 'utf8')).version;
  if (process.argv.length !== 3 || tag !== 'v' + version || !parseVersion(version) || parseVersion(version).pre.length) throw Error('Tag must match stable package version');
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw Error('Dirty release source');
  const commit = git(['rev-parse', 'HEAD']);
  if (git(['rev-parse', `refs/tags/${tag}^{commit}`]) !== commit) throw Error('Release tag is not the checked-out commit');
  const branch = process.env.GUAN_DEFAULT_BRANCH;
  if (!branch || !/^[A-Za-z0-9_./-]+$/.test(branch) || branch.includes('..')) throw Error('Default branch required');
  execFileSync('git', ['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${branch}`], { stdio: 'pipe' });
  console.log(JSON.stringify({ ok: true, version, commit }));
}
main().catch(() => { console.error('Stable source gate failed: require an existing version-matched tag on the default branch and clean source.'); process.exitCode = 1; });
