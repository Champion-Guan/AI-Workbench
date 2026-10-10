// Native Keychain + real browser/HTTP + synthetic provider. No user config.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { MacKeychainVault } from '../src/server/keychain-vault.mjs';
import { CredentialRegistry } from '../src/server/credential-registry.mjs';
import { createCredentialHttpHandler } from '../src/server/credential-http.mjs';
import { ActivityGate } from '../src/server/activity-gate.mjs';
import { runtimePaths } from '../src/server/runtime-paths.mjs';
import { installNativeKeychainBuild } from './lib/native-keychain-build.mjs';

if (process.argv.length !== 2 || process.platform !== 'darwin') throw Error('Isolated native macOS verifier only');
const root = fileURLToPath(new URL('../', import.meta.url)), directory = await mkdtemp(path.join(tmpdir(), 'guan-credential-browser-'));
const paths = runtimePaths({ projectRoot: root, env: { GUAN_WORKBENCH_DATA_DIR: path.join(directory, 'private') } });
await installNativeKeychainBuild(root, path.join(root, 'output/native'), paths);
const accounts = [], vault = new MacKeychainVault({ executable: path.join(paths.runtime, 'guan-keychain'), namespace: 'qa-' + randomUUID() });
const registry = new CredentialRegistry({ directory: path.join(paths.config, 'credentials'), vault: {
  insert: async (id, value) => { accounts.push(id); await vault.insert(id, value); }, read: id => vault.read(id),
} });
const secret = randomBytes(32).toString('base64url');
let requests = 0, credentialMatched = true;
const upstream = createServer(async (request, response) => {
  for await (const _chunk of request) { /* drain synthetic request only */ }
  requests++; credentialMatched &&= request.headers.authorization === 'Bearer ' + secret;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXWQAAAAASUVORK5CYII=' }] }));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const endpoint = 'http://127.0.0.1:' + upstream.address().port;
const bundle = (await (await import('../src/canvas/node_modules/esbuild/lib/main.js')).build({
  entryPoints: [path.join(root, 'tests/fixtures/credential-browser-flow.ts')], tsconfig: path.join(root, 'src/canvas/tsconfig.json'),
  nodePaths: [path.join(root, 'src/canvas/node_modules')], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"development"', __APP_VERSION__: '"qa"', __APP_RELEASES__: '[]' },
})).outputFiles[0].contents;
let origin, handler;
const server = createServer(async (request, response) => {
  try {
    if (await handler(request, response)) return;
    if (request.headers.host !== new URL(origin).host || request.method !== 'GET') { response.writeHead(403); response.end(); return; }
    let data, type = 'application/json';
    if (request.url === '/__qa/seed') data = JSON.stringify({ endpoint, secret }); // synthetic QA credential only
    else if (request.url === '/__qa/flow.js') { data = bundle; type = 'text/javascript'; }
    else if (request.url === '/__qa/result') {
      const index = await registry.index();
      const restored = index.snapshots.length === 1 ? JSON.parse(await registry.recover(index.snapshots[0].id)) : null;
      data = JSON.stringify({ requests, credentialMatched, encryptedRecoveryVerified: restored?.configRecord.includes(secret) === true });
    } else { data = '<!doctype html><title>Isolated Keychain credential flow</title><p>QA only. No user configuration.</p>'; type = 'text/html'; }
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); response.end(data);
  } catch { if (!response.headersSent) response.writeHead(500); response.end('Isolated verification failed'); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
origin = 'http://127.0.0.1:' + server.address().port;
handler = createCredentialHttpHandler({ registry, origin, activityGate: new ActivityGate() });
console.log('Isolated native credential verification: ' + origin);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  server.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  await registry.queue.catch(() => undefined);
  let retained = 0;
  for (const account of accounts) { try { await vault.remove(account); } catch { retained++; } }
  if (!retained) await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ qaAccountsRemoved: accounts.length - retained, qaAccountsRetained: retained, userDataTouched: false }));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close());
