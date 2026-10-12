// Manual browser QA only: run the real bridge with ephemeral ports/private data.
// Production entry points remain fixed to 5174/8888. No customer Origin is used.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const portable = process.argv[2] === '--portable';
const temporary = await mkdtemp(path.join(tmpdir(), 'guan-migration-browser-'));
for (const name of ['data', 'installation', 'updater-deployment']) await mkdir(path.join(temporary, name));
await writeFile(path.join(temporary, 'data', 'fixture.json'), '{"qa":true}');
if (!portable) {
  await writeFile(path.join(temporary, 'installation', 'current.json'), '{}');
  await writeFile(path.join(temporary, 'updater-deployment', 'deployment.json'), '{}');
}
const source = createServer((req, res) => {
  if (req.url === '/seed') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<p id="result">准备 QA 数据</p><script>
localStorage.setItem('qa-canvas',JSON.stringify({name:'迁移测试',nodes:[1,2,3]}));
const r=indexedDB.open('qa-images',1);r.onupgradeneeded=()=>r.result.createObjectStore('images');
r.onsuccess=()=>{const t=r.result.transaction('images','readwrite');t.objectStore('images').add(new Blob(['QA图像字节']), 'qa-image');t.oncomplete=()=>{r.result.close();document.querySelector('#result').textContent='QA 数据已保存';}};
</script>`); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"app":"qa-blank-health"}');
});
await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
const sourceOrigin = 'http://127.0.0.1:' + source.address().port;
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port, targetOrigin = 'http://127.0.0.1:' + port;
await new Promise(resolve => reserve.close(resolve));
let code = await readFile(path.join(root, 'scripts/port-migration-bridge.mjs'), 'utf8');
code = code.replace("'../src/server/runtime-paths.mjs'", JSON.stringify(new URL('src/server/runtime-paths.mjs', new URL('../../', import.meta.url)).href))
  .replace('const projectRoot = fileURLToPath(new URL(\'../\', import.meta.url));', 'const projectRoot = ' + JSON.stringify(root) + ';')
  .replaceAll('http://127.0.0.1:5174', sourceOrigin).replaceAll('http://127.0.0.1:8888', targetOrigin)
  .replace("req.headers.host !== '127.0.0.1:8888'", "req.headers.host !== '127.0.0.1:" + port + "'")
  .replace("server.listen(8888,", 'server.listen(' + port + ',')
  .replace("[name, await readFile(path.join(projectRoot, 'src/shared/data-contract', name))]",
    "[name, Buffer.from((await readFile(path.join(projectRoot, 'src/shared/data-contract', name), 'utf8')).replaceAll('http://127.0.0.1:5174', '" + sourceOrigin + "').replaceAll('http://127.0.0.1:8888', '" + targetOrigin + "'))]");
const bridge = spawn(process.execPath, ['--input-type=module', '-e', code, '--', 'qa-bridge', portable ? '--automatic-portable' : '--automatic'], {
  cwd: root, env: { ...process.env, GUAN_WORKBENCH_DATA_DIR: temporary }, stdio: ['ignore', 'pipe', 'inherit'] });
// -e puts the first argument at argv[1], unlike a normal script.
// The QA bridge still emits the real nonce URL/receipts; automatic mode is made
// explicit here without adding any production environment override.
let buffer = '';
bridge.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const value = JSON.parse(line);
      console.log(JSON.stringify(value.migrationUrl ? { ...value, sourceOrigin, targetOrigin } : value));
    } catch { console.error('qa_bridge_output_invalid'); }
  }
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const stopped = new Promise(resolve => bridge.once('exit', resolve));
  bridge.kill('SIGTERM'); await stopped;
  await new Promise(resolve => source.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
