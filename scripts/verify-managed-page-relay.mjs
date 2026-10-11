// Synthetic payload server for a new Playwright test context. Browser requests
// are fulfilled offline by CLI routing; never navigate a user's actual tab or
// send a request to production 5174. No userdata, proxy or native host access.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from '../src/canvas/node_modules/esbuild/lib/main.js';
if (process.argv.length !== 2) throw Error('QA server accepts no production targets or commands');
const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({ entryPoints: [path.join(root, 'tests/fixtures/managed-page-browser.ts')], bundle: true,
  write: false, format: 'iife', platform: 'browser', target: 'es2022', tsconfig: path.join(root, 'src/canvas/tsconfig.json'),
  define: { __APP_VERSION__: JSON.stringify('1.0.4'), 'import.meta.env': '{}' } });
const payload = {
  html: '<!doctype html><meta charset="utf-8"><title>Managed page relay QA</title><h1>Isolated managed page QA</h1><p>Chrome API bindings are synthetic. No installation authority.</p><button id="start">Start old task</button><button id="pause">Pause</button><button id="new-root">Try new root</button><button id="finish-task">Finish old task</button><button id="finish-save">Finish IndexedDB save</button><button id="assert">Assert</button><button id="aba">Late activity</button><button id="resume">Resume</button><pre id="state"></pre><script src="/__qa/fixture.js"></script>',
  fixture: result.outputFiles[0].text,
  content: await readFile(path.join(root, 'browser/managed-workbench/page-relay.js'), 'utf8'),
};
const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/payload') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(payload));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ qaPayloadUrl: `http://127.0.0.1:${server.address().port}/payload`, privateData: false, productionRequestsAllowed: false })));
process.on('SIGTERM', () => server.close()); process.on('SIGINT', () => server.close());
