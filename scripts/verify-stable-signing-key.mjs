import { verifyStableSigningQaEnvironment } from './lib/stable-owner-approval.mjs';
import { verifyStableSigningProof } from './lib/stable-signing-proof.mjs';

try {
  const approval = await verifyStableSigningQaEnvironment();
  const raw = process.env.GUAN_STABLE_SIGNING_KEY;
  delete process.env.GUAN_STABLE_SIGNING_KEY;
  console.log(JSON.stringify(verifyStableSigningProof(raw, approval.commit)));
} catch {
  console.error('Signing-only QA rejected safely. Check owner approval, Secret and pinned public key; no private data logged, no release created.');
  process.exitCode = 1;
}
