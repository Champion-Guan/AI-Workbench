import { REQUIRED_ACTIVITY_DOMAINS } from './activity-gate.mjs';

// Untrusted, diagnostic-only browser observations. Never verify gate inventory,
// clear backend leases, acknowledge pause, or grant permission to install.
export class BrowserActivityReports {
  constructor({ now = Date.now, heartbeatMs = 15000, maxPages = 1024 } = {}) {
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.maxPages = maxPages;
    this.pages = new Map();
  }
  accept(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)
      || Object.keys(report).sort().join(',') !== 'counts,pageId,protocol,sequence'
      || report.protocol !== 1 || typeof report.pageId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(report.pageId)
      || !Number.isSafeInteger(report.sequence) || report.sequence < 0
      || !report.counts || typeof report.counts !== 'object' || Array.isArray(report.counts)
      || Object.keys(report.counts).sort().join(',') !== [...REQUIRED_ACTIVITY_DOMAINS].sort().join(',')
      || REQUIRED_ACTIVITY_DOMAINS.some(key => !Number.isSafeInteger(report.counts[key]) || report.counts[key] < 0 || report.counts[key] > 1000000)) {
      throw new Error('Invalid activity observation');
    }
    const previous = this.pages.get(report.pageId);
    if (!previous && this.pages.size >= this.maxPages) throw new Error('Activity observation capacity exceeded');
    // An old/out-of-order report must not erase a newer busy report or refresh TTL.
    if (previous && report.sequence <= previous.sequence) throw new Error('Stale activity observation');
    this.pages.set(report.pageId, { sequence: report.sequence, counts: { ...report.counts }, lastSeen: this.now() });
  }
  status() {
    const counts = Object.fromEntries(REQUIRED_ACTIVITY_DOMAINS.map(key => [key, 0]));
    let stalePages = 0;
    for (const page of this.pages.values()) {
      if (this.now() - page.lastSeen > this.heartbeatMs || this.now() < page.lastSeen) stalePages++;
      for (const key of REQUIRED_ACTIVITY_DOMAINS) counts[key] += page.counts[key];
    }
    // Unknown pages cannot be enumerated by browser self-registration alone.
    return { diagnosticOnly: true, inventoryVerified: false, pages: this.pages.size, stalePages, counts };
  }
}
