import { readFile, readdir, lstat, cp, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { scanContent, MAX_SCAN_BYTES } from './secret-scan.mjs';
import { verifyCanvasBuild } from './canvas-build.mjs';
import { verifyNativeKeychainBuild } from './native-keychain-build.mjs';
import { verifyStableRuntime, machArchitecture } from './stable-runtime.mjs';
import { privateDirectory, writePrivateFile } from '../../src/server/runtime-paths.mjs';
import { sha256 } from '../../src/server/stable-manifest.mjs';
import { parseVersion } from '../../src/server/stable-version.mjs';
import { validateZipArchive, verifyReleaseFiles } from './release-validation.mjs';

export async function buildStablePackage({ root, portableDirectory, runtimeDirectory, output, commit }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !/^[a-f0-9]{40}$/.test(commit)) throw Error('Native arm64 stable build identity required');
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  if (!parseVersion(version) || parseVersion(version).pre.length) throw Error('Stable version required');
  await verifyCanvasBuild(root, path.join(root, 'src/canvas/dist'));
  const portable = await verifyReleaseFiles(portableDirectory);
  if (portable.manifest.edition !== 'portable-unsigned' || !portable.manifest.canvasBuild || !portable.manifest.nativeHelper) throw Error('Verified portable build and native helper required');
  await verifyNativeKeychainBuild(portableDirectory, path.join(portableDirectory, 'bin'));
  const runtime = await verifyStableRuntime(runtimeDirectory, process.arch);
  const identity = JSON.parse(execFileSync(path.join(runtimeDirectory, 'node'), ['-p', 'JSON.stringify({version:process.version,arch:process.arch,platform:process.platform})'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (identity.version !== runtime.nodeVersion || identity.arch !== process.arch || identity.platform !== 'darwin') throw Error('Bundled runtime failed native execution');
  const name = `guan-ai-workbench-v${version}-macos-${process.arch}`, stage = path.join(output, name);
  await privateDirectory(output);
  await cp(portableDirectory, stage, { recursive: true, force: false, errorOnExist: true });
  await privateDirectory(path.join(stage, 'runtime'));
  for (const file of ['node', 'LICENSE', 'NODE-RUNTIME.json']) await cp(path.join(runtimeDirectory, file), path.join(stage, 'runtime', file));
  await cp(path.join(root, 'scripts/start-stable.command'), path.join(stage, 'scripts/start-stable.command'));
  await chmod(path.join(stage, 'scripts/start-stable.command'), 0o755);
  await writePrivateFile(path.join(stage, 'START-HERE.txt'), 'macOS 稳定版：scripts/start-stable.command\n内置本机架构 Node；Origin 保持 http://127.0.0.1:5174。\n不包含个人配置、代理核心、画布或生成记录。\n首次接入先备份旧电脑数据，参考 docs/STABLE-UPDATES-PHASE4.md。\n');
  const files = {};
  async function inventory(directory) {
    for (const entry of (await readdir(directory)).sort()) {
      const file = path.join(directory, entry), info = await lstat(file), relative = path.relative(stage, file).split(path.sep).join('/');
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw Error('Unsafe stable file');
      if (info.isDirectory()) { await inventory(file); continue; }
      if (relative === 'RELEASE.json') continue;
      if (info.size > (relative === 'runtime/node' ? runtime.runtimeSize : MAX_SCAN_BYTES)) throw Error('Stable file too large');
      const bytes = await readFile(file);
      if (relative === 'runtime/node') {
        if (sha256(bytes) !== runtime.runtimeSha256 || machArchitecture(bytes) !== process.arch) throw Error('Stable runtime changed');
      } else if (scanContent(relative, bytes).length) throw Error('Stable secret scan failed');
      files[relative] = sha256(bytes);
    }
  }
  await inventory(stage);
  const manifest = { ...portable.manifest, edition: 'stable', channel: 'stable', automaticInstallAllowed: false,
    commit, arch: process.arch, platform: 'darwin', runtime: runtime.nodeVersion, bundledRuntime: { runtimeSha256: runtime.runtimeSha256, runtimeSize: runtime.runtimeSize }, files };
  await writePrivateFile(path.join(stage, 'RELEASE.json'), JSON.stringify(manifest, null, 2) + '\n');
  await verifyReleaseFiles(stage, { trustedRuntime: runtime });
  const archive = path.join(output, name + '.zip');
  // Refuse zip's append-to-existing behavior.
  try { await lstat(archive); throw Error('Stable archive exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  execFileSync('zip', ['-qr', archive, name], { cwd: output, stdio: 'pipe' }); await chmod(archive, 0o600);
  const bytes = await readFile(archive); validateZipArchive(bytes, { trustedRuntime: runtime });
  const descriptor = { platform: 'darwin', arch: process.arch, name: name + '.zip', sha256: sha256(bytes), size: bytes.length,
    nodeVersion: runtime.nodeVersion, runtimeSha256: runtime.runtimeSha256, runtimeSize: runtime.runtimeSize };
  await writePrivateFile(path.join(output, 'package-' + process.arch + '.json'), JSON.stringify({ version, commit, descriptor }, null, 2) + '\n', { exclusive: true });
  return { archive, descriptor, version, commit };
}
