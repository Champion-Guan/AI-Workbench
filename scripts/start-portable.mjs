import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform === 'darwin') {
  const { once } = await import('node:events');
  const launcher = spawn(process.execPath, [path.join(root, 'scripts/start-macos.mjs')], { stdio: 'inherit' });
  const [code] = await once(launcher, 'exit'); process.exit(code ?? 1);
}
process.chdir(root);
const port = Number(process.env.PORT || 8888);
const url = `http://127.0.0.1:${port}/`;
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error('需要 Node.js 18.17 或更新版本。');
  process.exit(1);
}
const ready = async () => {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
};
const openBrowser = () => {
  const command = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd.exe', '/c', 'start', '', url]
    : ['xdg-open', url];
  const child = spawn(command[0], command.slice(1), { stdio: 'ignore' });
  child.on('error', () => console.log(`请手动打开 ${url}`));
  child.unref();
};
if (await ready()) {
  console.log(`端口已有网页服务响应：${url}。未启动第二个服务。`);
  openBrowser();
  process.exit(0);
}
if (!existsSync(path.join(root, 'node_modules/undici/package.json'))) {
  console.log('首次运行：安装锁定的运行依赖，需要网络连接。');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(npm, ['ci', '--omit=dev', '--ignore-scripts'], {
      cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exit(1);
}
const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, stdio: 'inherit' });
let ended = false;
child.once('error', error => { ended = true; console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { ended = true; process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
process.on('exit', () => { if (!ended) child.kill('SIGTERM'); });
for (let attempt = 0; attempt < 30 && !ended; attempt++) {
  if (await ready()) {
    console.log(`工作台已启动：${url}。关闭此终端将停止服务。`);
    openBrowser();
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (attempt === 29) console.error(`服务未及时就绪，请查看上方日志。地址：${url}`);
}
