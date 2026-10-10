import path from 'node:path';
import { verifySignedStable } from './lib/signed-stable.mjs';

async function main() {
  const [directory, repository, version, arch] = process.argv.slice(2);
  if (process.argv.length !== 6 || !path.isAbsolute(directory) || !['arm64', 'x64'].includes(arch)) throw Error('Invalid verification arguments');
  const result = await verifySignedStable({ directory, repository, version, arch });
  console.log(JSON.stringify({ ok: true, version: result.manifest.version, arch, files: result.files, signatureVerified: true, executed: false, installAllowed: false }));
}
main().catch(() => { console.error('Signed stable verification failed; no package was executed or installed.'); process.exitCode = 1; });
