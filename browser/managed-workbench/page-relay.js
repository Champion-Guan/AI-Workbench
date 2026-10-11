// Isolated-world bridge. No DOM/storage/page data reads, fetch or commands.
// The browser supplies document identity to the background port; the page
// response is still NOT authority for global coverage or installation.
(() => {
  const ORIGIN = 'http://127.0.0.1:5174';
  if (location.origin !== ORIGIN) return;
  const session = crypto.randomUUID(), pending = new Set();
  let native = null, page = null, connected = false, stopped = false, attempts = 0, retry = null;
  const valid = value => value && typeof value === 'object' && !Array.isArray(value);
  const errors = ['managed_page_already_paused', 'managed_page_flush_unconfirmed', 'managed_page_epoch_mismatch', 'managed_page_checkpoint_invalid'];
  const close = () => {
    if (stopped) return;
    stopped = true; clearInterval(retry); page?.close(); native?.disconnect();
    window.removeEventListener('message', available);
    // No fabricated idle or resume message on disconnect/lifecycle change.
  };
  const receive = event => {
    if (stopped || !valid(event.data)) { close(); return; }
    const value = event.data;
    if (value.protocol !== 1 || value.session !== session || value.installAllowed !== false || value.fullRootCoverage !== false) { close(); return; }
    if (value.op === 'ready') {
      if (connected || typeof value.version !== 'string' || !/^(?:dev|[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})$/.test(value.version)) { close(); return; }
      connected = true; clearInterval(retry);
      native.postMessage({ protocol: 1, op: 'page-ready', session, version: value.version, fullRootCoverage: false, installAllowed: false });
      return;
    }
    if (!connected || !Number.isSafeInteger(value.sequence) || !pending.delete(value.sequence)) { close(); return; }
    // Whitelist projection: never forward arbitrary fields from main world.
    const counts = value.counts;
    if (!valid(counts) || Object.keys(counts).length !== 5
      || !['canvas', 'workbench', 'agent', 'webdav', 'storage'].every(key => Object.hasOwn(counts, key) && Number.isSafeInteger(counts[key]) && counts[key] >= 0)
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !['active', 'draining', 'paused', 'blocked'].includes(value.phase)
      || value.epoch !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.epoch)
      || typeof value.acknowledged !== 'boolean'
      || value.error !== null && !errors.includes(value.error)) { close(); return; }
    native.postMessage({ protocol: 1, op: 'page-state', session, sequence: value.sequence, epoch: value.epoch,
      phase: value.phase, counts: Object.fromEntries(['canvas', 'workbench', 'agent', 'webdav', 'storage'].map(key => [key, counts[key]])),
      revision: value.revision, acknowledged: value.acknowledged, fullRootCoverage: false, installAllowed: false, error: value.error });
  };
  native = chrome.runtime.connect({ name: 'guan-managed-page-v1' });
  native.onDisconnect.addListener(() => { void chrome.runtime.lastError; close(); });
  native.onMessage.addListener(value => {
    if (stopped || !connected || !valid(value) || Object.keys(value).length !== 5 || value.protocol !== 1
      || value.session !== session || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || !['probe', 'pause', 'assert', 'resume'].includes(value.op)
      || (value.op === 'probe' ? value.epoch !== null : !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.epoch))
      || pending.size >= 8 || pending.has(value.sequence)) { close(); return; }
    pending.add(value.sequence); page.postMessage(value);
  });
  // A document_start script can precede React. Discover readiness without
  // transferring/loss of a MessagePort. Never retry state-changing commands.
  let transferred = false;
  const available = event => {
    const value = event.data;
    if (stopped || transferred || event.source !== window || event.origin !== ORIGIN || !valid(value)
      || Object.keys(value).length !== 3 || value.type !== 'guan-managed-page-available' || value.protocol !== 1 || value.session !== session) return;
    transferred = true;
    const channel = new MessageChannel(); page = channel.port1;
    page.onmessageerror = close; page.onmessage = receive; page.start();
    window.postMessage({ type: 'guan-managed-page-v1', protocol: 1, session }, ORIGIN, [channel.port2]);
  };
  window.addEventListener('message', available);
  const discover = () => {
    if (stopped || connected) return;
    if (++attempts > 30) {
      native.postMessage({ protocol: 1, op: 'page-unsupported', session, fullRootCoverage: false, installAllowed: false });
      close(); return;
    }
    if (transferred) return;
    window.postMessage({ type: 'guan-managed-page-discover', protocol: 1, session }, ORIGIN);
  };
  retry = setInterval(discover, 1000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', discover, { once: true });
  else discover();
  window.addEventListener('pagehide', close, { once: true });
})();
