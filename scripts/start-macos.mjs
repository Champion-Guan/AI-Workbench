import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import { runtimePaths, privateDirectory, readPrivateFile } from '../src/server/runtime-paths.mjs';
import { PortableLaunchdJobs, portableDescriptor, startPortableJob, desktopShortcut } from './lib/macos-launcher.mjs';

const run = promisify(execFile);
async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.length !== 2) throw Error('macos_launcher_arguments_invalid');
  const root = await realpath(fileURLToPath(new URL('../', import.meta.url))), paths = runtimePaths({ projectRoot: root });
  const node = await realpath(process.execPath);
  const development = await readPrivateFile(path.join(paths.root, 'development/source.json'), { maxBytes: 4096 });
  if (development !== null) {
    const record = JSON.parse(development);
    if (record.version !== 1 || record.root !== root || record.node !== node) throw Error('development_source_mismatch');
    await run(node, [path.join(root, 'scripts/start-source-workbench.mjs'), '--open'], { timeout: 90000, maxBuffer: 65536 });
    try { await desktopShortcut({ desktop: path.join(homedir(), 'Desktop'), node, root }); }
    catch { console.log('桌面入口未创建，源码工作台仍正常运行。'); }
    return;
  }
  const agents = path.join(homedir(), 'Library/LaunchAgents'), logs = path.join(paths.root, 'logs/launcher');
  const current = await readPrivateFile(path.join(paths.root, 'installation/current.json'), { maxBytes: 4096 });
  if (current !== null) {
    // Signed supervisor remains the sole owner; never spawn a portable second service.
    await run(process.execPath, [path.join(root, 'scripts/open-managed-workbench.mjs')], { timeout: 90000, maxBuffer: 65536 });
  } else {
    if (await readPrivateFile(path.join(paths.root, 'updater-deployment/deployment.json'), { maxBytes: 16384 }) !== null
      || await readPrivateFile(path.join(paths.root, 'installation/bootstrap.json'), { maxBytes: 4096 }) !== null) throw Error('update_recovery_required');
    const probe = async () => {
      try {
        const response = await fetch('http://127.0.0.1:8888/local-app/health', { signal: AbortSignal.timeout(1500), redirect: 'error' });
        const health = await response.json();
        if (!response.ok || health.app !== 'guan-ai-workbench' || !health.ready || health.maintenance || health.origin !== 'http://127.0.0.1:8888') throw Error('service_port_occupied');
        return true;
      } catch (error) { if (error?.cause?.code === 'ECONNREFUSED') return false; throw Error('service_port_occupied'); }
    };
    if (!await probe()) {
      await mkdir(agents, { recursive: true, mode: 0o700 }); await privateDirectory(logs);
      const descriptor = portableDescriptor({ node, root, privateRoot: paths.root, agents, logs });
      await startPortableJob({ descriptor, jobs: new PortableLaunchdJobs() });
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await probe()) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw Error('service_start_failed');
    }
    await run('/usr/bin/open', ['http://localhost:8888']);
  }
  try {
    const shortcut = await desktopShortcut({ desktop: path.join(homedir(), 'Desktop'), node: process.execPath, root });
    console.log(shortcut.created ? '已创建桌面 AI-Workbench 入口。' : '桌面 AI-Workbench 入口已存在。');
  } catch { console.log('桌面入口未创建：已有同名文件或桌面权限不足，工作台仍正常运行。'); }
  console.log('工作台已启动：http://localhost:8888。由后台服务管理，可以关闭此终端。');
}
main().catch(error => { console.error(/^[a-z_]{1,80}$/.test(error?.message || '') ? error.message : 'macos_launcher_failed'); process.exitCode = 1; });
