import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { inspectMigrationPorts } from './lib/port-migration-preflight.mjs';
import { runtimePaths, writePrivateFile } from '../src/server/runtime-paths.mjs';
import { migrationPackage } from './lib/port-migration-package.mjs';
import { migrationInstallationMode, inspectPortableService } from './lib/portable-handoff.mjs';
import { migrationNetworks } from './lib/migration-network.mjs';
import { desktopShortcut } from './lib/macos-launcher.mjs';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
async function main() {
  const args = process.argv.slice(2);
  if (process.platform !== 'darwin' || process.arch !== 'arm64'
    || args.length > 1) throw Error('migration_arguments_invalid');
  const state = await inspectMigrationPorts();
  if (state.state === 'already-migrated') {
    console.log('8888 工作台已正常运行，为避免覆盖数据，已跳过重复迁移；没有修改任何数据。'); return;
  }
  if (args[0] === '--check') { console.log('5174 服务正常，8888 未监听。预检查通过，未修改任何数据。'); return; }
  let bridge, exited, bridgeClosed = false, cancelled = false, rejectStarted;
  const cancel = () => { cancelled = true; rejectStarted?.(Error('migration_cancelled')); bridge?.kill('SIGTERM'); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const stopBridge = async () => {
    if (!bridge || bridgeClosed) return;
    bridge.kill('SIGTERM'); await exited;
  };
  try {
    const paths = runtimePaths({ projectRoot: root });
    const installationMode = await migrationInstallationMode(paths.root);
    const legacy = installationMode === 'portable'
      ? await inspectPortableService({ version: state.version, privateRoot: paths.root }) : null;
    const { workbenchPageCensus } = await import('../src/server/workbench-page-census.mjs');
    const closed = async () => {
      const value = await workbenchPageCensus({ ports: [5174, 8888] });
      if (!value.workbenchPagesClosed || value.blockers.length) throw Error('migration_pages_open');
    };
    console.log(legacy ? '检测到解压运行的 v1.0.7，将备份并首次接入独立更新器，再迁移到 8888。' : '检测到已接管工作台，将迁移到 8888。');
    console.log('运行本脚本表示开始维护。请事先保存画布、结束生成任务并关闭工作台页面；不会关闭其他网站。');
    await closed();
    console.log('正在获取并核验正式 arm64 安装包（可信签名、SHA-256 及文件清单）…');
    const artifact = await migrationPackage({ directory: args[0] ? path.resolve(args[0]) : undefined,
      updates: paths.updates, currentVersion: state.version, networks: await migrationNetworks(paths),
      onProgress: value => {
        if (value.phase === 'checking-release') console.log(`正在检查正式版本（${value.network === 'proxy' ? '本机代理' : '直连'}）…`);
        else if (value.phase === 'network-failed') console.log('当前连接失败，尝试下一个本机网络通道；不会修改代理设置。');
        else if (value.state === 'downloading') console.log(`安装包下载：${value.progress}%`);
        else if (value.state === 'verifying-manifest') console.log('正在下载并验证签名清单…');
      } });
    const artifacts = artifact.directory;
    if (cancelled) throw Error('migration_cancelled');
    await closed();
    console.log('工作台页面已关闭，开始一键备份与迁移。其他网站和应用保持不变。');
    let buffer = '', ready, rejectReady;
    const started = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
    rejectStarted = rejectReady;
    bridge = spawn(process.execPath, [path.join(root, 'scripts/port-migration-bridge.mjs'), legacy ? '--automatic-portable' : '--automatic'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    let sourceBackedUp = false, verified = false;
    exited = new Promise(resolve => {
      bridge.once('exit', () => { bridgeClosed = true; rejectReady(Error('migration_bridge_stopped')); resolve(); });
      bridge.once('error', () => { bridgeClosed = true; rejectReady(Error('migration_bridge_stopped')); resolve(); });
    });
    bridge.stderr.resume(); // Never echo private source/config/parser errors.
    bridge.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 65536) { rejectReady(Error('migration_bridge_invalid')); bridge.kill('SIGTERM'); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.migrationUrl && value.backupDirectory) ready(value);
          if (value.phase === 'source-backed-up') sourceBackedUp = true;
          if (value.phase === 'browser-verified' && value.verified === true) verified = true;
        } catch { rejectReady(Error('migration_bridge_invalid')); }
      }
    });
    const info = await started;
    const url = new URL(info.migrationUrl);
    if (url.origin !== 'http://127.0.0.1:8888' || !/^\/migration-[a-f0-9-]{36}$/.test(url.pathname)
      || path.dirname(info.backupDirectory) !== paths.backups) throw Error('migration_bridge_invalid');
    if (legacy) await writePrivateFile(path.join(info.backupDirectory, 'PORTABLE-SERVICE.json'), JSON.stringify(legacy), { exclusive: true });
    // Use the existing Chrome profile/extension, never a new empty user-data-dir.
    // Restored customer workbench tabs still veto export and installation.
    await execute('/usr/bin/open', ['-a', 'Google Chrome']);
    console.log('私人文件已备份，等待现有工作台扩展自动复制同一 Chrome 配置中的浏览器数据…');
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!verified) {
      if (cancelled || bridgeClosed || Date.now() > deadline) throw Error('migration_browser_unverified');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!sourceBackedUp) throw Error('migration_source_unverified');
    // Allow the extension to close only its temporary migration pages.
    let pagesClosed = false;
    for (let n = 0; n < 20; n++) {
      try { await closed(); pagesClosed = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!pagesClosed) throw Error('migration_pages_open');
    if (cancelled) throw Error('migration_cancelled');
    await stopBridge(); // Release only our exact bridge process, never kill by port.
    console.log('正在核验签名、暂存版本并切换独立服务…');
    const installerArgs = legacy
      ? [path.join(root, 'scripts/bootstrap-stable-updater.mjs'), '--migration-bootstrap', artifacts, info.backupDirectory]
      : [path.join(root, 'scripts/migrate-production-port.mjs'), 'install', artifacts, info.backupDirectory];
    const installer = spawn(process.execPath, installerArgs,
      { cwd: root, env: process.env, stdio: 'inherit' });
    const [code] = await once(installer, 'exit');
    if (code !== 0) throw Error('migration_install_unconfirmed');
    const health = await inspectMigrationPorts();
    if (health.state !== 'already-migrated' || health.version !== artifact.version) throw Error('migration_health_unconfirmed');
    console.log(`迁移完成：http://localhost:8888\n旧浏览器数据保留。私人备份：${info.backupDirectory}`);
    try {
      await desktopShortcut({ desktop: path.join(homedir(), 'Desktop'), node: process.execPath, root });
      console.log('桌面 AI-Workbench 入口已就绪。独立后台服务运行后可以关闭终端。');
    } catch { console.log('桌面入口未创建（已有同名文件或权限不足），后台服务仍正常运行。'); }
    await execute('/usr/bin/open', ['http://localhost:8888']);
  } finally {
    await stopBridge(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
main().catch(error => {
  const reason = error?.code || error?.message;
  const messages = { migration_pages_open: '请先保存并关闭 5174/8888 工作台页面。',
    migration_installation_incomplete: '更新器安装记录不完整，已停止，不能将它当成普通便携服务接管。',
    migration_recovery_required: '存在未完成的首次接管或更新事务，请先恢复，不会覆盖记录。',
    migration_portable_version_unsupported: '首次接管目前支持解压运行的 v1.0.7，请先运行该版本。',
    migration_service_identity_unknown: '无法核实 5174 服务的进程和 v1.0.7 目录，旧服务没有停止。',
    migration_private_root_mismatch: '旧服务使用了不同的私人数据目录，已停止，避免迁移到错误位置。',
    migration_browser_unverified: '浏览器迁移未通过：需要同一 Chrome 配置中已加载 1.0.1 版工作台扩展。',
    migration_download_failed: '正式安装包下载失败，请检查 GitHub 网络连接后重试。',
    github_network_failed: '无法连接 GitHub：直连和已发现的本机代理均未成功。',
    asset_download_failed: 'GitHub 安装包连接失败：请确认代理允许 github.com 和 release-assets.githubusercontent.com。',
    asset_download_timeout: 'GitHub 安装包下载超时，请检查代理连接后重试。',
    rate_limited: 'GitHub 接口限流，请稍后重试。',
    asset_access_denied: 'GitHub 下载被拒绝或限流，请稍后重试。',
    signature_invalid: '正式安装包签名验证失败，已停止；不会绕过签名。',
    package_integrity_failed: '安装包内容不完整或损坏，已停止。',
    disk_space_insufficient: '磁盘空间不足，请释放空间后重试。' };
  console.error(messages[reason] || '预检查、下载验证或服务切换未通过。');
  if (/^[a-z_]{1,80}$/.test(reason || '')) console.error(`错误代码：${reason}`);
  console.error('迁移安全停止，旧数据和备份均保留。请勿清空数据或强杀端口；查阅 docs/8888生产迁移.md。');
  process.exitCode = 1;
});
