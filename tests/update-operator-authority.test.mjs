import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpdateTaskLedger } from '../src/server/update-task-ledger.mjs';
import { ActivityGate } from '../src/server/activity-gate.mjs';
import { createBackendControl } from '../src/server/update-backend-control.mjs';
import { OperatorUpdateAuthority } from '../src/server/update-operator-authority.mjs';
import { ClosedBrowserCoordinator } from '../src/server/update-closed-browser-coordinator.mjs';
import { UpdateInstallScheduler } from '../src/server/update-install-scheduler.mjs';
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-operator-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const previous = { id: '1.0.5-' + 'a'.repeat(12) + '-previous', version: '1.0.5', commit: 'a'.repeat(40), buildId: 'b'.repeat(24) };
  const next = { ...previous, id: '1.0.6-' + 'a'.repeat(12) + '-next', version: '1.0.6' };
  const ledger = new UpdateTaskLedger({ file: path.join(root, 'ledger.json'), version: previous.version }); await ledger.initialize();
  const gate = new ActivityGate(), writes = { revision: 0, pending: 0, failed: 0 };
  let stopped = false, current = previous, now = 10000, calls = 0;
  const control = createBackendControl({ gate, ledger, ready: true, instance: ledger.instance, version: previous.version,
    writes: () => ({ ...writes }), flushWrites: async () => {} });
  const service = { backendControl: command => control.command(command), isStopped: async () => stopped,
    inspectOwned: async () => stopped ? { stopped: true } : { stopped: false, pointer: previous, instance: ledger.instance, active: true, maintenance: false } };
  // Identity verifier is explicitly a QA fixture; real signing is exercised by
  // deployment/native transaction tests, not claimed by this helper.
  const manager = { repository: 'owner/repo', readCurrent: async () => current, verifyInstalled: async pointer => {
    if (![previous.id, next.id].includes(pointer?.id)) throw Error('signature rejected');
  }, readJournal: async () => null, readBootstrap: async () => null, install: async () => { calls++; } };
  const authority = new OperatorUpdateAuthority({ file: path.join(root, 'consent.json'), manager, service, ledger, now: () => now, lifetimeMs: 1000 });
  return { root, ledger, gate, writes, previous, next, service, manager, authority, calls: () => calls++,
    clock: value => { now = value; }, stopped: value => { stopped = value; }, current: value => { current = value; } };
}
test('page-only policy ignores remote ledgers but never installs with an open workbench page', async t => {
  const f = await fixture(t); f.authority.pageOnly = true;
  const task = await f.ledger.begin({ id: randomUUID(), pageId: randomUUID(), domain: 'agent', version: f.previous.version });
  await f.authority.approve(f.next, 'saved-and-all-tasks-ended');
  let closed = false;
  const coordinator = new ClosedBrowserCoordinator({ service: f.service, ledger: f.ledger, authority: f.authority, pageOnly: true,
    census: async () => ({ workbenchPagesClosed: closed, blockers: closed ? [] : ['Chrome'] }) });
  await assert.rejects(coordinator.acquire({ previous: f.previous, next: f.next }), /browsers_running/);
  closed = true; const lease = await coordinator.acquire({ previous: f.previous, next: f.next });
  assert.equal((await f.ledger.snapshot()).pending, 1);
  assert.equal(f.gate.backendSnapshot().frozen, false);
  closed = false; await assert.rejects(lease.assertValid(), /browsers_running/);
  closed = true; await lease.release();
  await f.ledger.complete(task);
});
test('per-version confirmation persists, cannot authorise another target, expires, and never clears pending native tasks', async t => {
  const f = await fixture(t);
  await assert.rejects(f.authority.approve(f.next, 'yes'), /confirmation_required/);
  await f.authority.approve(f.next, 'saved-and-all-tasks-ended');
  await assert.rejects(f.authority.acquire({ mode: 'install', previous: f.previous, next: f.previous }), /confirmation_required/);
  f.clock(11001); await assert.rejects(f.authority.acquire({ mode: 'install', previous: f.previous, next: f.next }), /confirmation_required/);
  const task = await f.ledger.begin({ id: randomUUID(), pageId: randomUUID(), domain: 'agent', version: f.previous.version });
  await assert.rejects(f.authority.approve(f.next, 'saved-and-all-tasks-ended'), /pending/);
  assert.equal((await f.ledger.snapshot()).pending, 1); await f.ledger.complete(task);
});
test('confirmation + real durable/backend freeze yields a single-use lease; defer cannot cancel a claimed transaction', async t => {
  const f = await fixture(t); await f.authority.approve(f.next, 'saved-and-all-tasks-ended');
  const coordinator = new ClosedBrowserCoordinator({ service: f.service, ledger: f.ledger, authority: f.authority,
    census: async () => ({ workbenchPagesClosed: true, blockers: [] }) });
  const lease = await coordinator.acquire({ previous: f.previous, next: f.next });
  assert.equal((await f.authority.read()).state, 'claimed');
  await assert.rejects(f.authority.defer(), /recovery_required/);
  await lease.release(); assert.equal((await f.authority.read()).state, 'completed');
  await assert.rejects(f.authority.acquire({ mode: 'install', previous: f.previous, next: f.next }), /confirmation_required/);
});
test('failed writes, task revision ABA and changed save revision invalidate confirmation instead of being cleared', async t => {
  const f = await fixture(t); f.writes.failed = 1;
  await assert.rejects(f.authority.approve(f.next, 'saved-and-all-tasks-ended'), /pending/);
  f.writes.failed = 0; await f.authority.approve(f.next, 'saved-and-all-tasks-ended'); f.writes.revision++;
  await assert.rejects(f.authority.acquire({ mode: 'install', previous: f.previous, next: f.next }), /changed/);
  assert.equal((await f.authority.read()).state, 'claimed');
  const g = await fixture(t); await g.authority.approve(g.next, 'saved-and-all-tasks-ended');
  const lease = await g.authority.acquire({ mode: 'install', previous: g.previous, next: g.next });
  const row = await g.ledger.begin({ id: randomUUID(), pageId: randomUUID(), domain: 'storage', version: g.previous.version });
  await g.ledger.complete(row); await assert.rejects(lease.assertValid(), /pending/);
});
test('corrupt consent remains intact, native bootstrap needs explicit backup+maintenance acknowledgement', async t => {
  const f = await fixture(t); await writeFile(f.authority.file, '{bad', { mode: 0o600 });
  await assert.rejects(f.authority.approve(f.next, 'saved-and-all-tasks-ended'));
  assert.equal(await readFile(f.authority.file, 'utf8'), '{bad');
  const g = await fixture(t); g.stopped(true); g.current(null);
  await assert.rejects(g.authority.approveBootstrap(g.next, { acknowledgement: 'saved-and-all-tasks-ended', backupVerified: false }), /confirmation/);
  await g.authority.approveBootstrap(g.next, { acknowledgement: 'saved-and-all-tasks-ended', backupVerified: true });
  const lease = await g.authority.acquire({ mode: 'bootstrap', next: g.next }); await lease.assertValid(); await lease.release();
});
test('independent scheduler coalesces ticks, respects disabled preference/browser veto and requires a fresh grant', async t => {
  const f = await fixture(t), file = path.join(f.root, 'preferences.json'); let installs = 0, opened = 0, closed = false, finish;
  f.manager.install = async () => { installs++; await new Promise(resolve => { finish = resolve; }); };
  const scheduler = new UpdateInstallScheduler({ manager: f.manager, authority: f.authority, preferencesFile: file,
    onInstalled: async () => { opened++; throw Error('browser unavailable'); },
    census: async () => ({ workbenchPagesClosed: closed, blockers: closed ? [] : ['Chrome'] }) });
  await scheduler.tick(); assert.equal(scheduler.state.state, 'deferred');
  await writeFile(file, JSON.stringify({ version: 1, repository: 'owner/repo', autoCheck: false, autoDownload: false, autoInstall: true, network: 'direct' }), { mode: 0o600 });
  await scheduler.tick(); assert.equal(scheduler.state.state, 'confirmation-required');
  await f.authority.approve(f.next, 'saved-and-all-tasks-ended'); await scheduler.tick();
  assert.equal(scheduler.state.state, 'awaiting-browser-exit'); assert.equal(installs, 0);
  closed = true; const a = scheduler.tick(), b = scheduler.tick(); assert.equal(a, b);
  while (!finish) await new Promise(resolve => setImmediate(resolve)); finish(); await a; assert.equal(installs, 1);
  assert.equal(opened, 1); assert.equal(scheduler.state.state, 'committed'); assert.equal(scheduler.state.openFailed, true);
  await scheduler.stop(); await scheduler.tick(); assert.equal(installs, 1);
});
