import test from 'node:test';
import assert from 'node:assert/strict';
import { startSettledCurrent } from '../src/server/update-settled-startup.mjs';
function fixture() {
  const current = { id: 'fixture-current', version: '1.0.5', commit: 'a'.repeat(40), buildId: 'b'.repeat(24) };
  const consent = { state: 'completed', previous: null, next: current, expiresAt: 1 };
  const bootstrap = { phase: 'activated', next: current }, calls = [];
  let owned = { stopped: true }, journal = null, protocol = 1, pending = 2;
  const service = { inspectOwned: async () => owned, isStopped: async () => owned.stopped,
    stop: async () => { calls.push('stop-dead-handle'); },
    activate: async () => { calls.push('activate'); owned = { stopped: false, active: true, maintenance: false, pointer: current }; } };
  const manager = { service, readCurrent: async () => current, readJournal: async () => journal,
    readBootstrap: async () => bootstrap, locked: async fn => fn(),
    verifyInstalled: async () => { calls.push('verify'); return { startupProtocol: protocol }; },
    healthy: async () => { calls.push('start'); } };
  const authority = { read: async () => consent }, ledger = { snapshot: async () => ({ pending, revision: 8 }) };
  return { manager, authority, ledger, current, consent, bootstrap, calls,
    owned: value => { owned = value; }, journal: value => { journal = value; },
    protocol: value => { protocol = value; }, pending: () => pending };
}
test('settled current restarts even after old install-confirmation TTL, preserving pending evidence and pointers', async () => {
  const f = fixture(); assert.deepEqual(await startSettledCurrent(f), { state: 'running' });
  assert.deepEqual(f.calls, ['verify', 'stop-dead-handle', 'start', 'activate']);
  assert.equal(f.pending(), 2); assert.equal(f.consent.state, 'completed'); assert.equal(f.bootstrap.phase, 'activated');
  f.calls.length = 0; await startSettledCurrent(f); assert.deepEqual(f.calls, [], 'owned active current is never respawned');
});
test('claimed/incomplete/mismatched transactions, unknown listeners and damaged evidence never start or clear records', async () => {
  const f = fixture(); f.consent.state = 'claimed';
  assert.equal((await startSettledCurrent(f)).state, 'maintenance-required'); assert.deepEqual(f.calls, []);
  for (const phase of ['starting', 'committed']) {
    const g = fixture(); g.bootstrap.phase = phase; await assert.rejects(startSettledCurrent(g), /recovery_required/); assert.deepEqual(g.calls, []);
  }
  const h = fixture(); h.owned({ stopped: false, active: true, maintenance: false, pointer: { ...h.current, id: 'unknown' } });
  await assert.rejects(startSettledCurrent(h), /activation_unconfirmed/); assert.deepEqual(h.calls, []);
  const k = fixture(); k.ledger.snapshot = async () => { throw Error('task_ledger_invalid'); };
  await assert.rejects(startSettledCurrent(k), /ledger_invalid/); assert.deepEqual(k.calls, []);
  const old = fixture(); old.protocol(0); await assert.rejects(startSettledCurrent(old), /ownership_lost/);
  assert.deepEqual(old.calls, ['verify']);
});
test('rolled-back current can restart only when both transaction identities match the completed consent', async () => {
  const f = fixture(), next = { ...f.current, version: '1.0.6', id: 'fixture-failed-next' };
  f.consent.previous = f.current; f.consent.next = next;
  f.journal({ phase: 'rolled-back', previous: f.current, next });
  assert.equal((await startSettledCurrent(f)).state, 'running');
  const g = fixture(); g.journal({ phase: 'rolled-back', previous: g.current, next });
  await assert.rejects(startSettledCurrent(g), /recovery_required/); assert.deepEqual(g.calls, []);
});
