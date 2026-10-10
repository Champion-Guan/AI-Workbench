import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { keyId } from '../src/server/stable-manifest.mjs';
import { STABLE_TRUSTED_KEYS } from '../src/server/stable-trust.mjs';
import { verifyStableSigningProof } from '../scripts/lib/stable-signing-proof.mjs';
import { verifyStableSigningQaApproval, verifyStableOwnerApproval } from '../scripts/lib/stable-owner-approval.mjs';

test('pinned production trust contains only the approved public Ed25519 key and matching fingerprint', () => {
  const id = '61d0312290a5ac3688099d26d595e619161fcf34bcc582262c5ab26f1c20be00';
  assert.deepEqual(Object.keys(STABLE_TRUSTED_KEYS), [id]);
  assert.equal(keyId(STABLE_TRUSTED_KEYS[id]), id);
  assert.doesNotMatch(STABLE_TRUSTED_KEYS[id], /PRIVATE KEY/);
});
test('fixed signing-only proof accepts matching ephemeral key, rejects unknown key, malformed source and bad input', () => {
  const pair = generateKeyPairSync('ed25519'), pem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const raw = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), commit = 'a'.repeat(40), id = keyId(pem);
  const result = verifyStableSigningProof(raw, commit, { [id]: pem });
  assert.equal(result.keyId, id); assert.equal(result.releaseManifestSigned, false); assert.equal(result.releasePublished, false);
  for (const run of [() => verifyStableSigningProof(raw, commit), () => verifyStableSigningProof(raw, 'short', { [id]: pem }),
    () => verifyStableSigningProof('', commit), () => verifyStableSigningProof('x'.repeat(4097), commit),
    () => verifyStableSigningProof(raw, commit, { [id]: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) })]) assert.throws(run);
});
test('signing-only approval cannot authorize release, rejects other actors and extra release tag', () => {
  const context = { eventName: 'workflow_dispatch', repository: 'MrGuAm/guan-ai-workbench', ownerId: '87700227',
    actorId: '87700227', triggeringActor: 'MrGuAm', ref: 'refs/heads/main', sha: 'a'.repeat(40),
    event: { repository: { full_name: 'MrGuAm/guan-ai-workbench', private: true, default_branch: 'main', owner: { id: 87700227, login: 'MrGuAm' } },
      sender: { id: 87700227, login: 'MrGuAm' }, inputs: { commit: 'a'.repeat(40), confirmation: 'VERIFY-SIGNING-KEY' } } };
  assert.equal(verifyStableSigningQaApproval(context).releaseAllowed, false);
  assert.throws(() => verifyStableOwnerApproval(context));
  assert.throws(() => verifyStableSigningQaApproval({ ...context, triggeringActor: 'friend' }));
  context.event.inputs.tag = 'v1.0.4'; assert.throws(() => verifyStableSigningQaApproval(context));
});
test('signing QA workflow is read-only, manual, source-bound and cannot publish or upload signatures', async () => {
  const workflow = await readFile(new URL('../.github/workflows/stable-signing-qa.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.match(workflow, /contents: read/);
  assert.match(workflow, /inputs.commit == github.sha/); assert.match(workflow, /github.actor_id == '87700227'/);
  assert.doesNotMatch(workflow, /contents: write|upload-artifact|stable:sign|publish-stable|pull_request_target|\n  push:|\n  pull_request:/);
  const script = await readFile(new URL('../scripts/verify-stable-signing-key.mjs', import.meta.url), 'utf8');
  assert.ok(script.indexOf('await verifyStableSigningQaEnvironment()') < script.indexOf('process.env.GUAN_STABLE_SIGNING_KEY'));
});
test('bootstrap uses encrypted backup, new Keychain account and stdin-only secret creation with no overwrite', async () => {
  const source = await readFile(new URL('../scripts/bootstrap-stable-signing.mjs', import.meta.url), 'utf8');
  for (const fragment of ["cipher: 'aes-256-cbc'", 'vault.insert(account, password)', 'vault.read(account)', 'exclusive: true',
    'secrets.some(s => s.name === secretName)', 'child.stdin.end(raw)', 'raw.fill(0)']) assert.ok(source.includes(fragment));
  assert.doesNotMatch(source, /--body|console\.(?:log|error)\((?:raw|password|encrypted)\)/);
});
