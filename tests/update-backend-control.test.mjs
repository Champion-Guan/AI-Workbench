import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ActivityGate } from '../src/server/activity-gate.mjs';
import { UpdateTaskLedger } from '../src/server/update-task-ledger.mjs';
import { createBackendControl } from '../src/server/update-backend-control.mjs';
import { validBackendCommand, validBackendEvidence } from '../src/server/update-control-protocol.mjs';
import { createUpdateStartup } from '../src/server/update-startup.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guan-backend-control-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = new ActivityGate(), instance = randomUUID(), version = '1.0.5';
  const ledger = new UpdateTaskLedger({ file: path.join(root, 'ledger.json'), instance, version });
  await ledger.initialize();
  const writeState = { revision: 0, pending: 0, failed: 0 };
  let paused = 0, resumed = 0;
  const control = createBackendControl({ gate, ledger, ready: true, instance, version,
    flushWrites: async () => {}, writes: () => ({ ...writeState }),
    pauseBackground: () => { paused++; }, resumeBackground: () => { resumed++; }, ...overrides });
  const snapshot = () => control.command({ action: 'snapshot', value: null });
  const freeze = state => control.command({ action: 'freeze', value: {
    backendRevision: state.backend.revision, ledgerRevision: state.ledger.revision, writeRevision: state.writes.revision } });
  return { root, gate, ledger, instance, version, control, writeState, snapshot, freeze,
    paused: () => paused, resumed: () => resumed };
}

test('backend-only freeze atomically closes admission, without claiming browser coverage or install permission', async t => {
  const f = await fixture(t), before = await f.snapshot();
  const frozen = await f.freeze(before);
  assert.equal(validBackendEvidence(frozen), true);
  assert.equal(frozen.backend.frozen, true); assert.equal(frozen.ledger.frozen, true);
  assert.equal(frozen.fullCoverage, false); assert.equal(frozen.installAllowed, false);
  assert.equal(f.gate.status().unknown, true); assert.equal(f.gate.status().canInstall, false);
  assert.throws(() => f.gate.acquire('relay'), /quiescing/);
  await assert.rejects(f.ledger.begin({ id: randomUUID(), pageId: randomUUID(), domain: 'canvas', version: f.version }), /quiescing/);
  await assert.rejects(f.control.command({ action: 'resume', value: randomUUID() }), /epoch_invalid/);
  assert.equal(f.control.frozen(), true);
  const resumed = await f.control.command({ action: 'resume', value: frozen.backend.epoch });
  assert.equal(resumed.backend.frozen, false); assert.equal(resumed.ledger.frozen, false);
  assert.equal(f.paused(), 1); assert.equal(f.resumed(), 1);
  await assert.rejects(f.freeze(before), /not_idle/);
  f.gate.acquire('relay')();
});

test('active work, zero-count ABA, pending native intent and failed/pending private writes veto freeze', async t => {
  const f = await fixture(t), before = await f.snapshot();
  const release = f.gate.acquire('proxy');
  await assert.rejects(f.freeze(before), /not_idle/); release();
  await assert.rejects(f.freeze(before), /not_idle/);
  const row = await f.ledger.begin({ id: randomUUID(), pageId: randomUUID(), domain: 'agent', version: f.version });
  await assert.rejects(f.freeze(await f.snapshot()), /not_idle/); await f.ledger.complete(row);
  for (const key of ['pending', 'failed']) {
    f.writeState[key] = 1; await assert.rejects(f.freeze(await f.snapshot()), /not_idle/); f.writeState[key] = 0;
  }
  assert.equal(f.control.frozen(), false);
});

test('background jobs veto freeze and missing or corrupt evidence is preserved', async t => {
  const f = await fixture(t, { backgroundBusy: () => true });
  await assert.rejects(f.freeze(await f.snapshot()), /not_idle/);
  await writeFile(f.ledger.file, '{broken', { mode: 0o600 });
  await assert.rejects(f.snapshot(), /unconfirmed/);
  assert.equal(await readFile(f.ledger.file, 'utf8'), '{broken');
  const missing = await fixture(t, { ready: false }); await assert.rejects(missing.snapshot(), /unavailable/);
});

test('late ledger intent, failed flush and late private write keep uncertain admission frozen', async t => {
  const f = await fixture(t), state = await f.snapshot();
  const original = f.ledger.freeze.bind(f.ledger);
  f.ledger.freeze = async revision => {
    await f.ledger.begin({ id: randomUUID(), pageId: randomUUID(), domain: 'webdav', version: f.version });
    return original(revision);
  };
  await assert.rejects(f.freeze(state), /unconfirmed/);
  assert.equal(f.control.frozen(), true); assert.equal((await f.snapshot()).ledger.pending, 1);
  const fail = await fixture(t, { flushWrites: async () => { throw Error('private detail must not escape'); } });
  await assert.rejects(fail.freeze(await fail.snapshot()), /^Error: service_backend_evidence_unconfirmed$/);
  assert.equal(fail.control.frozen(), true);
  let writeState;
  const late = await fixture(t, { flushWrites: async () => { writeState.revision++; } }); writeState = late.writeState;
  await assert.rejects(late.freeze(await late.snapshot()), /changed/);
  assert.equal(late.control.frozen(), true);
});

test('gate is closed while flush awaits; concurrent snapshot/resume cannot release uncertain work', async t => {
  let finish;
  const f = await fixture(t, { flushWrites: () => new Promise(resolve => { finish = resolve; }) });
  const freezing = f.freeze(await f.snapshot());
  while (!finish) await pause(1);
  assert.throws(() => f.gate.acquire('storage'), /quiescing/);
  await assert.rejects(f.snapshot(), /busy/);
  await assert.rejects(f.control.command({ action: 'resume', value: f.gate.backendSnapshot().epoch }), /busy/);
  finish(); assert.equal((await freezing).backend.frozen, true);
});

test('strict protocol rejects arbitrary values and evidence cannot claim complete inventory', () => {
  for (const value of [{ action: 'exec', value: 'command' }, { action: 'snapshot', value: null, path: '/tmp' },
    { action: 'freeze', value: { backendRevision: 0, ledgerRevision: 0 } }, { action: 'resume', value: null },
    { action: 'freeze', value: { backendRevision: -1, ledgerRevision: 0, writeRevision: 0 } }]) assert.equal(validBackendCommand(value), false);
  assert.equal(validBackendEvidence({ installAllowed: true }), false);
});

test('inherited IPC authenticates instance/nonce, consumes sequence once, and keeps frozen after lost acknowledgement', async t => {
  const f = await fixture(t), parent = new EventEmitter(), replies = [];
  parent.send = reply => { replies.push(reply); };
  const nonce = randomUUID(), startup = createUpdateStartup({ parent,
    env: { GUAN_UPDATE_QUARANTINE: '1', GUAN_UPDATE_NONCE: nonce }, instance: f.instance, backendControl: f.control });
  const request = { op: 'guan-update-backend', nonce, instance: f.instance, sequence: 1, command: { action: 'snapshot', value: null } };
  for (const altered of [{ ...request, nonce: randomUUID() }, { ...request, instance: randomUUID() },
    { ...request, sequence: 2 }, { ...request, commandLine: 'no' }]) parent.emit('message', altered);
  assert.equal(replies.length, 0);
  parent.emit('message', request);
  while (!replies.length) await pause(1);
  assert.equal(replies[0].ok, true);
  parent.emit('message', request); await pause(5); assert.equal(replies.length, 1);
  let acknowledge;
  const acknowledged = new Promise(resolve => { acknowledge = resolve; });
  parent.send = () => { acknowledge(); throw Error('lost acknowledgement'); };
  const state = replies[0].evidence;
  parent.emit('message', { ...request, sequence: 2, command: { action: 'freeze', value: {
    backendRevision: state.backend.revision, ledgerRevision: state.ledger.revision, writeRevision: state.writes.revision } } });
  // Wait for the complete IPC operation, not a mid-freeze flag plus a guessed
  // delay. Otherwise cleanup races its remaining durable ledger writes.
  await acknowledged;
  assert.equal(f.ledger.frozen, true);
  assert.equal(f.control.frozen(), true);
  parent.emit('message', { op: 'guan-update-activate', nonce }); assert.equal(startup.quarantined(), true);
  let code; const response = { writeHead: value => { code = value; }, end() {} };
  assert.equal(startup.reject({ method: 'GET' }, response, '/'), true); assert.equal(code, 503);
  assert.equal(startup.reject({ method: 'GET' }, response, '/local-app/health'), false);
});
