import { cp, mkdir, readdir, readFile, writeFile, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { scanContent } from './lib/secret-scan.mjs';
import { verifyCanvasBuild, copyVerifiedCanvasBuild } from './lib/canvas-build.mjs';
import { verifyNativeKeychainBuild } from './lib/native-keychain-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.slice(2).some(value => !['--canvas-build', '--native-helper'].includes(value))) throw Error('Unknown portable release option');
const useBuiltCanvas = process.argv.includes('--canvas-build');
const useNativeHelper = process.argv.includes('--native-helper');
const nativeBuild = useNativeHelper ? await verifyNativeKeychainBuild(root, path.join(root, 'output/native')) : null;
if (useBuiltCanvas) await verifyCanvasBuild(root, path.join(root, 'src/canvas/dist'));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const build = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const name = `guan-ai-workbench-v${version}-${build}`;
const out = path.join(root, 'output/releases');
const stage = path.join(out, name);
await mkdir(out, { recursive: true, mode: 0o700 });
await mkdir(stage, { mode: 0o700 });
// Portable runtime allowlist. Never copy the whole source tree or test fixtures.
const entries = ['server.mjs', 'package.json', 'package-lock.json', 'README.md', 'UI-PROTECTION.md', 'public', 'src/server', 'src/shared', 'scripts/start-portable.mjs', 'scripts/start.command', 'scripts/start.sh', 'scripts/start.bat', 'scripts/authorize-updates.mjs', 'docs/MIGRATION.md', 'docs/PROJECT-STRUCTURE.md', 'docs/PROJECT-GOAL.md', 'docs/PHASE2-ACCEPTANCE.md', 'docs/STABLE-UPDATES-PHASE3.md', 'docs/STABLE-UPDATES-PHASE4.md'];
const filter = file => {
  const relative = path.relative(root, file);
  if (useBuiltCanvas && relative.split(path.sep).slice(0, 2).join('/') === 'public/infinite-canvas') return false;
  const parts = relative.split(path.sep);
  return !parts.some(part => part.startsWith('.') || part === 'node_modules' || part === 'dist' || part === 'output');
};
for (const entry of entries) {
  await mkdir(path.dirname(path.join(stage, entry)), { recursive: true });
  await cp(path.join(root, entry), path.join(stage, entry), { recursive: true, filter, dereference: false });
}
const canvasBuild = useBuiltCanvas ? await copyVerifiedCanvasBuild(root, path.join(root, 'src/canvas/dist'), path.join(stage, 'public/infinite-canvas')) : null;
if (nativeBuild) {
  if (nativeBuild.manifest.arch !== process.arch || process.platform !== 'darwin') throw Error('Native package architecture mismatch');
  for (const entry of ['src/native/keychain-helper.swift', 'scripts/install-keychain-helper.mjs', 'scripts/lib/native-keychain-build.mjs']) {
    await mkdir(path.dirname(path.join(stage, entry)), { recursive: true });
    await cp(path.join(root, entry), path.join(stage, entry));
  }
  await mkdir(path.join(stage, 'bin'), { recursive: true });
  await cp(path.join(root, 'output/native/guan-keychain'), path.join(stage, 'bin/guan-keychain'));
  await cp(path.join(root, 'output/native/KEYCHAIN-BUILD.json'), path.join(stage, 'bin/KEYCHAIN-BUILD.json'));
  await verifyNativeKeychainBuild(stage, path.join(stage, 'bin'));
}
const runtimePackage = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'));
runtimePackage.scripts = { start: 'node server.mjs', 'start:portable': 'node scripts/start-portable.mjs' };
await writeFile(path.join(stage, 'package.json'), JSON.stringify(runtimePackage, null, 2) + '\n');
// undici is pure JavaScript: include its installed, locked runtime dependency.
await mkdir(path.join(stage, 'node_modules'), { recursive: true });
await cp(path.join(root, 'node_modules/undici'), path.join(stage, 'node_modules/undici'), { recursive: true });
await mkdir(path.join(stage, 'config/examples'), { recursive: true });
await cp(path.join(root, 'config/examples/default-proxy.yaml'), path.join(stage, 'config/examples/default-proxy.yaml'));
await writeFile(path.join(stage, 'START-HERE.txt'), '先阅读 docs/MIGRATION.md。\nmacOS: scripts/start.command\nWindows: scripts/start.bat\nLinux: sh scripts/start.sh\n需要 Node.js 18.17+。\n此发布包不包含你的浏览器画布数据和个人渠道配置，请从旧电脑另外导出迁移。\n');
for (const file of ['scripts/start.command', 'scripts/start.sh']) await chmod(path.join(stage, file), 0o755);
const files = {};
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Release must not contain symlinks.');
    if (entry.isDirectory()) { await inventory(file); continue; }
    const content = await readFile(file);
    // Fail closed on literal API keys; report filename only, never matched values.
    if (scanContent(path.relative(stage, file), content).length) throw new Error('Potential secret/private content detected; portable packaging stopped.');
    files[path.relative(stage, file).split(path.sep).join('/')] = createHash('sha256').update(content).digest('hex');
  }
}
await inventory(stage);
await writeFile(path.join(stage, 'RELEASE.json'), JSON.stringify({
  app: 'guan-ai-workbench', edition: 'portable-unsigned', channel: 'portable', automaticInstallAllowed: false,
  version, build, builtAt: new Date().toISOString(),
  runtime: 'Node.js >=18.17', entry: 'server.mjs',
  included: useBuiltCanvas ? 'verified current-source canvas build, allowlisted server/shared runtime, locked undici dependency' : 'current production assets, allowlisted server/shared runtime, locked undici dependency',
  canvasBuild: canvasBuild ? { version: canvasBuild.version, sourceHash: canvasBuild.sourceHash } : null,
  nativeHelper: nativeBuild ? nativeBuild.manifest : null,
  excluded: 'personal configs, private proxy nodes, browser data, logs, Git history, canvas dev dependencies',
  files,
}, null, 2));
const zip = path.join(out, `${name}.zip`);
execFileSync('zip', ['-qr', zip, name], { cwd: out });
await chmod(zip, 0o600);
const sha256 = createHash('sha256').update(await readFile(zip)).digest('hex');
await writeFile(`${zip}.sha256`, `${sha256}  ${path.basename(zip)}\n`);
console.log(JSON.stringify({ zip, sha256, files: Object.keys(files).length }, null, 2));
