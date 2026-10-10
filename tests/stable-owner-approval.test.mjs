import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { verifyStableOwnerApproval, verifyStableOwnerEnvironment } from '../scripts/lib/stable-owner-approval.mjs';

const fixture = () => ({ eventName: 'workflow_dispatch', repository: 'MrGuAm/guan-ai-workbench',
  ownerId: '87700227', actorId: '87700227', triggeringActor: 'MrGuAm', ref: 'refs/heads/main', sha: 'a'.repeat(40),
  event: { repository: { full_name: 'MrGuAm/guan-ai-workbench', private: true, default_branch: 'main', owner: { id: 87700227, login: 'MrGuAm' } },
    sender: { id: 87700227, login: 'MrGuAm' }, inputs: { commit: 'a'.repeat(40), tag: 'v1.0.4', confirmation: 'RELEASE-STABLE' } } });
test('single owner explicitly approves exact private default-branch source', () => {
  assert.deepEqual(verifyStableOwnerApproval(fixture()), { repository: 'MrGuAm/guan-ai-workbench', commit: 'a'.repeat(40), tag: 'v1.0.4', approvedBy: 'MrGuAm' });
});
test('push, collaborator, foreign rerun, fork, changed owner, branch and unconfirmed source are rejected', () => {
  const mutations = [f => f.eventName = 'push', f => f.actorId = '1', f => f.triggeringActor = 'friend',
    f => f.repository = 'friend/guan-ai-workbench', f => f.ownerId = '1', f => f.event.repository.private = false,
    f => f.event.repository.owner.id = 1, f => f.event.repository.owner.login = 'friend',
    f => f.event.repository.full_name = 'friend/repo', f => f.event.sender.id = 1, f => f.event.sender.login = 'friend',
    f => f.ref = 'refs/heads/dev', f => f.event.repository.default_branch = '..', f => f.sha = 'short',
    f => f.event.inputs.commit = 'b'.repeat(40), f => f.event.inputs.confirmation = '', f => f.event.inputs.tag = 'v1.0.4-beta',
    f => delete f.event.inputs, f => delete f.event.repository];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => verifyStableOwnerApproval(f)); }
});
test('missing CI evidence is rejected before reading keys or attempting publication', async () => {
  await assert.rejects(verifyStableOwnerEnvironment({}));
  for (const script of ['sign-stable-release.mjs', 'publish-stable-release.mjs']) {
    const result = spawnSync(process.execPath, ['scripts/' + script], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /failed safely/);
    const source = await readFile(new URL('../scripts/' + script, import.meta.url), 'utf8');
    assert.ok(source.indexOf('await verifyStableOwnerEnvironment()') < source.indexOf('process.env.GUAN_' + (script.startsWith('sign') ? 'STABLE_SIGNING_KEY' : 'RELEASE_TOKEN')));
    assert.match(source, /approval.tag !== 'v' \+ version/);
  }
});
