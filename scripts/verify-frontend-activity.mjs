// Isolated frontend smoke-test server. No production data, proxy or AI routes.
// Build first; use a fresh browser profile and block non-local network traffic.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { BrowserActivityReports } from '../src/server/browser-activity.mjs';

const root = fileURLToPath(new URL('../src/canvas/dist/', import.meta.url));
await stat(resolve(root, 'index.html'));
// Optional browser-only fixture built in memory from the actual lock helpers.
// Never published to public/, and never contains user data or credentials.
const taskLocksFixture = process.argv.includes('--task-locks') ? (await (await import('../src/canvas/node_modules/esbuild/lib/main.js')).build({
  stdin: { contents: 'export { withWebdavActivityLock } from "./webdav-activity-lock.ts"; export { settleActivityGroup } from "./settle-activity-group.ts"; export { frontendActivity } from "./update-activity.ts";', resolveDir: fileURLToPath(new URL('../src/canvas/lib/', import.meta.url)) },
  bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
})).outputFiles[0].contents : null;
const reports = new BrowserActivityReports();
const storageFixture = process.argv.includes('--storage-safety') ? (await (await import('../src/canvas/node_modules/esbuild/lib/main.js')).build({
  entryPoints: [fileURLToPath(new URL('../tests/fixtures/native-storage-safety.ts', import.meta.url))],
  tsconfig: fileURLToPath(new URL('../src/canvas/tsconfig.json', import.meta.url)),
  nodePaths: [fileURLToPath(new URL('../src/canvas/node_modules/', import.meta.url))],
  bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"development"' },
})).outputFiles[0].contents : null;
const commitFixture = process.argv.includes('--commit-flush') ? (await (await import('../src/canvas/node_modules/esbuild/lib/main.js')).build({
  entryPoints: [fileURLToPath(new URL('../tests/fixtures/canvas-commit-harness.tsx', import.meta.url))],
  tsconfig: fileURLToPath(new URL('../src/canvas/tsconfig.json', import.meta.url)),
  nodePaths: [fileURLToPath(new URL('../src/canvas/node_modules/', import.meta.url))],
  bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"development"' },
})).outputFiles[0].contents : null;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let origin;
const server = createServer(async (request, response) => {
  const send = (status, body = '', type = 'application/json') => { response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); response.end(body); };
  if (request.headers.host !== new URL(origin).host) return send(403);
  try {
    const pathname = new URL(request.url, origin).pathname;
    if (pathname === '/__qa/storage-safety.js' && storageFixture && request.method === 'GET') return send(200, storageFixture, 'text/javascript');
    if (pathname === '/__qa/storage-safety' && storageFixture && request.method === 'GET') return send(200, '<!doctype html><title>Isolated native storage QA</title>', 'text/html');
    if (pathname === '/__qa/commit-flush.js' && commitFixture && request.method === 'GET') return send(200, commitFixture, 'text/javascript');
    if (pathname === '/__qa/commit-flush' && commitFixture && request.method === 'GET') return send(200, '<!doctype html><div id="qa-root"></div><script type="module" src="/__qa/commit-flush.js"></script>', 'text/html');
    if (pathname === '/__qa/task-locks.js' && taskLocksFixture && request.method === 'GET') return send(200, taskLocksFixture, 'text/javascript');
    if (pathname === '/local-app/activity/report') {
      if (request.method !== 'POST' || request.headers.origin !== origin) return send(403);
      let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 2048) return send(400); }
      reports.accept(JSON.parse(body)); return send(204);
    }
    if (pathname === '/local-app/activity') return send(200, JSON.stringify({ unknown: true, canInstall: false, observedBrowser: reports.status() }));
    if (request.method !== 'GET') return send(405);
    let path = decodeURIComponent(pathname).replace(/^\/canvas\//, '/');
    path = resolve(root, '.' + path);
    if (!path.startsWith(root)) return send(403);
    let content;
    try { content = await readFile(path); }
    catch { if (extname(path)) return send(404); path = resolve(root, 'index.html'); content = await readFile(path); }
    send(200, content, types[extname(path)] || 'application/octet-stream');
  } catch { send(400, JSON.stringify({ error: 'Invalid smoke-test request' })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
console.log(`Isolated frontend activity test: ${origin}`);
console.log('Diagnostic only. No production data, proxy, task execution or installation capability.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
