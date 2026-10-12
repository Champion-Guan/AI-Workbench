import { execFileSync } from 'node:child_process';

export function validateLocalStableOwner({ repository, user, repo, confirmation, commit, tag, head, tagCommit, dirty, remote }) {
  if (confirmation !== 'RELEASE-STABLE' || repository !== 'MrGuAm/guan-ai-workbench'
    || user?.login !== 'MrGuAm' || user?.id !== 87700227 || repo?.full_name !== repository
    || repo.private !== true || repo.owner?.id !== 87700227 || repo.permissions?.admin !== true
    || !/^v\d+\.\d+\.\d+$/.test(tag || '') || !/^[a-f0-9]{40}$/.test(commit || '')
    || head !== commit || tagCommit !== commit || dirty
    || remote !== `https://github.com/${repository}` && remote !== `https://github.com/${repository}.git`)
    throw Error('Local owner approval rejected');
  return { repository, commit, tag, approvedBy: 'MrGuAm' };
}

export function localStableOwner({ root, commit, tag, confirmation }) {
  const repository = 'MrGuAm/guan-ai-workbench';
  const env = { ...process.env, GH_DEBUG: '' };
  const run = (exe, args) => execFileSync(exe, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 2 * 1024 * 1024 }).toString().trim();
  return validateLocalStableOwner({ repository, commit, tag, confirmation,
    user: JSON.parse(run('gh', ['api', 'user'])), repo: JSON.parse(run('gh', ['api', `repos/${repository}`])),
    head: run('git', ['rev-parse', 'HEAD']), tagCommit: run('git', ['rev-parse', `${tag}^{commit}`]),
    dirty: run('git', ['status', '--porcelain', '--untracked-files=all']), remote: run('git', ['remote', 'get-url', 'origin']) });
}
