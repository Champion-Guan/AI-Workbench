import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLocalStableOwner } from '../scripts/lib/local-stable-owner.mjs';

const fixture = () => ({ repository: 'MrGuAm/guan-ai-workbench', user: { login: 'MrGuAm', id: 87700227 },
  repo: { full_name: 'MrGuAm/guan-ai-workbench', private: true, owner: { id: 87700227 }, permissions: { admin: true } },
  confirmation: 'RELEASE-STABLE', commit: 'a'.repeat(40), tag: 'v1.0.5', head: 'a'.repeat(40),
  tagCommit: 'a'.repeat(40), dirty: '', remote: 'https://github.com/MrGuAm/guan-ai-workbench' });
test('local release requires authenticated owner, exact clean tagged source and explicit confirmation', () => {
  assert.equal(validateLocalStableOwner(fixture()).tag, 'v1.0.5');
  for (const mutate of [f => f.user.id = 1, f => f.user.login = 'friend', f => f.repo.private = false,
    f => f.repo.permissions.admin = false, f => f.repo.owner.id = 1, f => f.confirmation = '',
    f => f.head = 'b'.repeat(40), f => f.tagCommit = 'b'.repeat(40), f => f.dirty = ' M file',
    f => f.remote = 'https://github.com/other/repo', f => f.tag += '-beta', f => f.commit = 'short']) {
    const f = fixture(); mutate(f); assert.throws(() => validateLocalStableOwner(f));
  }
});
