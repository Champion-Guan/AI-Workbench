import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildStablePackage } from './lib/stable-package.mjs';

async function main() {
  const legacyClientBridge = process.argv.length === 3 && process.argv[2] === '--legacy-client-bridge';
  if (process.argv.length !== 2 && !legacyClientBridge) throw Error('No arbitrary build arguments accepted');
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Official stable artifacts must be built from a committed tree, never from
  // an untracked personal migration package. Local dirty builds remain portable.
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim()) throw Error('Stable requires a clean committed tree');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const portable = JSON.parse(execFileSync(process.execPath, ['scripts/create-release.mjs', '--canvas-build', '--native-helper'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  const result = await buildStablePackage({ root, portableDirectory: portable.zip.slice(0, -4),
    runtimeDirectory: path.join(root, 'output/stable-runtime', process.arch), output: path.join(root, 'output/stable'), commit, legacyClientBridge });
  console.log(JSON.stringify({ ok: true, ...result, signed: false, installAllowed: false }));
}
main().catch(() => { console.error('Stable build refused: require a clean committed tree, current canvas/native build and verified official runtime. User data was not changed.'); process.exitCode = 1; });
