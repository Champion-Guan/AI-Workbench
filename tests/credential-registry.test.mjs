import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { CredentialRegistry, validateCredentialEndpoint } from '../src/server/credential-registry.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'guan-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = new Map(); let failRead = false;
  const vault = { insert: async (id, value) => { if (keys.has(id)) throw Error('duplicate'); keys.set(id, value); },
    read: async id => { if (failRead) throw Error('fixture-private-error'); return keys.get(id) ?? null; } };
  return { directory, keys, registry: new CredentialRegistry({ directory, vault }), failRead: value => { failRead = value; } };
}
test('verified immutable credentials never enter metadata or public status', async t => {
  const f = await fixture(t), secret = randomBytes(32).toString('base64');
  const first = await f.registry.createProfile({ kind: 'openai', endpoint: 'https://api.example.com/', secret });
  const next = await f.registry.createProfile({ kind: 'openai', endpoint: 'https://api.example.com/', secret: 'fixture-changed' });
  assert.notEqual(first.id, next.id); assert.equal((await f.registry.resolve(first.id)).secret, secret);
  assert.equal((await f.registry.resolve(next.id)).secret, 'fixture-changed');
  const metadata = await readFile(f.registry.file, 'utf8'), status = JSON.stringify(await f.registry.publicStatus());
  assert.ok(!metadata.includes(secret) && !status.includes(secret) && !status.includes('fixture-changed'));
  assert.equal((await stat(f.registry.file)).mode & 0o777, 0o600);
});
test('Keychain read-back failure publishes no profile and retains existing records', async t => {
  const f = await fixture(t); f.failRead(true);
  await assert.rejects(f.registry.createProfile({ kind: 'openai', endpoint: 'https://api.example.com', secret: 'fixture' }));
  assert.equal((await f.registry.publicStatus()).profiles.length, 0); assert.equal(f.keys.size, 1);
});
test('corrupt index cannot be replaced by a default or a new credential', async t => {
  const f = await fixture(t); await writeFile(f.registry.file, '{damaged', { mode: 0o600 });
  await assert.rejects(f.registry.createProfile({ kind: 'openai', endpoint: 'https://api.example.com', secret: 'fixture' }), /private_index_invalid/);
  assert.equal(await readFile(f.registry.file, 'utf8'), '{damaged'); assert.equal(f.keys.size, 0);
});
test('concurrent profile additions serialize without overwriting either user configuration', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 10 }, (_, index) => f.registry.createProfile({ kind: 'openai', endpoint: 'https://api.example.com', secret: `fixture-${index}` })));
  assert.equal((await f.registry.publicStatus()).profiles.length, 10);
});
test('ambiguous private metadata identities and unexpected fields fail closed without changing the file', async t => {
  const f = await fixture(t);
  await f.registry.createProfile({ kind: 'openai', endpoint: 'https://api.example.com', secret: 'fixture' });
  const original = JSON.parse(await readFile(f.registry.file, 'utf8'));
  for (const mutate of [value => value.profiles.push({ ...value.profiles[0] }),
    value => value.snapshots.push({ id: value.profiles[0].id, account: value.profiles[0].account, digest: 'a'.repeat(64) }),
    value => { value.unexpected = 'not-defaultable'; }, value => { value.profiles[0].username = 'fixture\ninvalid'; }]) {
    const value = structuredClone(original); mutate(value); const text = JSON.stringify(value);
    await writeFile(f.registry.file, text, { mode: 0o600 });
    await assert.rejects(f.registry.publicStatus(), /private_index_invalid/);
    await assert.rejects(f.registry.createProfile({ kind: 'openai', endpoint: 'https://api.example.com', secret: 'another-fixture' }), /private_index_invalid/);
    assert.equal(await readFile(f.registry.file, 'utf8'), text);
  }
});
test('encrypted recovery retains exact JSON, detects tampering and never writes a plaintext secret', async t => {
  const f = await fixture(t), secret = randomBytes(32).toString('base64'), original = JSON.stringify({ apiKey: secret, canvas: { id: 'kept' } });
  const receipt = await f.registry.encryptRecovery(original); assert.equal(await f.registry.recover(receipt.id), original);
  for (const file of await readdir(f.directory)) assert.ok(!(await readFile(path.join(f.directory, file), 'utf8')).includes(secret));
  const file = path.join(f.directory, 'recovery-' + receipt.id + '.json'), value = JSON.parse(await readFile(file, 'utf8'));
  value.tag = randomBytes(16).toString('base64'); await writeFile(file, JSON.stringify(value));
  await assert.rejects(f.registry.recover(receipt.id), /recovery_invalid/);
});
test('endpoint binding refuses URL secrets, scripts, non-TLS remote endpoints and remote Agents', () => {
  const credentialUrl = new URL('https://example.invalid'); credentialUrl.username = 'qa'; credentialUrl.password = 'fixture';
  for (const [url, kind] of [[credentialUrl.href, 'openai'], ['https://example.com?key=fixture', 'openai'],
    ['javascript:alert(1)', 'openai'], ['http://example.com', 'webdav'], ['https://agent.example.com', 'agent'],
    ['http://127.0.0.1:5174/local-secure-api/id', 'openai'], ['https://api.github.com/other', 'github']]) assert.throws(() => validateCredentialEndpoint(url, kind));
  assert.equal(validateCredentialEndpoint('http://127.0.0.1:17371/', 'agent'), 'http://127.0.0.1:17371');
  assert.equal(validateCredentialEndpoint('https://api.github.com/', 'github'), 'https://api.github.com');
  assert.throws(() => validateCredentialEndpoint('https://example.com/' + '中'.repeat(1000), 'openai'), /invalid_endpoint/);
});
