// No tabs permission, content scripts, page injection or other-site contents.
// Browser-level inventory is observational until the independent coordinator
// additionally proves every profile, task root and persistence checkpoint.
const ORIGIN = 'http://127.0.0.1:5174';
const HOST = 'com.guanaiworkbench.browser';
let port = null, timer = null, scanning = false, dirty = true, revision = 0, sequence = 0;
let session = crypto.randomUUID(), lastSnapshot = null;
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
function changed() { revision++; dirty = true; }
chrome.tabs.onCreated.addListener(changed);
chrome.tabs.onRemoved.addListener(changed);
chrome.tabs.onReplaced.addListener(changed);
// Ignore event contents (including unrelated titles/URLs). Conservatively
// invalidate topology without reading or forwarding other websites' data.
chrome.tabs.onUpdated.addListener(changed);
const navigationFilter = { url: [{ schemes: ['http'], hostEquals: '127.0.0.1', ports: [5174] }] };
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
