import { validBackendCommand, validBackendEvidence } from './update-control-protocol.mjs';

// Accessible only through inherited parent IPC, never HTTP. Backend evidence
// is not browser persistence, a remote inventory or a complete install permit.
export function createBackendControl({ gate, ledger, ready, instance, version,
  flushWrites, writes, backgroundBusy = () => false, pauseBackground = () => {}, resumeBackground = () => {} }) {
  let busy = false;
  const snapshot = async () => {
    if (!ready) throw Error('service_backend_evidence_unavailable');
    const before = gate.backendSnapshot();
    const evidence = await ledger.snapshot();
    const backend = gate.backendSnapshot();
    if (backend.revision !== before.revision || backend.epoch !== before.epoch) throw Error('service_backend_changed');
    const value = { protocol: 1, instance, version, backend, ledger: evidence, writes: writes(),
      backgroundBusy: backgroundBusy(), fullCoverage: false, installAllowed: false };
    if (!validBackendEvidence(value)) throw Error('service_backend_evidence_invalid');
    return value;
  };
  return {
    frozen: () => gate.backendSnapshot().frozen,
    async command(command) {
      if (!validBackendCommand(command)) throw Error('service_backend_request_invalid');
      if (busy) throw Error('service_backend_busy');
      busy = true;
      try {
        if (command.action === 'snapshot') return await snapshot();
        if (command.action === 'resume') {
          // No cold object or old epoch can release an uncertain freeze.
          if (gate.backendSnapshot().epoch !== command.value) throw Error('service_backend_epoch_invalid');
          ledger.resume(); gate.resumeBackend(command.value); resumeBackground();
          return await snapshot();
        }
        const expected = command.value, current = await snapshot();
        if (current.backend.active || current.ledger.pending || current.writes.pending || current.writes.failed || current.backgroundBusy
          || current.backend.revision !== expected.backendRevision || current.ledger.revision !== expected.ledgerRevision
          || current.writes.revision !== expected.writeRevision) throw Error('service_backend_not_idle');
        // Atomic admission closure, before any await. Failure after this point
        // retains the freeze; only an explicit correct-epoch resume releases it.
        gate.freezeBackend(expected.backendRevision); pauseBackground();
        await ledger.freeze(expected.ledgerRevision);
        await flushWrites();
        const result = await snapshot();
        if (result.backend.active || result.ledger.pending || !result.ledger.frozen || result.writes.pending || result.writes.failed
          || result.writes.revision !== expected.writeRevision || result.backgroundBusy) throw Error('service_backend_changed');
        return result;
      } catch (error) {
        if (/^service_backend_[a-z_]{1,40}$/.test(error?.message || '')) throw error;
        throw Error('service_backend_evidence_unconfirmed');
      } finally { busy = false; }
    },
  };
}
