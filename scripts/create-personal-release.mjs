// Explicit opt-in private migration package. Never read or print credential values.
import { mkdtemp, mkdir, readFile, writeFile, cp, chmod, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [archive, channelFile, proxyFile, destination] = process.argv.slice(2);
if (!archive || !channelFile || !proxyFile || !destination) throw Error('Usage: node scripts/create-personal-release.mjs public.zip exported-config.json proxy.yaml destination-directory');
const exported = JSON.parse(await readFile(channelFile, 'utf8'));
if (exported.app !== 'infinite-canvas' || exported.version !== 1 || !Array.isArray(exported.config?.channels) || !exported.config.channels.length) throw Error('Invalid channel configuration export.');
const temp = await mkdtemp(path.join(tmpdir(), 'guan-personal-release-'));
await chmod(temp, 0o700);
execFileSync('unzip', ['-q', path.resolve(archive), '-d', temp]);
const [folder] = await readdir(temp);
const stage = path.join(temp, folder);
const privateDir = path.join(stage, 'personal-config');
await mkdir(privateDir, { mode: 0o700 });
const channels = {
  app: exported.app, version: exported.version, exportedAt: exported.exportedAt,
  config: exported.config,
  webdav: { url: '', username: '', password: '', directory: 'infinite-canvas', lastSyncedAt: '' },
  promptSources: { sources: [], schedule: { intervalMinutes: 0, lastFetchedAt: '' } },
};
await writeFile(path.join(privateDir, 'channels.json'), JSON.stringify(channels, null, 2), { mode: 0o600 });
await cp(proxyFile, path.join(stage, 'config/default-proxy.yaml'));
await chmod(path.join(stage, 'config/default-proxy.yaml'), 0o600);
const instructions = '个人迁移版本 — 含真实 API 密钥和网络代理凭据，ZIP 未加密，请勿分享或上传公开位置。\n\n新电脑：\n1. 按 START-HERE.txt 启动工作台。\n2. 打开右上角设置 → 导入配置，选择 personal-config/channels.json。\n3. 网络代理配置已放在 config/default-proxy.yaml；macOS/Linux 启动时读取此文件。首次下载 Mihomo 需要网络。\n4. Windows 仍需安装外部代理，不能使用内置 Mihomo 自动下载。\n5. 画布、图片、Excel 及完整生成历史不在此包中，请另外迁移。\n\n这里只迁移渠道及对应偏好，不迁移 WebDAV 凭据或提示词订阅；导入此配置会将 WebDAV/提示词订阅重置为空，请仅在新电脑空白工作台导入。\n此文件说明优先于公共版迁移文档关于不含私人配置的描述。\n';
await writeFile(path.join(stage, 'PRIVATE-README.txt'), instructions);
await writeFile(path.join(stage, 'START-HERE.txt'), instructions + '\n启动入口：macOS scripts/start.command；Windows scripts/start.bat；Linux sh scripts/start.sh。\n');
const manifest = JSON.parse(await readFile(path.join(stage, 'RELEASE.json'), 'utf8'));
manifest.edition = 'personal-private';
manifest.containsCredentials = true;
manifest.packagedAt = new Date().toISOString();
manifest.included = 'production files, source, runtime dependency, private channel configuration and network proxy configuration';
manifest.excluded = 'browser canvas data, WebDAV credentials, logs, Git history';
manifest.files = {};
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if ((await lstat(file)).isSymbolicLink()) throw Error('Unexpected symlink.');
    if (entry.isDirectory()) { await inventory(file); continue; }
    const relative = path.relative(stage, file).split(path.sep).join('/');
    if (relative === 'RELEASE.json') continue;
    manifest.files[relative] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
}
await inventory(stage);
await writeFile(path.join(stage, 'RELEASE.json'), JSON.stringify(manifest, null, 2));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const zip = path.resolve(destination, `guan-ai-workbench-v${manifest.version}-personal-${stamp}.zip`);
execFileSync('zip', ['-qr', zip, folder], { cwd: temp });
await chmod(zip, 0o600);
const sha256 = createHash('sha256').update(await readFile(zip)).digest('hex');
await writeFile(`${zip}.sha256`, `${sha256}  ${path.basename(zip)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ zip, channels: exported.config.channels.length, privateEdition: true }, null, 2));
console.log('Private staging directory preserved with owner-only permissions.');
