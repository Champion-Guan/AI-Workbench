// Explicit local maintenance tool. Does not start/stop the application, migrate
// credentials, delete storage or serve the workbench at the destination Origin.
import { createServer } from 'node:http';
import { readFile, open, cp, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runtimePaths, privateDirectory, writePrivateFile } from '../src/server/runtime-paths.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const paths = runtimePaths({ projectRoot });
const source = 'http://127.0.0.1:5174', target = 'http://127.0.0.1:8888';
const portable = process.argv[2] === '--automatic-portable';
const automatic = process.argv[2] === '--automatic' || portable;
const resume = automatic ? undefined : process.argv[2];
if (process.argv.length > 3 || resume && (!path.isAbsolute(resume) || path.dirname(resume) !== path.join(paths.root, 'backups')
  || !/^port8888-[a-f0-9-]{36}$/.test(path.basename(resume)))) throw Error('migration_arguments_invalid');
const directory = resume || path.join(paths.root, 'backups', 'port8888-' + randomUUID());
await privateDirectory(directory);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function inventory(root) {
  const files = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name), info = await lstat(file);
      if (info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('backup_source_unknown');
      if (info.isDirectory()) await walk(file);
      else if (info.isFile()) files.push({ name: path.relative(root, file), size: info.size, sha256: hash(await readFile(file)) });
      else throw Error('backup_source_unknown');
    }
  }
  await walk(root); return files;
}
const before = resume ? JSON.parse(await readFile(path.join(directory, 'PRIVATE-BACKUP.json'))).files : await inventory(paths.data);
if (!resume) {
await cp(paths.data, path.join(directory, 'data'), { recursive: true, force: false, errorOnExist: true });
if (JSON.stringify(before) !== JSON.stringify(await inventory(paths.data))
  || JSON.stringify(before) !== JSON.stringify(await inventory(path.join(directory, 'data')))) throw Error('backup_changed');
if (!portable) for (const name of ['installation', 'updater-deployment'])
  await cp(path.join(paths.root, name, name === 'installation' ? 'current.json' : 'deployment.json'), path.join(directory, name + '.json'));
await writePrivateFile(path.join(directory, 'PRIVATE-BACKUP.json'), JSON.stringify({ format: 1, mode: portable ? 'portable' : 'managed', files: before }));
}
const nonce = randomUUID(), prefix = '/migration-' + nonce;
const modules = Object.fromEntries(await Promise.all(['port-migration.mjs', 'browser-backup-codec.mjs'].map(async name =>
  [name, await readFile(path.join(projectRoot, 'src/shared/data-contract', name))])));
let snapshot = resume ? path.join(directory, 'browser-5174.json') : null;
let report = resume ? JSON.parse(await readFile(path.join(directory, 'MIGRATION.json'))) : { phase: 'waiting-source', privateFiles: before.length };
if (resume && hash(await readFile(snapshot)) !== report.sha256) throw Error('migration_backup_changed');
let uploading = false, claimant = null, browserStatus = null;
const exportScript = `import {exportBrowserStorage} from '${target + prefix}/port-migration.mjs';try{const r=await fetch('${target + prefix}/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await exportBrowserStorage())});if(!r.ok)throw Error();document.body.textContent='旧数据已备份，正在迁移…';}catch{document.body.textContent='备份未完成，旧数据保留。';}`;
const page = `<!doctype html><meta charset="utf-8"><title>工作台端口迁移</title><style>body{font:18px system-ui;margin:60px auto;max-width:760px;padding:24px}button{padding:12px}</style><h1>工作台迁移至 8888</h1><p>只复制并逐项校验，不覆盖或清空旧地址数据。旧地址备份已保存到本机私人备份目录。</p><button id="restore">复制旧地址数据并校验</button><pre id="status">等待旧地址备份完成</pre><script type="module">
import {restoreBrowserStorage} from '${prefix}/port-migration.mjs';
document.querySelector('#restore').onclick=async()=>{
 const status=document.querySelector('#status');
 try{
  status.textContent='正在复制并校验，请勿关闭页面…';
  const response=await fetch('${prefix}/snapshot');if(!response.ok)throw Error();
  const result=await restoreBrowserStorage(await response.json());
  const acknowledged=await fetch('${prefix}/verified',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
  if(!acknowledged.ok)throw Error();
  status.textContent='迁移与逐项内容校验通过，等待正式服务切换。';
 }catch{status.textContent='迁移未完成，旧地址数据和备份保留，禁止覆盖目标或打开新工作台。';}
};</script>`;
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== '127.0.0.1:8888') { res.writeHead(403); return res.end(); }
    const origin = req.headers.origin;
    const extensionControl = /^chrome-extension:\/\/[a-p]{32}$/.test(origin || '')
      && [ '/local-migration/session', prefix + '/claim', prefix + '/status' ].includes(req.url);
    if (origin && ![source, target].includes(origin) && !extensionControl) { res.writeHead(403); return res.end(); }
    if (origin === source) res.setHeader('Access-Control-Allow-Origin', source);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (automatic && req.url === '/local-migration/session' && req.method === 'GET' && (!origin || extensionControl)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ protocol: 1, migrationUrl: target + prefix, phase: report.phase, browserStatus }));
    }
    if (automatic && req.url === prefix + '/status' && req.method === 'POST' && (!origin || extensionControl)) {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 512) throw Error(); }
      const value = JSON.parse(raw);
      if (Object.keys(value).sort().join(',') !== 'state,version'
        || !/^\d+\.\d+\.\d+$/.test(value.version || '')
        || !['ready', 'pages-open', 'export-requested', 'relay-unavailable', 'tab-changed'].includes(value.state)) throw Error();
      browserStatus = { ...value, receivedAt: Date.now() };
      console.log(JSON.stringify({ phase: 'extension-status', ...value }));
      res.writeHead(200); return res.end('ok');
    }
    if (automatic && req.url === prefix + '/claim' && req.method === 'POST' && (!origin || extensionControl)) {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 128) throw Error(); }
      const value = JSON.parse(raw);
      if (!/^[a-f0-9-]{36}$/.test(value.session || '') || claimant && claimant !== value.session) throw Error();
      claimant = value.session; res.writeHead(200); return res.end('ok');
    }
    if (automatic && req.url === prefix + '/export.js' && req.method === 'GET' && origin === source) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(exportScript);
    }
    if (req.url === prefix + '/backup' && req.method === 'OPTIONS' && origin === source) {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end();
    }
    if (req.url === prefix + '/backup' && req.method === 'POST' && origin === source && !snapshot && !uploading) {
      uploading = true;
      const file = path.join(directory, 'browser-5174.json'), handle = await open(file, 'wx', 0o600);
      let size = 0;
      try { for await (const chunk of req) { size += chunk.length; if (size > 1024 ** 3) throw Error(); await handle.write(chunk); } await handle.sync(); }
      finally { await handle.close(); }
      const bytes = await readFile(file), data = JSON.parse(bytes);
      if (data.app !== 'guan-ai-workbench' || data.origin !== source || data.format !== 1
        || data.kind !== 'full-browser-backup' || !data.databases?.length || !Object.keys(data.localStorage || {}).length) throw Error();
      snapshot = file;
      report = { phase: 'source-backed-up', privateFiles: before.length, bytes: size, sha256: hash(bytes),
        localStorageKeys: Object.keys(data.localStorage).length, databases: data.databases.length,
        records: data.databases.reduce((sum, db) => sum + db.stores.reduce((n, store) => n + store.records.length, 0), 0) };
      await writePrivateFile(path.join(directory, 'MIGRATION.json'), JSON.stringify(report));
      console.log(JSON.stringify(report)); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ backedUp: true }));
    }
    if (req.method === 'GET' && req.url === prefix) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
      return res.end(automatic ? page.replace('</script>', "document.querySelector('#restore').click();</script>") : page);
    }
    for (const [name, bytes] of Object.entries(modules)) if (req.method === 'GET' && req.url === prefix + '/' + name) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(bytes);
    }
    if (req.method === 'GET' && req.url === prefix + '/snapshot' && snapshot && origin !== source) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(await readFile(snapshot));
    }
    if (req.method === 'POST' && req.url === prefix + '/verified' && origin === target && snapshot) {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1024) throw Error(); }
      const value = JSON.parse(raw); if (value.verified !== true || value.databases !== report.databases) throw Error();
      report = { ...report, phase: 'browser-verified', verified: true };
      await writePrivateFile(path.join(directory, 'MIGRATION.json'), JSON.stringify(report));
      console.log(JSON.stringify(report)); res.writeHead(200); return res.end('ok');
    }
    res.writeHead(404); res.end();
  } catch { res.writeHead(409); res.end('Migration stopped; original data retained.'); }
});
server.listen(8888, '127.0.0.1', () => console.log(JSON.stringify({ migrationUrl: target + prefix, backupDirectory: directory, privateFiles: before.length })));
process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); });
