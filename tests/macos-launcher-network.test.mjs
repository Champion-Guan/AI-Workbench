import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PortableLaunchdJobs, portableDescriptor, startPortableJob, desktopShortcut } from '../scripts/lib/macos-launcher.mjs';
import { localProxy, migrationNetworks } from '../scripts/lib/migration-network.mjs';
import { migrationPackage } from '../scripts/lib/port-migration-package.mjs';
import { SoftwareUpdates } from '../src/server/software-updates.mjs';
import { UpdateError } from '../src/server/update-auth.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-launcher-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('desktop bundle is executable without Terminal and unrelated desktop files are preserved', async t => {
  const desktop = await fixture(t), node = '/fixture with spaces/node', root = '/fixture with spaces/workbench';
  const result = await desktopShortcut({ desktop, node, root });
  assert.equal(result.created, true);
  assert.match(await readFile(path.join(result.path, 'Contents/MacOS/launch'), 'utf8'), /exec '\/fixture with spaces\/node'/);
  assert.ok((await stat(path.join(result.path, 'Contents/MacOS/launch'))).mode & 0o100);
  assert.equal((await desktopShortcut({ desktop, node, root })).created, false);
  const other = await fixture(t); await writeFile(path.join(other, 'AI-Workbench.app'), 'customer file');
  await assert.rejects(desktopShortcut({ desktop: other, node, root }), /conflict/);
  assert.equal(await readFile(path.join(other, 'AI-Workbench.app'), 'utf8'), 'customer file');
});
test('macOS opens the isolated desktop app and executes its launcher without Terminal', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'scripts'));
  const marker = path.join(root, 'launched.txt');
  await writeFile(path.join(root, 'scripts/start-macos.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'desktop-opened');\n`);
  const result = await desktopShortcut({ desktop: root, node: process.execPath, root });
  await promisify(execFile)('/usr/bin/open', ['-n', '-W', result.path], { timeout: 30000, maxBuffer: 65536 });
  assert.equal(await readFile(marker, 'utf8'), 'desktop-opened');
});
test('proxy discovery permits only credential-free loopback and discovers system/local settings', async () => {
  const credentialUrl = ['http://', 'user', ':', 'secret', '@127.0.0.1:7890'].join('');
  for (const url of ['http://remote:7890', credentialUrl, 'socks5://127.0.0.1:7890', 'http://127.0.0.1:7890/private']) assert.equal(localProxy(url), null);
  const networks = await migrationNetworks({ data: '/fixture/data' }, { env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    read: async file => file.endsWith('runtime.env') ? 'IMAGE_RELAY_PROXY_URL=http://127.0.0.1:23210' : null,
    execute: async () => ({ stdout: 'HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\n' }) });
  assert.deepEqual(networks, [undefined, 'http://127.0.0.1:7890', 'http://127.0.0.1:23210']);
});
test('migration retries network errors using local proxy but never retries signature refusal', async () => {
  const calls = [], networks = [undefined, 'http://127.0.0.1:7890'];
  class Downloader {
    constructor() { this.verified = { directory: '/fixture/verified' }; }
    async download(options) { calls.push(options.proxyUrl); }
    status() { return { state: 'verified' }; }
  }
  const options = { updates: '/fixture', currentVersion: '1.0.7', networks, Downloader,
    readRelease: async ({ proxyUrl }) => { if (!proxyUrl) throw new UpdateError('github_network_failed'); return { version: '1.0.9' }; },
    verify: async () => ({ startupProtocol: 1 }) };
  assert.equal((await migrationPackage(options)).version, '1.0.9');
  assert.deepEqual(calls, ['http://127.0.0.1:7890']);
  let attempts = 0;
  await assert.rejects(migrationPackage({ ...options, readRelease: async () => { attempts++; throw new UpdateError('signature_invalid'); } }), /signature_invalid/);
  assert.equal(attempts, 1);
});
test('production repository is locked in backend even when an old custom preference exists', async t => {
  const directory = await fixture(t);
  const bytes = JSON.stringify({ version: 1, repository: 'other/repo', autoCheck: true, autoDownload: true, autoInstall: false, network: 'auto' });
  await writeFile(path.join(directory, 'preferences.json'), bytes);
  const updates = new SoftwareUpdates({ directory, auth: { metadata: async () => { throw Error('must not read auth'); } }, currentVersion: '1.0.9' });
  assert.equal((await updates.status()).preferences.repository, 'Champion-Guan/AI-Workbench');
  await assert.rejects(updates.configure({ repository: 'other/repo' }), /locked/);
  assert.equal(await readFile(path.join(directory, 'preferences.json'), 'utf8'), bytes);
});
test('actual isolated user launchd portable service runs after launcher returns and reuses one listener', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fixture(t), agents = path.join(root, 'agents'), logs = path.join(root, 'logs');
  await mkdir(agents); await mkdir(logs);
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  await writeFile(path.join(root, 'server.mjs'), "import {createServer} from 'node:http'; const s=createServer((q,r)=>r.end('ready')); s.listen(Number(process.env.PORT),'127.0.0.1'); process.on('SIGTERM',()=>s.close(()=>process.exit(0)));\n");
  const label = 'com.guanaiworkbench.portable.qa.' + randomUUID(), jobs = new PortableLaunchdJobs();
  const descriptor = portableDescriptor({ node: process.execPath, root, privateRoot: root + '-private', agents, logs, port, label });
  t.after(() => jobs.stop(label, descriptor));
  await startPortableJob({ descriptor, jobs, label });
  await startPortableJob({ descriptor, jobs, label });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if (await (await fetch(`http://127.0.0.1:${port}`)).text() === 'ready') { ready = true; break; } } catch { /* bounded startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true);
  assert.equal(await jobs.inspect(label, descriptor), true);
  await jobs.command(['kill', 'SIGTERM', jobs.target(label)]);
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await fetch(`http://127.0.0.1:${port}`); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  assert.equal(await jobs.inspect(label, descriptor), true);
  await startPortableJob({ descriptor, jobs, label });
  ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if (await (await fetch(`http://127.0.0.1:${port}`)).text() === 'ready') { ready = true; break; } } catch { /* bounded restart */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true);
  await jobs.stop(label, descriptor);
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
});
