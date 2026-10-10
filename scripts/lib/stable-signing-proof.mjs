import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { keyId } from '../../src/server/stable-manifest.mjs';
import { STABLE_TRUSTED_KEYS } from '../../src/server/stable-trust.mjs';

// This fixed-domain proof is not a release-manifest signature.
export function verifyStableSigningProof(raw, commit, trustedKeys = STABLE_TRUSTED_KEYS) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || !/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Signing proof rejected');
  const privateKey = createPrivateKey(raw);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw Error('Signing proof rejected');
  const pem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }), id = keyId(pem);
  if (!Object.hasOwn(trustedKeys, id) || keyId(trustedKeys[id]) !== id) throw Error('Signing proof rejected');
  const challenge = Buffer.from('guan-ai-workbench/signing-key-qa/v1\n' + commit);
  if (!verify(null, challenge, createPublicKey(trustedKeys[id]), sign(null, challenge, privateKey))) throw Error('Signing proof rejected');
  return { ok: true, keyId: id, commit, releaseManifestSigned: false, releasePublished: false };
}
