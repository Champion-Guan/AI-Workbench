import { fileURLToPath } from 'node:url';
import { checkStableBuildQa } from './lib/stable-build-qa.mjs';

async function main() {
  if (process.argv.length !== 2) throw Error('No arbitrary QA arguments');
  const result = await checkStableBuildQa({ root: fileURLToPath(new URL('../', import.meta.url)),
    expectedCommit: process.env.GUAN_QA_COMMIT, expectedArch: process.env.EXPECTED_ARCH,
    defaultBranch: process.env.GUAN_DEFAULT_BRANCH });
  console.log(JSON.stringify(result));
}
main().catch(() => { console.error('Build-only native QA refused: require exact committed default-branch source and matching native architecture. Nothing was published or installed.'); process.exitCode = 1; });
