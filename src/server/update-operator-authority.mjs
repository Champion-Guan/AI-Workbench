import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { readPrivateFile, writePrivateFile } from './runtime-paths.mjs';
import { validBackendEvidence, controlUuid } from './update-control-protocol.mjs';
import { compareVersions, parseVersion } from './stable-version.mjs';
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const same = (a, b) => a === null && b === null || ['id', 'version', 'commit', 'buildId'].every(k => a?.[k] === b?.[k]);
const idle = v => validBackendEvidence(v) && !v.backend.active && !v.ledger.pending && !v.writes.pending && !v.writes.failed;
const pointer = v => exact(v, ['id', 'version', 'commit', 'buildId']) && typeof v.version === 'string'
  && parseVersion(v.version) && !parseVersion(v.version).pre.length && /^[a-f0-9]{40}$/.test(v.commit)
  && /^[a-f0-9]{24}$/.test(v.buildId) && typeof v.id === 'string' && /^[0-9A-Za-z.+-]{1,160}$/.test(v.id)
  && v.id.startsWith(v.version + '-' + v.commit.slice(0, 12) + '-');

// Explicit per-update operator attestation, approved by the user as the first
// version's safety policy. It is NOT an automatic full browser inventory. The
// user attests save/old-plugin/remote completion; durable unknown/native tasks
// are independently checked and cannot be overridden by this confirmation.
export class OperatorUpdateAuthority {
  constructor({ file, manager, service, ledger, pageOnly = false, now = Date.now, lifetimeMs = 30 * 60 * 1000 }) {
    if (!path.isAbsolute(file || '') || path.resolve(file) !== file || !manager?.verifyInstalled || !service?.inspectOwned
      || !ledger?.snapshot || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 2 * 60 * 60 * 1000)
      throw Error('install_operator_invalid');
    Object.assign(this, { file, manager, service, ledger, pageOnly, now, lifetimeMs }); this.queue = Promise.resolve();
  }
  serial(operation) {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  async read() {
    const raw = await readPrivateFile(this.file, { maxBytes: 8192 });
    if (raw === null) return null;
    const info = await lstat(this.file), parent = await lstat(path.dirname(this.file));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || info.mode & 0o077
      || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o077
      || await realpath(path.dirname(this.file)) !== path.dirname(this.file)) throw Error('install_operator_record_invalid');
    const record = JSON.parse(raw);
    if (!exact(record, ['format', 'state', 'epoch', 'previous', 'next', 'instance', 'ledgerRevision', 'writeRevision', 'expiresAt'])
      || record.format !== 1 || !['approved', 'claimed', 'completed', 'deferred'].includes(record.state)
      || !controlUuid(record.epoch) || record.instance !== null && !controlUuid(record.instance)
      || ![record.ledgerRevision, record.writeRevision, record.expiresAt].every(v => Number.isSafeInteger(v) && v >= 0))
      throw Error('install_operator_record_invalid');
    if (!pointer(record.next) || record.previous !== null && !pointer(record.previous)
      || (record.previous === null) !== (record.instance === null)) throw Error('install_operator_record_invalid');
    // Reading consent is not an execution/installation boundary. Approve and
    // the manager/service independently reverify both signed payloads before
    // claiming/starting. Re-extracting a large ZIP on every heartbeat would
    // starve the controller and obscure its continuous evidence checks.
    return record;
  }
  async save(record) {
    await writePrivateFile(this.file, JSON.stringify(record));
    const check = await this.read();
    if (JSON.stringify(check) !== JSON.stringify(record)) throw Error('install_operator_commit_unconfirmed');
  }
  approve(next, acknowledgement) {
    next = structuredClone(next);
    return this.serial(async () => {
      if (acknowledgement !== 'saved-and-all-tasks-ended') throw Error('install_operator_confirmation_required');
      await this.manager.verifyInstalled(next);
      const old = await this.read();
      if (old?.state === 'claimed') throw Error('update_recovery_required');
      const previous = await this.manager.readCurrent();
      // Initial bootstrap is handled by the separately authorised native
      // maintenance installer, never by an open old browser's HTTP request.
      if (!previous) throw Error('update_bootstrap_required');
      await this.manager.verifyInstalled(previous);
      if (compareVersions(next.version, previous.version) <= 0) throw Error('version_not_newer');
      const owned = await this.service.inspectOwned();
      if (owned.stopped || !same(owned.pointer, previous) || owned.active !== true) throw Error('install_service_identity_invalid');
      if (this.pageOnly) {
        await this.save({ format: 1, state: 'approved', epoch: randomUUID(), previous, next,
          instance: owned.instance, ledgerRevision: 0, writeRevision: 0, expiresAt: this.now() + this.lifetimeMs });
        return { state: 'awaiting-browser-exit', targetVersion: next.version };
      }
      const evidence = await this.service.backendControl({ action: 'snapshot', value: null });
      const ledger = await this.ledger.snapshot();
      if (!idle(evidence) || evidence.backgroundBusy || ledger.pending || ledger.revision !== evidence.ledger.revision
        || evidence.backend.frozen || owned.instance !== evidence.instance) throw Error('install_tasks_pending');
      const record = { format: 1, state: 'approved', epoch: randomUUID(), previous, next,
        instance: owned.instance, ledgerRevision: ledger.revision, writeRevision: evidence.writes.revision,
        expiresAt: this.now() + this.lifetimeMs };
      await this.save(record); return { state: 'awaiting-browser-exit', targetVersion: next.version };
    });
  }
  // Native-only first handoff. Caller must have stopped the old service safely,
  // verified the current complete backup and obtained a fresh maintenance ack.
  approveBootstrap(next, { acknowledgement, backupVerified }) {
    next = structuredClone(next);
    return this.serial(async () => {
      if (acknowledgement !== 'saved-and-all-tasks-ended' || backupVerified !== true) throw Error('install_operator_confirmation_required');
      if (await this.manager.readCurrent() !== null || await this.service.isStopped() !== true) throw Error('update_bootstrap_blocked');
      const old = await this.read(); if (old && !['completed', 'deferred'].includes(old.state)) throw Error('update_recovery_required');
      await this.manager.verifyInstalled(next); const ledger = await this.ledger.snapshot();
      if (ledger.pending) throw Error('install_tasks_pending');
      await this.save({ format: 1, state: 'approved', epoch: randomUUID(), previous: null, next, instance: null,
        ledgerRevision: ledger.revision, writeRevision: 0, expiresAt: this.now() + this.lifetimeMs });
    });
  }
  defer() {
    return this.serial(async () => {
      const value = await this.read();
      if (value?.state === 'claimed') throw Error('update_recovery_required');
      if (value) { value.state = 'deferred'; await this.save(value); }
      return { state: 'deferred' };
    });
  }
  acquire(input) {
    input = structuredClone(input);
    return this.serial(async () => {
      const value = await this.read();
      if (!value || !['approved', 'claimed'].includes(value.state) || this.now() > value.expiresAt || this.now() < value.expiresAt - this.lifetimeMs
        || !same(value.next, input.next || input.journal?.next) || input.mode === 'install' && !same(value.previous, input.previous)
        || input.mode === 'recovery' && input.journal && !same(value.previous, input.journal.previous)
        || input.mode === 'bootstrap' && value.previous !== null) throw Error('install_operator_confirmation_required');
      // Claim is persisted before any freeze; restart cannot replay it for
      // another identity, or erase a possibly started transaction.
      value.state = 'claimed'; await this.save(value);
      const authority = this, epoch = value.epoch;
      const lease = { epoch, fullCoverage: true,
        async assertValid() {
          const current = await authority.read();
          if (!current || current.state !== 'claimed' || current.epoch !== epoch || authority.now() > current.expiresAt
            || authority.now() < current.expiresAt - authority.lifetimeMs
            || JSON.stringify(current) !== JSON.stringify(value)) throw Error('install_permit_invalid');
          if (authority.pageOnly) {
            const owned = await authority.service.inspectOwned();
            if (!owned.stopped && ![value.previous, value.next].some(pointer => pointer && same(pointer, owned.pointer)))
              throw Error('install_service_identity_invalid');
            return;
          }
          const ledger = await authority.ledger.snapshot();
          if (ledger.pending || ledger.revision !== value.ledgerRevision) throw Error('install_tasks_pending');
          const owned = await authority.service.inspectOwned();
          if (owned.stopped) return;
          if (![value.previous, value.next].some(pointer => pointer && same(pointer, owned.pointer))) throw Error('install_service_identity_invalid');
          const evidence = await authority.service.backendControl({ action: 'snapshot', value: null });
          if (!idle(evidence) || owned.instance !== evidence.instance || evidence.ledger.revision !== value.ledgerRevision)
            throw Error('install_tasks_pending');
          if (owned.instance === value.instance) {
            if (evidence.writes.revision !== value.writeRevision) throw Error('install_evidence_changed');
          } else if (owned.active) {
            const journal = await authority.manager.readJournal(), bootstrap = await authority.manager.readBootstrap();
            const committed = journal && ['committed', 'rolled-back'].includes(journal.phase)
              && same(owned.pointer, journal.phase === 'committed' ? journal.next : journal.previous)
              || bootstrap && ['committed', 'activated'].includes(bootstrap.phase) && same(owned.pointer, bootstrap.next);
            if (!committed) throw Error('install_service_identity_invalid');
          } else if (owned.maintenance !== true) throw Error('install_service_identity_invalid');
        },
        async release() {
          // Coordinator has already revalidated before releasing the backend.
          // Its explicit resume can legitimately restart update-check writes;
          // those writes must not turn a completed rollback into a stuck lease.
          const current = await authority.read(), ledger = authority.pageOnly
            ? { pending: 0, revision: value.ledgerRevision } : await authority.ledger.snapshot();
          if (!current || current.state !== 'claimed' || current.epoch !== epoch || JSON.stringify(current) !== JSON.stringify(value)
            || ledger.pending || ledger.revision !== value.ledgerRevision) throw Error('install_permit_invalid');
          current.state = 'completed'; await authority.save(current);
        },
      };
      await lease.assertValid(); return lease;
    });
  }
}
