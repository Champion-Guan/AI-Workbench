import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { inspectMigrationPorts } from './lib/port-migration-preflight.mjs';
import { runtimePaths } from '../src/server/runtime-paths.mjs';
import { migrationPackage } from './lib/port-migration-package.mjs';

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
    console.log('仅适用于已接入独立 launchd 更新器的 macOS arm64 工作台。旧个人包/未接管服务请先安全接入。');
    // Fail before creating any backup/bridge if the old installation is unmanaged.
    const paths = runtimePaths({ projectRoot: root });
    for (const item of ['installation/current.json', 'updater-deployment/deployment.json'])
      await readFile(path.join(paths.root, item));
    const previous = JSON.parse(await readFile(path.join(paths.root, 'installation/current.json')));
    if (!/^[0-9A-Za-z.+-]{1,160}$/.test(previous.id || '')) throw Error('migration_installation_invalid');
    const { workbenchPageCensus: oldCensus } = await import(path.join(paths.root, 'installation/versions', previous.id, 'src/server/workbench-page-census.mjs'));
    const { workbenchPageCensus } = await import('../src/server/workbench-page-census.mjs');
    const closed = async () => {
      for (const census of [oldCensus, workbenchPageCensus]) {
        const value = await census(); if (!value.workbenchPagesClosed || value.blockers.length) throw Error('migration_pages_open');
      }
    };
    await closed();
    console.log('正在获取并核验正式 arm64 安装包（可信签名、SHA-256 及文件清单）…');
    const artifact = await migrationPackage({ directory: args[0] ? path.resolve(args[0]) : undefined,
      updates: paths.updates, currentVersion: state.version });
    const artifacts = artifact.directory;
    if (cancelled) throw Error('migration_cancelled');
    await closed();
    console.log('工作台页面已关闭，开始一键备份与迁移。其他网站和应用保持不变。');
    let buffer = '', ready, rejectReady;
    const started = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
    rejectStarted = rejectReady;
    bridge = spawn(process.execPath, [path.join(root, 'scripts/port-migration-bridge.mjs'), '--automatic'], {
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
    const installer = spawn(process.execPath, [path.join(root, 'scripts/migrate-production-port.mjs'), 'install', artifacts, info.backupDirectory],
      { cwd: root, env: process.env, stdio: 'inherit' });
    const [code] = await once(installer, 'exit');
    if (code !== 0) throw Error('migration_install_unconfirmed');
    const health = await inspectMigrationPorts();
    if (health.state !== 'already-migrated' || health.version !== artifact.version) throw Error('migration_health_unconfirmed');
    console.log(`迁移完成：http://localhost:8888\n旧浏览器数据保留。私人备份：${info.backupDirectory}`);
    await execute('/usr/bin/open', ['http://localhost:8888']);
  } finally {
    await stopBridge(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
main().catch(error => {
  const messages = { migration_pages_open: '请先保存并关闭 5174/8888 工作台页面。',
    migration_browser_unverified: '浏览器迁移未通过：需要同一 Chrome 配置中已加载 1.0.1 版工作台扩展。',
    migration_download_failed: '正式安装包下载或验证失败，请检查 GitHub 网络连接后重试。' };
  console.error(messages[error?.message] || '预检查、下载验证或服务切换未通过。');
  console.error('迁移安全停止，旧数据和备份均保留。目标已有数据、端口被占用、未完成浏览器校验或未接入独立更新器时不能继续。请勿清空数据或强杀端口；查阅 docs/8888生产迁移.md。');
  process.exitCode = 1;
});
