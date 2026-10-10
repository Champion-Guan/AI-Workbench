import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanContent, scanStaged, scanHistory, scanDirectory, privatePath, MAX_SCAN_BYTES } from '../scripts/lib/secret-scan.mjs';
const token = 'github_' + 'pat_' + 'A'.repeat(55);
test('secret scan detects keys, GitHub tokens, credentials and private data without exposing values', () => {
  const source = ['sk-' + 'Z'.repeat(32), token, '-----BEGIN ' + 'PRIVATE KEY-----', JSON.stringify({ apiKey: 'A'.repeat(32) })].join('\n');
  const findings = scanContent('fixture.js', Buffer.from(source));
  assert.deepEqual(findings.map(item => item.rule), ['openai-style-key', 'github-token', 'private-key', 'literal-credential']);
  assert.ok(!JSON.stringify(findings).includes(token));
  assert.equal(scanContent('data.json', Buffer.from(JSON.stringify({ app: 'guan-ai-workbench', kind: 'full-browser-backup' })))[0].rule, 'browser-data-backup');
  assert.equal(scanContent('handoff.json', Buffer.from(JSON.stringify({ app: 'guan-ai-workbench', kind: 'private-runtime-handoff' })))[0].rule, 'private-runtime-handoff');
  assert.equal(scanContent('RELEASE.json', Buffer.from('{"edition":"personal-private"}'))[0].rule, 'personal-release');
});
test('private file paths are blocked but explicit public examples are allowed', () => {
  for (const name of ['.env', '.env.local', 'config/default-proxy.yaml', 'personal-config/channels.json', 'user-data/db', 'backups/file.json', 'signing.key', 'signing.pem', 'app-personal-date.zip.sha256']) assert.equal(privatePath(name), true, name);
  for (const name of ['.env.local.example', 'config/examples/default-proxy.yaml', 'src/server/index.mjs', 'config/updates/trusted-key.pub']) assert.equal(privatePath(name), false, name);
});
test('large unscanned files fail closed instead of silently passing', () => {
  assert.equal(scanContent('oversize.bin', Buffer.alloc(MAX_SCAN_BYTES + 1))[0].rule, 'scan-size-limit');
});
test('UUID rules distinguish proxy credentials from vendor identifiers and detect escaped JSON keys', () => {
  const uuid = '1'.repeat(8) + '-' + ['2'.repeat(4), '3'.repeat(4), '4'.repeat(4), '5'.repeat(12)].join('-');
  assert.equal(scanContent('vendor.js', Buffer.from('const office = {uuid:"' + uuid + '"};')).length, 0);
  assert.ok(scanContent('node.yaml', Buffer.from('  uuid: ' + uuid)).some(item => item.rule === 'proxy-uuid'));
  assert.ok(scanContent('node.json', Buffer.from(JSON.stringify({ type: 'vless', uuid }))).some(item => item.rule === 'proxy-uuid'));
  const encoded = '{"apiKey":"' + '\\u0041'.repeat(32) + '"}';
  assert.ok(scanContent('encoded.json', Buffer.from(encoded)).some(item => item.rule === 'json-credential'));
});
test('staged scanning checks the index, not a sanitized working-tree copy', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'guan-secret-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  await writeFile(path.join(root, 'fixture.js'), token);
  git(['add', 'fixture.js']);
  await writeFile(path.join(root, 'fixture.js'), 'clean working copy');
  assert.equal(scanStaged(root).findings[0].rule, 'github-token');
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  await writeFile(path.join(root, 'fixture.js'), 'clean');
  git(['add', 'fixture.js']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'clean current']);
  assert.equal(scanStaged(root).findings.length, 0);
  const history = scanHistory(root);
  assert.ok(history.findings.some(item => item.rule === 'github-token'));
  assert.ok(!JSON.stringify(history).includes(token));
});
test('directory scanning rejects symlinks rather than reading files outside the package', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'guan-secret-dir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'package'));
  await writeFile(path.join(root, 'outside'), token);
  await symlink(path.join(root, 'outside'), path.join(root, 'package/linked'));
  assert.deepEqual((await scanDirectory(path.join(root, 'package'))).map(item => item.rule), ['symlink-not-scanned']);
});
