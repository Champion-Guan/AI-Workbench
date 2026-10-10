// Disposable QA server: latest built UI -> real update routes/services ->
// synthetic GitHub response. No production data, Keychain or external fetch.
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateAuth } from '../src/server/update-auth.mjs';
import { SoftwareUpdates } from '../src/server/software-updates.mjs';
import { readGitHubStable, STABLE_ASSETS } from '../src/server/github-stable.mjs';
import { createUpdateHttpHandler } from '../src/server/update-http.mjs';
import { ActivityGate } from '../src/server/activity-gate.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { keyId, sha256 } from '../src/server/stable-manifest.mjs';
import { StableDownload } from '../src/server/stable-download.mjs';
if (process.argv.slice(2).some(x => x !== '--signed') || process.argv.length > 3) throw Error('QA server does not accept data roots or service targets');
const signedMode = process.argv.includes('--signed');
const root = path.resolve(fileURLToPath(new URL('../src/canvas/dist/', import.meta.url))); await stat(path.join(root, 'index.html'));
const directory = await mkdtemp(path.join(tmpdir(), 'guan-update-browser-'));
const keys = new Map(), auth = new UpdateAuth({ directory, vault: { insert: async (id, v) => keys.set(id, v), read: async id => keys.get(id) ?? null } });
await auth.authorize('qa-owner/qa-workbench', ['Synthetic', 'Browser', 'Update', 'Fixture'].join('_'));
let calls = 0, origin, handler;
const gate = new ActivityGate();
const pair = generateKeyPairSync('ed25519'), pem = pair.publicKey.export({ type: 'spki', format: 'pem' }), id = keyId(pem);
const archive = Buffer.from('Synthetic QA payload, never executable');
const manifest = { format: 1, app: 'guan-ai-workbench', channel: 'stable', version: '1.0.4', repository: 'qa-owner/qa-workbench', commit: 'a'.repeat(40), builtAt: '2026-10-10T00:00:00.000Z', keyId: id,
  packages: ['arm64', 'x64'].map(arch => ({ platform: 'darwin', arch, name: `guan-ai-workbench-v1.0.4-macos-${arch}.zip`, sha256: sha256(archive), size: archive.length, nodeVersion: 'v24.16.0', runtimeSha256: 'b'.repeat(64), runtimeSize: 100 })) };
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), signature = sign(null, bytes, pair.privateKey);
const assets = [{ name: STABLE_ASSETS[0], id: 1, size: bytes.length, state: 'uploaded' }, { name: STABLE_ASSETS[1], id: 2, size: 64, state: 'uploaded' }, ...manifest.packages.map((p, i) => ({ name: p.name, id: i + 3, size: p.size, state: 'uploaded' }))];
const downloader = new StableDownload({ directory: path.join(directory, 'packages'), trustedKeys: signedMode ? { [id]: pem } : {}, freeSpace: async () => 1e9, readAsset: async options => {
  if (options.repository !== 'qa-owner/qa-workbench') throw Error('Non-fixture request refused');
  const content = options.asset.id === 1 ? bytes : options.asset.id === 2 ? signature : archive;
  if (!options.onChunk) return content;
  await options.onChunk(content.subarray(0, 10));
  await new Promise(resolve => setTimeout(resolve, 2500));
  options.signal.throwIfAborted(); await options.onChunk(content.subarray(10)); return content.length;
} });
const updates = new SoftwareUpdates({ directory, auth, downloader, currentVersion: '1.0.3', readRelease: options => readGitHubStable({ ...options, fetchImpl: async url => {
  if (!url.startsWith('https://api.github.com/repos/qa-owner/qa-workbench/releases?')) throw Error('Non-fixture request refused');
  calls++;
  return Response.json([{ id: 101, tag_name: 'v1.0.4', draft: false, prerelease: false, published_at: '2026-10-10T00:00:00Z',
    body: signedMode ? '阶段 4 临时签名 QA，合成文件不解压、不执行、不安装' : '阶段 3 合成稳定版说明\n• 私有更新检查验证\n• 此包未签名，不下载、不安装', assets }]);
} }) });
await updates.configure({ repository: 'qa-owner/qa-workbench', autoDownload: !signedMode });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const send = (code, content = '', type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(content); };
  if (req.headers.host !== new URL(origin).host) return send(403);
  try {
    if (await handler(req, res)) return;
    if (req.url === '/__qa/status' && req.method === 'GET') return send(200, JSON.stringify({ githubFixtureCalls: calls, realKeychain: false, realNetwork: false, canInstall: gate.status().canInstall }));
    if (req.url === '/local-proxy/channel-transports') return send(200, '{}');
    if (req.url === '/local-app/activity/report') return send(204);
    if (req.url === '/plugins/index.json') return send(200, '[]');
    if (req.method !== 'GET') return send(405);
    const name = decodeURIComponent(new URL(req.url, origin).pathname).replace(/^\/canvas\//, '/');
    let file = path.resolve(root, '.' + name);
    if (file !== root && !file.startsWith(root + path.sep)) return send(403);
    let content;
    try { content = await readFile(file); } catch { if (path.extname(file)) return send(404); file = path.join(root, 'index.html'); content = await readFile(file); }
    send(200, content, types[path.extname(file)] || 'application/octet-stream');
  } catch { if (!res.headersSent) send(400, '{"error":"QA operation failed"}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = 'http://127.0.0.1:' + server.address().port;
handler = createUpdateHttpHandler({ updates, origin, activityGate: gate });
updates.start();
console.log(JSON.stringify({ origin, fixtureOnly: true, realKeychain: false, realNetwork: false }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  updates.stop(); server.closeAllConnections(); server.close(); await updates.tail.catch(() => {}); await downloader.pending; keys.clear();
  await rm(directory, { recursive: true, force: true });
});
