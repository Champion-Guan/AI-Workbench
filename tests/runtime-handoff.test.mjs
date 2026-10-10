import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureRuntimeHandoff } from '../scripts/lib/runtime-handoff.mjs';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'guan-handoff-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'), backup = path.join(root, 'private-backup');
  await mkdir(projectRoot); await mkdir(backup); await chmod(backup, 0o700);
  const configFile = path.join(root, 'live.yaml'); await writeFile(configFile, 'proxies: []\nrules: [MATCH,DIRECT]\n');
  const identity = { cwd: projectRoot, pid: 123, supervisorPid: 124, serverEntryVerified: true, configFile };
  const status = { running: true, relayEnabled: false, configName: 'fixture.yaml' };
  return { projectRoot, output: path.join(backup, 'handoff.json'), inspect: async () => identity, fetchStatus: async () => status, identity, status };
}
test('handoff preserves live config/switches in a private copy without granting install authority', async t => {
  const f = await fixture(t), result = await captureRuntimeHandoff(f);
  assert.equal(result.saved, true);
  assert.equal(result.activityVerified, false);
  assert.equal(result.installAllowed, false);
  const record = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(record.proxy.relayEnabled, false);
  assert.equal(record.proxy.cachedConfig, await readFile(f.identity.configFile, 'utf8'));
  assert.equal((await stat(f.output)).mode & 0o777, 0o600);
  await assert.rejects(captureRuntimeHandoff(f), /Existing handoff/);
});
test('handoff rejects unverified/other projects, inactive cores and changing runtime identities', async t => {
  const f = await fixture(t);
  await assert.rejects(captureRuntimeHandoff({ ...f, inspect: async () => ({ ...f.identity, cwd: path.dirname(f.projectRoot) }) }));
  await assert.rejects(captureRuntimeHandoff({ ...f, fetchStatus: async () => ({ ...f.status, running: false }) }));
  let calls = 0;
  await assert.rejects(captureRuntimeHandoff({ ...f, inspect: async () => ({ ...f.identity, supervisorPid: calls++ ? 999 : 124 }) }), /changed/);
});
test('handoff rejects changed configuration and destinations inside source or shared directories', async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(captureRuntimeHandoff({ ...f, inspect: async () => { if (calls++) await writeFile(f.identity.configFile, 'changed'); return f.identity; } }), /changed/);
  await chmod(f.projectRoot, 0o700);
  await assert.rejects(captureRuntimeHandoff({ ...f, output: path.join(f.projectRoot, 'private.json') }), /inside source/);
  await chmod(path.dirname(f.output), 0o755);
  await assert.rejects(captureRuntimeHandoff(f), /private 0700/);
});
