import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ActivityGate } from '../src/server/activity-gate.mjs';
import { UpdateTaskLedger } from '../src/server/update-task-ledger.mjs';
import { createBackendControl } from '../src/server/update-backend-control.mjs';
import { ClosedBrowserCoordinator } from '../src/server/update-closed-browser-coordinator.mjs';

// Real durable ledger + actual backend gate/control. Authority is deliberately
// a QA fixture: these tests do not certify browser persistence/remote inventory.
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-closed-coordinator-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new UpdateTaskLedger({ file: path.join(root, 'ledger.json'), version: '1.0.5' }); await ledger.initialize();
  const gate = new ActivityGate(), writes = { revision: 0, pending: 0, failed: 0 };
  const control = createBackendControl({ gate, ledger, ready: true, instance: ledger.instance, version: ledger.version,
    writes: () => ({ ...writes }), flushWrites: async () => {} });
  let closed = true, valid = true, stopped = false, releaseCount = 0;
  const service = { backendControl: command => control.command(command), isStopped: async () => stopped };
  const authority = { acquire: async () => ({ epoch: randomUUID(), fullCoverage: true,
    assertValid: async () => { if (!valid) throw Error('QA unknown inventory'); }, release: async () => { releaseCount++; } }) };
  const census = async () => ({ knownBrowsersExited: closed, blockers: closed ? [] : ['Chrome'], inventoryVerified: false });
  const coordinator = new ClosedBrowserCoordinator({ service, ledger, authority, census });
  const next = { id: 'next', version: '1.0.6', commit: 'a'.repeat(40), buildId: 'b'.repeat(24) };
  return { ledger, gate, writes, control, service, authority, census, coordinator, next,
    input: { previous: { ...next, id: 'previous', version: '1.0.5' }, next },
    closed: value => { closed = value; }, valid: value => { valid = value; }, stopped: value => { stopped = value; }, releases: () => releaseCount };
}
test('absence and empty ledger never replace missing durable closure authority', async t => {
  const f = await fixture(t), coordinator = new ClosedBrowserCoordinator({ service: f.service, ledger: f.ledger, census: f.census });
  await assert.rejects(coordinator.acquire(f.input), /closure_evidence_unavailable/);
  assert.equal(f.gate.backendSnapshot().frozen, false);
  f.authority.acquire = async () => ({ epoch: randomUUID(), fullCoverage: false, assertValid() {}, release() {} });
  await assert.rejects(f.coordinator.acquire(f.input), /closure_evidence_unavailable/);
});
test('actual freeze and revision lease resume only the same old service', async t => {
  const f = await fixture(t), lease = await f.coordinator.acquire(f.input);
  assert.equal(f.gate.backendSnapshot().frozen, true); await lease.assertValid();
  assert.throws(() => f.gate.beginQuiescence(), /quiescing/);
  await assert.rejects(f.coordinator.acquire(f.input), /busy/);
  await lease.release(); assert.equal(f.gate.backendSnapshot().frozen, false); assert.equal(f.releases(), 1);
  await assert.rejects(lease.assertValid(), /invalid/);
});
test('browser reopening irreversibly invalidates lease, without silently thawing', async t => {
  const f = await fixture(t), lease = await f.coordinator.acquire(f.input);
  f.closed(false); await assert.rejects(lease.assertValid(), /invalid/);
  f.closed(true); await assert.rejects(lease.assertValid(), /invalid/); await assert.rejects(lease.release(), /invalid/);
  assert.equal(f.gate.backendSnapshot().frozen, true); assert.equal(f.releases(), 0);
});
test('failed saves, native pending intents and bad durable records cannot obtain freeze', async t => {
  const f = await fixture(t); f.writes.failed = 1;
  await assert.rejects(f.coordinator.acquire(f.input), /not_idle/); assert.equal(f.gate.backendSnapshot().frozen, false);
  const g = await fixture(t); await g.ledger.begin({ id: randomUUID(), pageId: randomUUID(), domain: 'agent', version: '1.0.5' });
  await assert.rejects(g.coordinator.acquire(g.input), /tasks_pending/);
  const h = await fixture(t); await writeFile(h.ledger.file, '{bad', { mode: 0o600 });
  await assert.rejects(h.coordinator.acquire(h.input)); assert.equal(h.gate.backendSnapshot().frozen, false);
});
test('zero-count ABA after freeze and withdrawn authority retain freeze and block release', async t => {
  const f = await fixture(t), lease = await f.coordinator.acquire(f.input); f.writes.revision++;
  await assert.rejects(lease.assertValid(), /invalid/); assert.equal(f.gate.backendSnapshot().frozen, true);
  const g = await fixture(t), second = await g.coordinator.acquire(g.input); g.valid(false);
  await assert.rejects(second.assertValid(), /invalid/); await assert.rejects(second.release(), /invalid/);
});
test('bootstrap requires the authority even when service is stopped, and respects tasks', async t => {
  const f = await fixture(t); f.stopped(true);
  await assert.rejects(f.coordinator.acquire(f.input), /identity_invalid/);
  // A rejected acquire retains uncertain authority; use another fresh fixture.
  const g = await fixture(t); g.stopped(true); const lease = await g.coordinator.acquireBootstrap({ next: g.next });
  await lease.assertValid(); await lease.release(); assert.equal(g.releases(), 1);
});
test('native ledger revision changes while service is stopped invalidate a held bootstrap lease', async t => {
  const f = await fixture(t); f.stopped(true); const lease = await f.coordinator.acquireBootstrap({ next: f.next });
  const intent = await f.ledger.begin({ id: randomUUID(), pageId: randomUUID(), domain: 'storage', version: '1.0.5' });
  await f.ledger.complete(intent); await assert.rejects(lease.assertValid(), /invalid/);
});
