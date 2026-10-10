import { verifyStableOwnerEnvironment } from './lib/stable-owner-approval.mjs';

try {
  await verifyStableOwnerEnvironment();
  console.log('Single-owner manual release approval verified; no installation authorized.');
} catch {
  console.error('Stable approval rejected: require private owner repository, owner dispatch/rerun, default branch and exact confirmed commit.');
  process.exitCode = 1;
}
