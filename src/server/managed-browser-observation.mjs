const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const number = v => Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);

// Only the native extension channel may feed this observer. It intentionally
// cannot verify all Chrome profiles, absent browsers, tasks or installation.
export class ManagedBrowserObservation {
  constructor({ now = Date.now, staleMs = 6000 } = {}) { this.now = now; this.staleMs = staleMs; this.record = null; }
  accept(value) {
    const common = ['protocol', 'op', 'session', 'sequence', 'revision'];
    if (!exact(value, value?.op === 'inventory' ? [...common, 'windows'] : common)
      || value.protocol !== 1 || !['inventory', 'unknown'].includes(value.op) || !uuid(value.session)
      || !number(value.sequence) || !number(value.revision)) throw Error('managed_browser_report_invalid');
    const previous = this.record;
    if (previous && (previous.session !== value.session || value.sequence <= previous.sequence || value.revision < previous.revision)) throw Error('managed_browser_report_stale');
    if (previous?.op === 'inventory' && value.op === 'inventory' && value.revision === previous.revision
      && JSON.stringify(previous.windows) !== JSON.stringify(value.windows)) throw Error('managed_browser_topology_invalid');
    if (value.op === 'inventory') {
      if (!Array.isArray(value.windows) || value.windows.length > 128) throw Error('managed_browser_report_invalid');
      const tabs = new Set(), documents = new Set();
      for (const tab of value.windows) {
        if (!exact(tab, ['tabId', 'windowId', 'incognito', 'discarded', 'frames', 'foreignFrames'])
          || !number(tab.tabId) || !number(tab.windowId) || tabs.has(tab.tabId)
          || typeof tab.incognito !== 'boolean' || typeof tab.discarded !== 'boolean'
          || !number(tab.foreignFrames) || tab.foreignFrames > 128 || !Array.isArray(tab.frames) || !tab.frames.length || tab.frames.length > 128) throw Error('managed_browser_report_invalid');
        tabs.add(tab.tabId); const frames = new Set();
        for (const frame of tab.frames) {
          if (!exact(frame, ['frameId', 'parentFrameId', 'documentId', 'active']) || !number(frame.frameId)
            || !Number.isSafeInteger(frame.parentFrameId) || frame.parentFrameId < -1 || frames.has(frame.frameId)
            || frame.documentId !== null && (!uuid(frame.documentId) || documents.has(frame.documentId))
            || typeof frame.active !== 'boolean') throw Error('managed_browser_report_invalid');
          frames.add(frame.frameId); if (frame.documentId) documents.add(frame.documentId);
        }
        if (!tab.frames.some(frame => frame.frameId === 0 && frame.parentFrameId === -1)
          || tab.frames.some(frame => frame.frameId !== 0 && !frames.has(frame.parentFrameId))) throw Error('managed_browser_report_invalid');
      }
    }
    // Copy accepted input; later caller mutation cannot rewrite observations.
    this.record = { ...JSON.parse(JSON.stringify(value)), receivedAt: this.now() };
    return this.status();
  }
  status() {
    const record = this.record, stale = !record || this.now() - record.receivedAt > this.staleMs;
    const windows = record?.op === 'inventory' ? record.windows : [];
    return { protocol: 1, op: 'observed', session: record?.session || null,
      tabs: windows.length, frames: windows.reduce((total, tab) => total + tab.frames.length, 0),
      unknown: stale || record?.op !== 'inventory' || windows.some(tab => tab.incognito || tab.discarded || tab.foreignFrames
        || tab.frames.some(frame => !frame.active || !frame.documentId)),
      revision: record?.revision ?? null, inventoryVerified: false, installAllowed: false, profileOnly: true };
  }
}
