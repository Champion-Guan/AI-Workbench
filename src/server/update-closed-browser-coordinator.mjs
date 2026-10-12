import { workbenchPageCensus } from './workbench-page-census.mjs';
import { validBackendEvidence, controlUuid } from './update-control-protocol.mjs';

const same = (a, b) => ['id', 'version', 'commit', 'buildId'].every(k => a?.[k] === b?.[k]);
const idle = (v, background = true) => validBackendEvidence(v) && !v.backend.active && !v.ledger.pending
  && !v.writes.pending && !v.writes.failed && (!background || !v.backgroundBusy);

// Browser absence is only a veto. The authority must retain durable save,
// session/remote-task evidence and admission ownership across service restarts.
// No default authority and no empty-ledger fallback are supplied here.
export class ClosedBrowserCoordinator {
  constructor({ service, ledger, authority, pageOnly = false, census = workbenchPageCensus }) {
    if (!service?.backendControl || !service?.isStopped || !ledger?.snapshot || typeof census !== 'function')
      throw Error('install_coordination_invalid');
    this.service = service; this.ledger = ledger; this.authority = authority; this.census = census; this.pageOnly = pageOnly;
    this.held = null; this.busy = false;
  }
  async browsersClosed() {
    const value = await this.census();
    if (value?.workbenchPagesClosed !== true || !Array.isArray(value.blockers) || value.blockers.length)
      throw Error('install_browsers_running');
  }
  acquire(input) { return this.obtain('install', input); }
  acquireBootstrap(input) { return this.obtain('bootstrap', input); }
  acquireRecovery(input) { return this.obtain('recovery', input); }
  acquireBootstrapRecovery(input) { return this.obtain('bootstrap-recovery', input); }
  async obtain(mode, input) {
    if (this.busy || this.held) throw Error('install_coordination_busy');
    this.busy = true;
    let authorityLease, backend, frozen = false;
    try {
      // Reject missing coverage before pausing any real service.
      if (typeof this.authority?.acquire !== 'function') throw Error('install_closure_evidence_unavailable');
      const identities = structuredClone(input);
      await this.browsersClosed();
      authorityLease = await this.authority.acquire({ mode, ...identities });
      if (typeof authorityLease?.assertValid !== 'function' || typeof authorityLease.release !== 'function'
        || !controlUuid(authorityLease.epoch) || authorityLease.fullCoverage !== true)
        throw Error('install_closure_evidence_unavailable');
      await authorityLease.assertValid();
      // Product policy: saved acknowledgement + closed workbench pages.
      // Signature, process ownership, atomic switching and rollback remain mandatory.
      if (this.pageOnly) {
        const coordinator = this;
        let released = false;
        const lease = {
          epoch: authorityLease.epoch,
          async assertValid() {
            if (released || coordinator.held !== lease) throw Error('install_permit_invalid');
            await coordinator.browsersClosed(); await authorityLease.assertValid();
          },
          async release() {
            await lease.assertValid(); await authorityLease.release();
            released = true; coordinator.held = null;
          },
          matches(value) { return same(value, identities.next); },
        };
        this.held = lease; await lease.assertValid(); return lease;
      }
      const durable = await this.ledger.snapshot();
      if (durable.pending || !Number.isSafeInteger(durable.revision)) throw Error('install_tasks_pending');
      if (await this.service.isStopped() !== true) {
        backend = await this.service.backendControl({ action: 'snapshot', value: null });
        if (!idle(backend)) throw Error('install_backend_not_idle');
        if (mode === 'install' && backend.version !== identities.previous?.version) throw Error('install_service_identity_invalid');
        if (backend.ledger.revision !== durable.revision) throw Error('install_evidence_changed');
        if (!backend.backend.frozen) {
          backend = await this.service.backendControl({ action: 'freeze', value: {
            backendRevision: backend.backend.revision, ledgerRevision: backend.ledger.revision, writeRevision: backend.writes.revision,
          } });
        }
        frozen = true;
        if (!idle(backend) || !backend.backend.frozen || !backend.ledger.frozen) throw Error('install_backend_not_frozen');
      } else if (mode === 'install') throw Error('install_service_identity_invalid');
      const coordinator = this;
      let released = false, invalid = false;
      const lease = {
        epoch: authorityLease.epoch,
        async assertValid() {
          if (released || invalid || coordinator.held !== lease) throw Error('install_permit_invalid');
          try {
            await coordinator.browsersClosed(); await authorityLease.assertValid();
            const current = await coordinator.ledger.snapshot();
            if (current.pending || current.revision !== durable.revision) throw Error('install_evidence_changed');
            if (await coordinator.service.isStopped() !== true) {
              const evidence = await coordinator.service.backendControl({ action: 'snapshot', value: null });
              if (!idle(evidence, evidence.instance === backend?.instance) || evidence.ledger.revision !== durable.revision) throw Error('install_backend_not_idle');
              // A surviving old service must retain exactly its acquired freeze.
              if (evidence.instance === backend?.instance && (evidence.backend.epoch !== backend.backend.epoch
                || evidence.backend.revision !== backend.backend.revision || evidence.writes.revision !== backend.writes.revision))
                throw Error('install_evidence_changed');
              // New/rollback service ownership, quarantine and admission must
              // be verified by the authority, not guessed from a version string.
              await authorityLease.assertValid({ backend: structuredClone(evidence), identities: structuredClone(identities) });
            }
            await coordinator.browsersClosed(); await authorityLease.assertValid();
          } catch { invalid = true; throw Error('install_permit_invalid'); }
        },
        async release() {
          if (released || invalid) throw Error('install_permit_invalid');
          await lease.assertValid();
          if (backend && await coordinator.service.isStopped() !== true) {
            const evidence = await coordinator.service.backendControl({ action: 'snapshot', value: null });
            if (evidence.instance === backend.instance) {
              if (evidence.backend.epoch !== backend.backend.epoch) throw Error('install_permit_invalid');
              await coordinator.service.backendControl({ action: 'resume', value: backend.backend.epoch });
            }
          }
          // Lost release acknowledgement retains the held lease. Never guess
          // that an authority or backend has resumed after an uncertain result.
          await authorityLease.release(); released = true; coordinator.held = null;
        },
        matches(value) { return same(value, identities.next); },
      };
      this.held = lease; await lease.assertValid(); return lease;
    } catch (error) {
      // Before backend freeze, releasing the authority cannot open Web routes.
      // After any freeze uncertainty, retain it for explicit reconciliation.
      if (authorityLease && !frozen && !backend) {
        try { await authorityLease.release(); } catch { this.held = { unknown: true }; }
      } else if (authorityLease && !this.held) this.held = { unknown: true };
      throw error;
    } finally { this.busy = false; }
  }
}
