import { readFile, lstat } from 'node:fs/promises';

// Single-owner approval is not independent review. Never grants install rights.
export function verifyStableOwnerApproval({ event, eventName, repository, ownerId, actorId,
  triggeringActor, ref, sha }) {
  const repo = event?.repository;
  if (eventName !== 'workflow_dispatch' || repository !== 'MrGuAm/guan-ai-workbench'
    || repo?.full_name !== repository || repo.private !== true
    || String(repo.owner?.id) !== '87700227' || repo.owner?.login !== 'MrGuAm'
    || ownerId !== '87700227' || actorId !== '87700227' || triggeringActor !== 'MrGuAm'
    || String(event.sender?.id) !== '87700227' || event.sender?.login !== 'MrGuAm'
    || typeof repo.default_branch !== 'string' || !/^[A-Za-z0-9_./-]{1,128}$/.test(repo.default_branch)
    || repo.default_branch.includes('..') || ref !== `refs/heads/${repo.default_branch}`
    || !/^[a-f0-9]{40}$/.test(sha || '') || event.inputs?.commit !== sha
    || event.inputs?.confirmation !== 'RELEASE-STABLE'
    || !/^v\d+\.\d+\.\d+$/.test(event.inputs?.tag || '')) throw Error('Owner release approval rejected');
  return { repository, commit: sha, tag: event.inputs.tag, approvedBy: 'MrGuAm' };
}

export async function verifyStableOwnerEnvironment(env = process.env) {
  const file = env.GITHUB_EVENT_PATH, info = file && await lstat(file);
  if (env.GITHUB_ACTIONS !== 'true' || !info?.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw Error('CI approval required');
  return verifyStableOwnerApproval({ event: JSON.parse(await readFile(file, 'utf8')),
    eventName: env.GITHUB_EVENT_NAME, repository: env.GITHUB_REPOSITORY,
    ownerId: env.GITHUB_REPOSITORY_OWNER_ID, actorId: env.GITHUB_ACTOR_ID,
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR, ref: env.GITHUB_REF, sha: env.GITHUB_SHA });
}
