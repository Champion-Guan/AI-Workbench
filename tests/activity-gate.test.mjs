import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityGate, REQUIRED_ACTIVITY_DOMAINS, runWithActivity } from '../src/server/activity-gate.mjs';
function fixture() {
  let time = 1000;
  const gate = new ActivityGate({ now: () => time, heartbeatMs: 100, quietMs: 10 });
  const counts = Object.fromEntries(REQUIRED_ACTIVITY_DOMAINS.map(domain => [domain, 0]));
  gate.expectParticipant('test-page', REQUIRED_ACTIVITY_DOMAINS);
  gate.heartbeat('test-page', { counts });
  gate.verifyInventory();
  return { gate, counts, tick: ms => { time += ms; } };
}
test('empty backend does not mean the browser or WebDAV is idle', () => {
  const gate = new ActivityGate();
  assert.equal(gate.status().canInstall, false);
  assert.equal(gate.status().unknown, true);
  assert.deepEqual(gate.status().missing, REQUIRED_ACTIVITY_DOMAINS);
  assert.throws(() => gate.beginQuiescence());
});
test('install requires verified inventory, all pause acknowledgements and a quiet window', () => {
  const { gate, counts, tick } = fixture();
  tick(20);
  assert.equal(gate.status().canInstall, false);
  const epoch = gate.beginQuiescence();
  assert.equal(gate.status().canInstall, false);
  gate.heartbeat('test-page', { counts, paused: true, epoch });
  assert.equal(gate.status().canInstall, false);
  tick(11);
  assert.equal(gate.status().canInstall, false, 'root drain alone never authorizes installation');
  assert.equal(gate.status().readyToFreeze, true);
  gate.freezeQuiescence(epoch);
  assert.equal(gate.status().canInstall, false, 'freeze starts a new quiet window');
  tick(11);
  assert.equal(gate.status().canInstall, true);
  assert.throws(() => gate.acquire('relay'), /update_quiescing/);
  gate.cancelQuiescence(epoch);
  assert.equal(gate.status().canInstall, false);
  gate.acquire('relay')();
});
test('existing operations finish during the barrier, but new operations cannot race install', () => {
  const { gate, counts, tick } = fixture();
  const release = gate.acquire('relay');
  const epoch = gate.beginQuiescence();
  gate.heartbeat('test-page', { counts, paused: true, epoch });
  tick(11);
  assert.equal(gate.status().canInstall, false);
  release(); release();
  assert.equal(gate.status().active, 0);
  tick(11);
  gate.freezeQuiescence(epoch);
  tick(11);
  assert.equal(gate.status().canInstall, true);
});
test('stale or disconnected providers remain unknown, not silently removed', () => {
  const { gate, counts, tick } = fixture();
  const epoch = gate.beginQuiescence();
  gate.heartbeat('test-page', { counts, paused: true, epoch });
  tick(101);
  assert.equal(gate.status().unknown, true);
  assert.equal(gate.status().canInstall, false);
  assert.throws(() => gate.forgetParticipant('test-page'));
  gate.heartbeat('test-page', { counts, paused: true, epoch });
  assert.equal(gate.status().canInstall, false, 'reconnected provider must wait again');
  tick(11);
  gate.freezeQuiescence(epoch);
  tick(11);
  assert.equal(gate.status().canInstall, true);
});
test('every covered domain can block install and busy pages cannot disappear', () => {
  for (const domain of REQUIRED_ACTIVITY_DOMAINS) {
    const { gate, counts, tick } = fixture();
    counts[domain] = 1;
    gate.heartbeat('test-page', { counts });
    assert.throws(() => gate.forgetParticipant('test-page'));
    const epoch = gate.beginQuiescence();
    gate.heartbeat('test-page', { counts, paused: true, epoch });
    tick(11);
    assert.equal(gate.status().canInstall, false);
    assert.equal(gate.status().counts[domain], 1);
  }
});
test('partial, forged, negative and stale-epoch reports cannot authorize installation', () => {
  const { gate, counts, tick } = fixture();
  assert.throws(() => gate.heartbeat('unknown-page', { counts }));
  assert.throws(() => gate.heartbeat('test-page', { counts: { canvas: 0 } }));
  assert.throws(() => gate.heartbeat('test-page', { counts: { ...counts, agent: -1 } }));
  assert.throws(() => gate.heartbeat('test-page', { counts, paused: 'yes' }));
  const epoch = gate.beginQuiescence();
  gate.heartbeat('test-page', { counts, paused: true, epoch: 'wrong-epoch' });
  tick(11);
  assert.equal(gate.status().canInstall, false);
  assert.throws(() => gate.cancelQuiescence('wrong-epoch'));
  gate.cancelQuiescence(epoch);
});
test('the entire awaited relay operation stays leased, even after a client disconnect', async () => {
  const { gate } = fixture();
  let finish;
  const work = runWithActivity(gate, 'relay', () => new Promise(resolve => { finish = resolve; }));
  assert.equal(gate.status().active, 1);
  // A socket-close event does not release the upstream operation's lease.
  await Promise.resolve();
  assert.equal(gate.status().active, 1);
  finish('done');
  assert.equal(await work, 'done');
  assert.equal(gate.status().active, 0);
  await assert.rejects(runWithActivity(gate, 'relay', async () => { throw new Error('fixture failure'); }));
  assert.equal(gate.status().active, 0);
});

test('root drain permits old task child requests; backend freezes only after a complete idle acknowledgement', () => {
  const { gate, counts, tick } = fixture();
  counts.canvas = 1;
  gate.heartbeat('test-page', { counts });
  const epoch = gate.beginQuiescence();
  const child = gate.acquire('relay');
  assert.throws(() => gate.freezeQuiescence(epoch), /not drained/);
  counts.canvas = 0;
  gate.heartbeat('test-page', { counts, paused: true, epoch });
  tick(11);
  assert.throws(() => gate.freezeQuiescence(epoch), /not drained/);
  child();
  tick(11);
  assert.throws(() => gate.freezeQuiescence('old-epoch'), /epoch/);
  gate.freezeQuiescence(epoch);
  assert.throws(() => gate.acquire('relay'), /update_quiescing/);
  tick(11);
  assert.equal(gate.status().canInstall, true);
  gate.invalidateInventory();
  assert.equal(gate.status().canInstall, false);
  gate.cancelQuiescence(epoch);
  gate.acquire('relay')();
});

test('late participant activity and stale acknowledgements cannot retain installation permission', () => {
  const { gate, counts, tick } = fixture();
  const first = gate.beginQuiescence();
  gate.heartbeat('test-page', { counts, paused: true, epoch: first });
  tick(11); gate.freezeQuiescence(first); tick(11);
  counts.storage = 1;
  gate.heartbeat('test-page', { counts, paused: true, epoch: first });
  assert.equal(gate.status().canInstall, false);
  gate.cancelQuiescence(first);
  counts.storage = 0;
  gate.heartbeat('test-page', { counts });
  const second = gate.beginQuiescence();
  gate.heartbeat('test-page', { counts, paused: true, epoch: first });
  tick(11);
  assert.throws(() => gate.freezeQuiescence(second), /not drained/);
  gate.cancelQuiescence(second);
});
