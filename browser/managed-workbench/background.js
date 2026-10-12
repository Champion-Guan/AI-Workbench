// No tabs permission or other-site contents. The approved isolated relay
// exchanges only bounded control/status fields on the fixed workbench Origin.
// Browser-level inventory is observational until the independent coordinator
// additionally proves every profile, task root and persistence checkpoint.
const ORIGIN = 'http://127.0.0.1:8888';
const HOST = 'com.guanaiworkbench.browser';
let port = null, timer = null, scanning = false, dirty = true, revision = 0, sequence = 0;
let session = crypto.randomUUID(), lastSnapshot = null;
// Chrome supplies these identities, not window.postMessage or page input.
// Page data are diagnostic until full roots and native inventory are proven.
const pages = new Map();
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const pageErrors = ['managed_page_already_paused', 'managed_page_flush_unconfirmed', 'managed_page_epoch_mismatch', 'managed_page_checkpoint_invalid'];
const isWorkbench = value => {
  try { return new URL(value).origin === ORIGIN; } catch { return false; }
};
// Chrome serializes document UUIDs as 32 uppercase hexadecimal characters.
// Keep one canonical opaque identity on the wire, not a URL or page value.
const documentIdentity = value => {
  if (typeof value !== 'string') return null;
  const hex = value.replaceAll('-', '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(hex)
    || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

async function badge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}
function pageUnknown(entry) {
  entry.unknown = true; entry.acknowledged = false;
  entry.port?.disconnect(); entry.port = null;
  // Retain disconnected observations; closing a page isn't remote terminal.
}
function sendPageCommand(entry, op, epoch = null) {
  if (!entry.port || entry.unknown || !entry.session || !['probe', 'pause', 'assert', 'resume'].includes(op)
    || (op === 'probe' ? epoch !== null : !uuid(epoch)) || entry.pending.size >= 8
    || entry.sequence >= Number.MAX_SAFE_INTEGER - 1) throw Error('managed_page_command_unavailable');
  const sequence = ++entry.sequence;
  entry.pending.set(sequence, { op, epoch });
  try { entry.port.postMessage({ protocol: 1, session: entry.session, sequence, op, epoch }); }
  catch { pageUnknown(entry); }
}
chrome.runtime.onConnect.addListener(connection => {
  const sender = connection.sender, documentId = documentIdentity(sender?.documentId);
  if (connection.name !== 'guan-managed-page-v1' || sender?.id !== chrome.runtime.id || !isWorkbench(sender.url)
    || !documentId || !Number.isSafeInteger(sender.tab?.id) || sender.tab.id < 0
    || !Number.isSafeInteger(sender.frameId) || sender.frameId < 0 || pages.size >= 256 || pages.has(documentId)) {
    connection.disconnect(); return;
  }
  const entry = { port: connection, session: null, sequence: -1, pending: new Map(), unknown: true,
    documentId, tabId: sender.tab.id, frameId: sender.frameId, receivedAt: 0, appliedSequence: -1, acknowledged: false, state: null };
  pages.set(documentId, entry);
  connection.onDisconnect.addListener(() => { void chrome.runtime.lastError; entry.port = null; entry.unknown = true; entry.acknowledged = false; });
  connection.onMessage.addListener(value => {
    if (entry.port !== connection) return;
    if (exact(value, ['protocol', 'op', 'session', 'version', 'fullRootCoverage', 'installAllowed'])
      && value.protocol === 1 && value.op === 'page-ready' && uuid(value.session)
      && typeof value.version === 'string' && /^(?:dev|[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})$/.test(value.version)
      && value.fullRootCoverage === false && value.installAllowed === false && entry.session === null) {
      entry.session = value.session; entry.unknown = false; entry.receivedAt = Date.now();
      sendPageCommand(entry, 'probe'); return;
    }
    if (!exact(value, ['protocol', 'op', 'session', 'sequence', 'epoch', 'phase', 'counts', 'revision', 'acknowledged', 'fullRootCoverage', 'installAllowed', 'error'])
      || value.protocol !== 1 || value.op !== 'page-state' || value.session !== entry.session
      || !Number.isSafeInteger(value.sequence) || !entry.pending.has(value.sequence)
      || value.fullRootCoverage !== false || value.installAllowed !== false
      || !['active', 'draining', 'paused', 'blocked'].includes(value.phase)
      || value.epoch !== null && !uuid(value.epoch) || typeof value.acknowledged !== 'boolean'
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !exact(value.counts, ['canvas', 'workbench', 'agent', 'webdav', 'storage'])
      || Object.values(value.counts).some(count => !Number.isSafeInteger(count) || count < 0)
      || value.error !== null && !pageErrors.includes(value.error)) { pageUnknown(entry); return; }
    entry.pending.delete(value.sequence);
    // A slow pause can return after a newer probe/resume. It must not revive
    // an old checkpoint or overwrite a newer activity observation.
    if (value.sequence <= entry.appliedSequence) return;
    if (entry.state && value.revision < entry.state.revision
      || value.acknowledged && (value.phase !== 'paused' || !uuid(value.epoch) || Object.values(value.counts).some(count => count !== 0))) {
      pageUnknown(entry); return;
    }
    entry.appliedSequence = value.sequence; entry.receivedAt = Date.now();
    entry.state = JSON.parse(JSON.stringify(value)); entry.acknowledged = value.acknowledged;
  });
});
function changed() { revision++; dirty = true; }
chrome.tabs.onCreated.addListener(changed);
chrome.tabs.onRemoved.addListener(changed);
chrome.tabs.onReplaced.addListener(changed);
// Ignore event contents (including unrelated titles/URLs). Conservatively
// invalidate topology without reading or forwarding other websites' data.
chrome.tabs.onUpdated.addListener(changed);
const navigationFilter = { url: [{ schemes: ['http'], hostEquals: '127.0.0.1', ports: [8888, 5174] }] };
chrome.webNavigation.onCommitted.addListener(changed, navigationFilter);
chrome.webNavigation.onHistoryStateUpdated.addListener(changed, navigationFilter);
chrome.webNavigation.onErrorOccurred.addListener(changed, navigationFilter);

async function scan() {
  if (!port || scanning) { dirty = true; return; }
  scanning = true;
  try {
    const start = revision;
    const tabs = await chrome.tabs.query({ url: ORIGIN + '/*' });
    if (tabs.length > 128) throw Error();
    const windows = [];
    for (const tab of tabs) {
      if (!Number.isSafeInteger(tab.id) || !Number.isSafeInteger(tab.windowId) || !isWorkbench(tab.url)) throw Error();
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      if (!frames || frames.length > 128) throw Error();
      // No titles, paths, query strings, credentials or page content leave
      // Chrome. Foreign frame contents are never accessed or injected into.
      windows.push({ tabId: tab.id, windowId: tab.windowId, incognito: tab.incognito === true,
        discarded: tab.discarded === true,
        frames: frames.filter(frame => isWorkbench(frame.url)).map(frame => ({
          frameId: frame.frameId, parentFrameId: frame.parentFrameId,
          documentId: documentIdentity(frame.documentId), active: frame.documentLifecycle === 'active',
        })), foreignFrames: frames.filter(frame => !isWorkbench(frame.url)).length });
    }
    if (start !== revision) { dirty = true; return; }
    const fingerprint = JSON.stringify(windows);
    if (lastSnapshot !== null && fingerprint !== lastSnapshot) revision++;
    lastSnapshot = fingerprint;
    if (new TextEncoder().encode(fingerprint).length > 60000) throw Error();
    port.postMessage({ protocol: 1, op: 'inventory', session, sequence: sequence++, revision, windows });
    // Probes only. Native read-only observation does not issue pause/install.
    for (const entry of pages.values()) {
      if (!entry.port || entry.unknown || !entry.session) continue;
      if (Date.now() - entry.receivedAt > 6000) { pageUnknown(entry); continue; }
      // Keep observing while pause waits for old tasks/writes. Do not resend
      // the state-changing command, and allow only one outstanding probe.
      if (![...entry.pending.values()].some(request => request.op === 'probe')) sendPageCommand(entry, 'probe');
    }
    dirty = false;
  } catch {
    dirty = true;
    // Unknown is an explicit report, never a fabricated empty inventory.
    try { port?.postMessage({ protocol: 1, op: 'unknown', session, sequence: sequence++, revision }); } catch {}
    await badge('?', '#b45309');
  } finally { scanning = false; }
}
function connect() {
  if (port) return;
  session = crypto.randomUUID(); sequence = 0; lastSnapshot = null; changed();
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(reply => {
    if (reply?.protocol !== 1 || reply.op !== 'observed' || reply.installAllowed !== false || reply.session !== session) {
      port?.disconnect(); return;
    }
    // Blue count means browser observation only, not safe-to-install green.
    void badge(reply.unknown ? '?' : String(reply.tabs), reply.unknown ? '#b45309' : '#2563eb');
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null; dirty = true;
    if (timer) clearInterval(timer); timer = null;
    void badge('!', '#b45309');
  });
  timer = setInterval(() => { void scan(); }, 2000);
  void scan();
}
chrome.action.onClicked.addListener(async () => {
  connect();
  await chrome.windows.create({ url: ORIGIN, type: 'normal', focused: true });
  changed(); void scan();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// One-click maintenance: only tabs this extension created are removed. Never
// close a customer canvas or inspect/transmit other websites' contents.
let migration = null, migrationBusy = false;
async function closeMigrationTab(id, expectedUrl) {
  const tab = await chrome.tabs.get(id);
  if (tab.url !== expectedUrl) throw Error('migration_tab_changed');
  await chrome.tabs.remove(id);
}
async function migrationTick() {
  if (migrationBusy) return;
  migrationBusy = true;
  try {
    const response = await fetch(ORIGIN + '/local-migration/session', { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return;
    const info = await response.json(), url = new URL(info.migrationUrl);
    if (info.protocol !== 1 || url.origin !== ORIGIN || !/^\/migration-[a-f0-9-]{36}$/.test(url.pathname)) return;
    if (!migration || migration.url !== url.href) {
      if (info.phase !== 'waiting-source') return;
      const tabs = await chrome.tabs.query({ url: ['http://127.0.0.1:5174/*', ORIGIN + '/*'] });
      if (tabs.length) return; // Existing workbench pages must be saved/closed by the user.
      const session = crypto.randomUUID();
      const claimed = await fetch(url.href + '/claim', { method: 'POST', body: JSON.stringify({ session }) });
      if (!claimed.ok) return;
      const source = await chrome.tabs.create({ url: 'http://127.0.0.1:5174/local-app/health', active: true });
      migration = { url: url.href, source: source.id, target: null, exportSent: false };
    }
    if (info.phase === 'waiting-source' && !migration.exportSent) {
      const tab = await chrome.tabs.get(migration.source);
      if (tab.status === 'complete' && tab.url === 'http://127.0.0.1:5174/local-app/health') {
        await chrome.tabs.sendMessage(migration.source, { op: 'guan-port-migration-export', url: migration.url + '/export.js' });
        migration.exportSent = true;
      }
    }
    if (info.phase === 'source-backed-up' && migration.target === null) {
      await closeMigrationTab(migration.source, 'http://127.0.0.1:5174/local-app/health'); migration.source = null;
      migration.target = (await chrome.tabs.create({ url: migration.url, active: true })).id;
    }
    if (info.phase === 'browser-verified' && migration.target !== null) {
      await closeMigrationTab(migration.target, migration.url); migration.target = null;
    }
  } catch { /* Missing bridge, unknown tabs, or export failure never permits installation. */ }
  finally { migrationBusy = false; }
}
setInterval(() => { void migrationTick(); }, 2000);
