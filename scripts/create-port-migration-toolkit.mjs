// Local maintenance toolkit, not an unsigned application update. The tool only
// installs separately downloaded and verified Stable application assets.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, readFile, readdir, lstat, chmod, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { verifyStableRuntime } from './lib/stable-runtime.mjs';
import { scanContent } from './lib/secret-scan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [runtimeArgument] = process.argv.slice(2);
if (process.argv.length !== 3 || !path.isAbsolute(runtimeArgument || '')) throw Error('Use an absolute verified arm64 runtime directory');
await verifyStableRuntime(runtimeArgument, 'arm64');
const output = path.join(root, 'output/port-migration-toolkit', randomUUID());
const stage = path.join(output, '5174到8888一键迁移工具');
await mkdir(stage, { recursive: true, mode: 0o700 });
const entries = ['package.json', 'LICENSE', 'src/server', 'src/shared', 'browser/managed-workbench',
  'scripts/lib', 'scripts/run-port-migration.mjs', 'scripts/port-migration-bridge.mjs',
  'scripts/migrate-production-port.mjs', 'scripts/bootstrap-stable-updater.mjs', 'scripts/迁移5174到8888.command',
  'scripts/start-macos.mjs', 'scripts/open-managed-workbench.mjs',
  'docs/8888生产迁移.md', 'node_modules/undici'];
for (const name of entries) {
  await mkdir(path.dirname(path.join(stage, name)), { recursive: true });
  await cp(path.join(root, name), path.join(stage, name), { recursive: true, dereference: false });
}
await cp(runtimeArgument, path.join(stage, 'runtime'), { recursive: true, dereference: false });
await chmod(path.join(stage, 'scripts/迁移5174到8888.command'), 0o755);
await writeFile(path.join(stage, '双击迁移.command'), '#!/bin/sh\nset -eu\nTOOL_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$TOOL_DIRECTORY/scripts/迁移5174到8888.command" "$@"\n', { mode: 0o755 });
const extensionVersion = JSON.parse(await readFile(path.join(stage, 'browser/managed-workbench/manifest.json'))).version;
await writeFile(path.join(stage, '使用说明.txt'), `适用于 macOS arm64：解压运行 v1.0.7 的 5174 工作台，或已经接入更新器的旧工作台。\n请保留旧服务运行，保存画布并关闭工作台页面，然后双击“双击迁移.command”。无需控制台脚本或手动下载应用包。\n未发现扩展时自动打开 Chrome 扩展页及目录，请在原工作台的 Chrome 配置加载 browser/managed-workbench（${extensionVersion}）。首次加载需要 Chrome 授权，加载后自动继续。旧扩展需更新加载本目录。\n本工具不是应用 Stable 包，实际安装包从公开 GitHub 下载并验签。旧目录、5174 浏览器存储和私人备份保留。\n失败时不要清空 8888 数据或强杀端口，查看 docs/8888生产迁移.md。\n`);
async function scan(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw Error('Toolkit symlink refused');
    if (stat.isDirectory()) await scan(file);
    else if (!file.startsWith(path.join(stage, 'runtime') + path.sep)) {
      const bytes = await readFile(file);
      if (!bytes.includes(0) && scanContent(path.relative(stage, file), bytes).length) throw Error('Toolkit secret scan failed');
    }
  }
}
await scan(stage);
const archive = path.join(output, '5174到8888一键迁移工具-macOS-arm64.zip');
execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stage, archive]);
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', sha256 + '\n', { mode: 0o600 });
console.log(JSON.stringify({ archive, sha256, applicationPublished: false }));
