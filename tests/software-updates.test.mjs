import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { parseVersion, compareVersions, validRepository } from '../src/server/stable-version.mjs';
import { UpdateAuth, UpdateError } from '../src/server/update-auth.mjs';
import { selectStableRelease, STABLE_ASSETS, readGitHubStable } from '../src/server/github-stable.mjs';
import { SoftwareUpdates, UPDATE_INTERVAL_MS } from '../src/server/software-updates.mjs';
import { createUpdateHttpHandler } from '../src/server/update-http.mjs';
import { ActivityGate } from '../src/server/activity-gate.mjs';

const secret = ['synthetic', 'Github', 'Test', 'Value'].join('_');
const release = (tag = 'v1.2.0', extra = {}) => ({ id: 1, tag_name: tag, published_at: '2026-10-10T00:00:00Z', body: 'Stable fixture notes', draft: false, prerelease: false,
  assets: STABLE_ASSETS.map(name => ({ name, state: 'uploaded', size: 1024 })), ...extra });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'guan-updates-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = new Map();
  const auth = new UpdateAuth({ directory, vault: { insert: async (id, value) => keys.set(id, value), read: async id => keys.get(id) ?? null } });
  let time = Date.parse('2026-10-10T12:00:00Z'), calls = 0;
  const updates = new SoftwareUpdates({ directory, auth, currentVersion: '1.0.3', now: () => time,
    readRelease: async () => { calls++; return selectStableRelease([release()]); }, ...options });
  return { directory, keys, auth, updates, calls: () => calls, advance: () => { time += 61000; } };
}
test('strict SemVer rejects partial/leading-zero versions and compares all prerelease rules without numeric overflow', () => {
  for (const x of ['1.2', '1.2.3junk', '01.2.3', '1.2.3-01', '1.2.3-', ' 1.2.3', '1.2.3.4']) assert.equal(parseVersion(x), null);
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1);
  assert.equal(compareVersions('v1.2.3+build.2', '1.2.3+build.1'), 0);
  assert.equal(compareVersions('9999999999999999999999.0.0', '9999999999999999999998.0.0'), 1);
  assert.equal(validRepository('owner/project'), true);
  for (const r of ['https://github.com/owner/repo', 'a/../x', 'a/..', 'a/x?token=x', 'a/x\n']) assert.equal(validRepository(r), false);
});
test('Stable channel excludes drafts, prereleases, personal packages and malformed assets; chooses highest SemVer, redacts notes', () => {
  const rows = [release('v2.0.0', { draft: true }), release('v3.0.0', { prerelease: true }), release('v4.0.0-alpha'), release('v9.0.0', { assets: [{ name: 'personal.zip' }] }),
    release('v1.4.0'), release('v1.3.0'), release('v1.5.0', { assets: [...release().assets, release().assets[0]] }), release('v1.6.0', { published_at: 'invalid' })];
  assert.equal(selectStableRelease(rows).version, '1.4.0');
  assert.equal(selectStableRelease([release('v2.0.0+' + secret)], secret), null);
  assert.ok(!selectStableRelease([release('v2.0.0', { body: 'Notes ' + secret })], secret).notes.includes(secret));
  assert.equal(selectStableRelease([release('v1.2.0-rc.1')]), null);
  assert.equal(selectStableRelease([release('v1.2.0', { assets: [null] })]), null);
});
test('GitHub request is backend-only, bounded, pinned, redirect-forbidden, and paginated to choose a newer release', async () => {
  let n = 0;
  const value = await readGitHubStable({ repository: 'owner/repo', token: secret, signal: AbortSignal.timeout(1000), fetchImpl: async (url, opts) => {
    assert.ok(url.startsWith('https://api.github.com/repos/owner/repo/releases?'));
    assert.equal(opts.headers.authorization, 'Bearer ' + secret); assert.equal(opts.redirect, 'error'); assert.equal(opts.headers['x-github-api-version'], '2022-11-28');
    return Response.json(++n === 1 ? Array.from({ length: 100 }, () => release()) : [release('v1.9.0')]);
  } });
  assert.equal(n, 2); assert.equal(value.version, '1.9.0');
});
test('GitHub HTTP failures, network exceptions and body errors only yield fixed codes, never upstream text/Token', async () => {
  for (const [status, headers, code] of [[401, {}, 'authorization_expired'], [403, {}, 'authorization_denied'], [403, { 'x-ratelimit-remaining': '0' }, 'rate_limited'], [429, {}, 'rate_limited'], [404, {}, 'repository_unavailable'], [500, {}, 'github_unavailable']]) {
    await assert.rejects(readGitHubStable({ repository: 'owner/repo', token: secret, fetchImpl: async () => new Response(secret, { status, headers }) }), e => e.code === code && !e.message.includes(secret));
  }
  for (const fn of [async () => { throw Error(secret); }, async () => new Response('bad-json' + secret), async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))]) {
    await assert.rejects(readGitHubStable({ repository: 'owner/repo', token: secret, fetchImpl: fn }), e => e instanceof UpdateError && !e.message.includes(secret));
  }
});
test('pagination inventory limit refuses incomplete results instead of reporting no higher version', async () => {
  let calls = 0;
  await assert.rejects(readGitHubStable({ repository: 'owner/repo', token: secret, fetchImpl: async () => { calls++; return Response.json(Array.from({ length: 100 }, () => release())); } }), /release_inventory_limit/);
  assert.equal(calls, 10);
});
test('per-machine authorization writes references only, verifies Keychain readback and preserves old accounts', async t => {
  const f = await fixture(t); await f.auth.authorize('owner/repo', secret);
  const meta = JSON.parse(await readFile(f.auth.file, 'utf8'));
  assert.ok(!JSON.stringify(meta).includes(secret)); assert.equal(await f.auth.token('owner/repo'), secret);
  await assert.rejects(f.auth.token('other/repo'), /authorization_required/);
  await f.auth.authorize('owner/repo', secret); assert.equal(f.keys.size, 2);
  assert.equal((await stat(f.auth.file)).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  const g = await fixture(t); await assert.rejects(g.auth.token('owner/repo'), /authorization_required/); assert.equal(g.keys.size, 0);
});
test('renamed GitHub owner migrates the existing Keychain reference without re-entering the token', async t => {
  const f = await fixture(t); await f.auth.authorize('MrGuAm/guan-ai-workbench', secret);
  assert.equal(await f.auth.token('Champion-Guan/guan-ai-workbench'), secret);
  assert.equal(JSON.parse(await readFile(f.auth.file, 'utf8')).repository, 'Champion-Guan/guan-ai-workbench');
});
test('bad auth/preference files and symlinks fail closed, preserve bytes and never overwrite configuration', async t => {
  const f = await fixture(t);
  await writeFile(f.auth.file, 'bad-auth'); await assert.rejects(f.auth.authorize('owner/repo', secret), /auth_storage_invalid/);
  assert.equal(await readFile(f.auth.file, 'utf8'), 'bad-auth'); assert.equal(f.keys.size, 0);
  await writeFile(f.updates.file, 'bad-preferences'); await assert.rejects(f.updates.configure({ repository: 'owner/repo' }), /update_storage_invalid/);
  assert.equal(await readFile(f.updates.file, 'utf8'), 'bad-preferences');
  const g = await fixture(t); await symlink(f.updates.file, g.updates.file); await assert.rejects(g.updates.preferences(), /update_storage_invalid/);
});
test('defaults, repository binding, startup/six-hour timer, disabled auto check and persistent preference reload', async t => {
  const f = await fixture(t); const first = await f.updates.status();
  assert.equal(first.preferences.autoCheck, true); assert.equal(first.preferences.autoDownload, true); assert.equal(first.install.allowed, false);
  await f.updates.configure({ repository: 'owner/repo', autoCheck: false }); await f.auth.authorize('owner/repo', secret);
  let interval, tick;
  f.updates.start({ setIntervalFn: (fn, ms) => { tick = fn; interval = ms; return { unref() {} }; } });
  await f.updates.tail; assert.equal(f.calls(), 0); assert.equal(interval, UPDATE_INTERVAL_MS);
  await f.updates.configure({ autoCheck: true }); tick(); await f.updates.tail;
  assert.equal(f.calls(), 1); f.updates.stop();
  const reloaded = new SoftwareUpdates({ directory: f.directory, auth: f.auth, currentVersion: '1.0.3' });
  assert.equal((await reloaded.preferences()).repository, 'owner/repo'); assert.equal((await reloaded.status()).install.allowed, false);
  assert.equal((await reloaded.status()).history.length, 1); assert.equal((await reloaded.status()).lastCheckedAt, '2026-10-10T12:00:00.000Z');
});
test('manual check works with auto check off, no downgrade/equal version prompt, and failed checks retain previous release', async t => {
  let version = '1.0.2', fail = false;
  const f = await fixture(t, { readRelease: async () => { if (fail) throw new UpdateError('github_network_failed'); return selectStableRelease([release(version)]); } });
  await f.updates.configure({ repository: 'owner/repo', autoCheck: false }); await f.auth.authorize('owner/repo', secret);
  await f.updates.check(); assert.equal((await f.updates.status()).hasNewVersion, false);
  version = '1.0.3+build.2'; f.advance(); await f.updates.check(); assert.equal((await f.updates.status()).hasNewVersion, false);
  version = '1.1.0'; f.advance(); await f.updates.check(); assert.equal((await f.updates.status()).hasNewVersion, true);
  fail = true; f.advance(); await f.updates.check(); const s = await f.updates.status();
  assert.equal(s.latest.version, '1.1.0'); assert.equal(s.error, 'github_network_failed'); assert.equal(s.install.allowed, false);
  assert.ok(!JSON.stringify(s).includes(secret));
});
test('simultaneous cached iframe checks coalesce, throttle repeat and serialized repository switch clears old release', async t => {
  let unblock, calls = 0;
  const f = await fixture(t, { readRelease: async () => { calls++; await new Promise(resolve => { unblock = resolve; }); return selectStableRelease([release()]); } });
  await f.updates.configure({ repository: 'owner/repo' }); await f.auth.authorize('owner/repo', secret);
  const a = f.updates.check(), b = f.updates.check(); assert.equal(a, b);
  while (!unblock) await new Promise(resolve => setImmediate(resolve));
  const switchRepo = f.updates.configure({ repository: 'other/repo' }); unblock(); await a; await switchRepo;
  assert.equal(calls, 1); assert.equal((await f.updates.status()).latest, null);
  await f.updates.check(); assert.equal(calls, 1); assert.equal((await f.updates.status()).error, 'authorization_required');
});
test('proxy-only unavailable rejects safely; installation preference alone never grants an install', async t => {
  const f = await fixture(t); await f.updates.configure({ repository: 'owner/repo', network: 'proxy' }); await f.auth.authorize('owner/repo', secret);
  await f.updates.check(); assert.equal((await f.updates.status()).error, 'proxy_unavailable'); assert.equal(f.calls(), 0);
  await f.updates.configure({ autoInstall: true }); assert.equal((await f.updates.status()).install.allowed, false);
  await assert.rejects(f.updates.configure({ token: secret }), /invalid_update_preferences/);
  let supplied = 'unset'; const g = await fixture(t, { proxyUrl: () => 'http://127.0.0.1:7890', readRelease: async opts => { supplied = opts.proxyUrl; return null; } });
  await g.updates.configure({ repository: 'owner/repo', network: 'direct' }); await g.auth.authorize('owner/repo', secret); await g.updates.check(); assert.equal(supplied, null);
});
test('real HTTP handler enforces Origin/Host/JSON/size/method, refuses token and arbitrary command, never grants install', async t => {
  const f = await fixture(t), gate = new ActivityGate(); let handler;
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
  handler = createUpdateHttpHandler({ updates: f.updates, origin, activityGate: gate });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const post = (op, data, extra = {}) => fetch(origin + '/local-app/updates/' + op, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...extra }, body: typeof data === 'string' ? data : JSON.stringify(data) });
  assert.equal((await fetch(origin + '/local-app/updates/status')).status, 403);
  assert.equal((await post('check', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('preferences', { token: secret })).status, 409);
  assert.equal((await post('preferences', { autoInstall: true })).status, 200);
  assert.equal((await post('check', 'x'.repeat(4097))).status, 409);
  assert.equal((await post('check', '{bad')).status, 409);
  assert.equal((await post('check', { command: 'exec' })).status, 409);
  assert.equal((await post('download', { url: 'https://evil.example/update.zip' })).status, 409);
  assert.equal((await post('download', { token: secret })).status, 409);
  assert.equal((await post('download', {})).status, 409);
  assert.equal((await post('install', {})).status, 405);
  assert.equal((await post('stage', { downloadId: 'caller-cannot-choose', version: '1.0.5' })).status, 409);
  assert.equal((await post('stage', { directory: '/private/data', command: 'arbitrary' })).status, 409);
  assert.equal((await post('stage', {})).status, 409);
  const configured = await post('preferences', { repository: 'owner/repo' }); assert.equal(configured.status, 200);
  await f.auth.authorize('owner/repo', secret);
  const checked = await post('check', {}); assert.equal(checked.status, 200); assert.ok(!(await checked.text()).includes(secret));
  const status = await (await fetch(origin + '/local-app/updates/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  assert.equal(status.latest.version, '1.2.0'); assert.equal(status.install.allowed, false); assert.equal(gate.status().canInstall, false); assert.equal(gate.status().active, 0);
});
test('Keychain readback failure preserves original authorization reference and corrupted history cannot be overwritten', async t => {
  const f = await fixture(t); await f.auth.authorize('owner/repo', secret);
  const before = await readFile(f.auth.file, 'utf8'); f.auth.vault.read = async () => 'mismatch';
  await assert.rejects(f.auth.authorize('owner/repo', secret), /authorization_save_failed/);
  assert.equal(await readFile(f.auth.file, 'utf8'), before);
  await writeFile(f.updates.historyFile, 'bad-history');
  await assert.rejects(f.updates.configure({ repository: 'owner/repo' }), /update_history_invalid/);
  assert.equal(await readFile(f.updates.historyFile, 'utf8'), 'bad-history');
  const incomplete = JSON.stringify({ version: 1, repository: 'owner/repo', entries: [{ at: '2026-10-10T00:00:00Z', state: 'error' }] });
  await writeFile(f.updates.historyFile, incomplete);
  await assert.rejects(f.updates.configure({ repository: 'owner/repo' }), /update_history_invalid/);
  assert.equal(await readFile(f.updates.historyFile, 'utf8'), incomplete);
});
test('manual repeat is rate guarded; changing repository never borrows another repository credential or check records', async t => {
  const f = await fixture(t); await f.auth.authorize('owner/repo', secret); await f.updates.configure({ repository: 'owner/repo' });
  await f.updates.check(); await f.updates.check(); assert.equal(f.calls(), 1);
  await f.updates.configure({ repository: 'other/repo' }); const s = await f.updates.status();
  assert.equal(s.authorization, 'required'); assert.equal(s.latest, null); assert.equal(s.history.length, 0);
});
