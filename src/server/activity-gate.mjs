import { randomUUID } from 'node:crypto';

export const REQUIRED_ACTIVITY_DOMAINS = Object.freeze(['canvas', 'workbench', 'agent', 'webdav', 'storage']);
const categories = new Set([...REQUIRED_ACTIVITY_DOMAINS, 'relay', 'proxy']);
const validCount = count => Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000;

// Trusted coordinator API only. The browser cannot request install or erase leases.
// Missing browser inventory/old pages/stale heartbeats are UNKNOWN, never IDLE.
export class ActivityGate {
  constructor({ now = Date.now, heartbeatMs = 15000, quietMs = 10000 } = {}) {
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.quietMs = quietMs;
    this.operations = new Map();
    this.participants = new Map();
    this.inventoryVerified = false;
    this.draining = false;
    this.frozen = false;
    this.epoch = null;
    this.changedAt = now();
    this.backendRevision = 0;
    this.backendEpoch = null;
  }
  acquire(category) {
    if (!categories.has(category)) throw new Error('Unknown activity category');
    // During root drain, old tasks must still be able to send child requests
    // and persist their results. Freeze only after every participant is paused.
    if (this.frozen || this.backendEpoch) throw new Error('update_quiescing');
    const id = randomUUID();
    this.operations.set(id, category);
    this.backendRevision++;
    this.changedAt = this.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.operations.delete(id);
      this.backendRevision++;
      this.changedAt = this.now();
    };
  }
  expectParticipant(id, domains) {
    if (this.draining || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || this.participants.has(id) || this.participants.size >= 1024) throw new Error('Invalid activity participant');
    if (!Array.isArray(domains) || !domains.length || domains.some(domain => !REQUIRED_ACTIVITY_DOMAINS.includes(domain)) || new Set(domains).size !== domains.length) throw new Error('Invalid activity coverage');
    this.participants.set(id, { domains: [...domains], report: null, lastSeen: null });
    this.inventoryVerified = false;
    this.changedAt = this.now();
  }
  verifyInventory() {
    if (this.draining) throw new Error('update_quiescing');
    this.inventoryVerified = true;
    this.changedAt = this.now();
  }
  invalidateInventory() {
    this.inventoryVerified = false;
    this.changedAt = this.now();
  }
  heartbeat(id, { counts, paused = false, epoch = null } = {}) {
    const participant = this.participants.get(id);
    if (!participant || !counts || typeof counts !== 'object' || Array.isArray(counts) || typeof paused !== 'boolean') throw new Error('Invalid activity report');
    if (Object.keys(counts).length !== participant.domains.length || participant.domains.some(domain => !validCount(counts[domain]))) throw new Error('Incomplete activity report');
    if (epoch !== null && (typeof epoch !== 'string' || epoch.length > 64)) throw new Error('Invalid activity epoch');
    const report = { counts: Object.fromEntries(participant.domains.map(domain => [domain, counts[domain]])), paused, epoch };
    const stale = participant.lastSeen === null || this.now() - participant.lastSeen > this.heartbeatMs;
    if (stale || JSON.stringify(report) !== JSON.stringify(participant.report)) this.changedAt = this.now();
    participant.report = report;
    participant.lastSeen = this.now();
  }
  forgetParticipant(id) {
    const participant = this.participants.get(id);
    if (!participant) return;
    // Closing a tab is not evidence that its upstream work was cancelled.
    if (!participant.report || Object.values(participant.report.counts).some(count => count > 0) || this.now() - participant.lastSeen > this.heartbeatMs) throw new Error('Participant not proven idle');
    this.participants.delete(id);
    this.invalidateInventory();
  }
  beginQuiescence() {
    if (this.draining) throw new Error('update_quiescing');
    const status = this.status();
    if (status.unknown) throw new Error('Activity coverage is unknown');
    this.draining = true;
    this.epoch = randomUUID();
    this.changedAt = this.now();
    return this.epoch;
  }
  cancelQuiescence(epoch) {
    if (!this.draining || epoch !== this.epoch) throw new Error('Invalid quiescence epoch');
    this.draining = false;
    this.frozen = false;
    this.epoch = null;
    this.changedAt = this.now();
  }
  freezeQuiescence(epoch) {
    if (!this.draining || this.frozen || epoch !== this.epoch) throw new Error('Invalid quiescence epoch');
    if (!this.status().readyToFreeze) throw new Error('Activity not drained');
    // No await between checking activity and closing admission.
    this.frozen = true;
    this.changedAt = this.now();
  }
  // Backend-only admission. This deliberately does not verify browser
  // inventory, acknowledge participants or grant canInstall.
  backendSnapshot() {
    return { revision: this.backendRevision, active: this.operations.size,
      frozen: this.backendEpoch !== null, epoch: this.backendEpoch };
  }
  freezeBackend(revision) {
    if (this.draining || this.frozen || this.backendEpoch || this.operations.size
      || revision !== this.backendRevision || !Number.isSafeInteger(revision)) throw Error('backend_not_idle');
    this.backendEpoch = randomUUID();
    return this.backendEpoch;
  }
  resumeBackend(epoch) {
    if (!this.backendEpoch || epoch !== this.backendEpoch) throw Error('backend_epoch_invalid');
    this.backendEpoch = null; this.backendRevision++;
  }
  status() {
    const now = this.now(), covered = new Set(), reasons = new Set();
    const counts = Object.fromEntries([...categories].map(category => [category, 0]));
    for (const category of this.operations.values()) counts[category]++;
    let acknowledged = true;
    if (!this.inventoryVerified) reasons.add('inventory_unverified');
    for (const participant of this.participants.values()) {
      for (const domain of participant.domains) covered.add(domain);
      if (!participant.report || now - participant.lastSeen > this.heartbeatMs || now < participant.lastSeen) {
        reasons.add('participant_unknown'); acknowledged = false; continue;
      }
      for (const [category, count] of Object.entries(participant.report.counts)) counts[category] += count;
      if (!participant.report.paused || participant.report.epoch !== this.epoch) acknowledged = false;
    }
    const missing = REQUIRED_ACTIVITY_DOMAINS.filter(domain => !covered.has(domain));
    if (missing.length) reasons.add('coverage_incomplete');
    const unknown = reasons.size > 0;
    const active = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (active) reasons.add('operations_active');
    if (!this.draining) reasons.add('not_quiescing');
    if (this.draining && !acknowledged) reasons.add('pause_unacknowledged');
    const quiet = now >= this.changedAt && now - this.changedAt >= this.quietMs;
    if (!quiet) reasons.add('quiet_period_pending');
    const readyToFreeze = !unknown && !active && this.draining && acknowledged && quiet && !this.frozen;
    if (this.draining && !this.frozen) reasons.add('backend_not_frozen');
    return { unknown, active, counts, participants: this.participants.size, missing,
      draining: this.draining, frozen: this.frozen, epoch: this.epoch, readyToFreeze,
      canInstall: !unknown && !active && this.draining && this.frozen && acknowledged && quiet,
      reasons: [...reasons] };
  }
}

export async function runWithActivity(gate, category, operation) {
  const release = gate.acquire(category);
  try { return await operation(); }
  finally { release(); }
}
