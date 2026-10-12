import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const browsers = [
  ['Chrome', 'com.google.Chrome', /^Google Chrome(?: Helper(?: \([^)]*\))?)?$/],
  ['Chrome Canary', 'com.google.Chrome.canary', /^Google Chrome Canary(?: Helper(?: \([^)]*\))?)?$/],
  ['Chromium', 'org.chromium.Chromium', /^Chromium(?: Helper(?: \([^)]*\))?)?$/],
  ['Edge', 'com.microsoft.edgemac', /^Microsoft Edge(?: Helper(?: \([^)]*\))?)?$/],
  ['Brave', 'com.brave.Browser', /^Brave Browser(?: Helper(?: \([^)]*\))?)?$/],
  ['Safari', 'com.apple.Safari', /^Safari$/],
];

// Read-only Apple Events. URL values remain inside the browser scripting
// operation: neither other-site URLs, titles nor credentials are returned.
export function workbenchTabScript(bundleId, pid, ports = [8888]) {
  if (!browsers.some(([, id]) => id === bundleId) || !Number.isSafeInteger(pid) || pid < 1)
    throw Error('install_page_inventory_unavailable');
  if (!Array.isArray(ports) || !ports.length || ports.some(port => ![5174, 8888].includes(port)))
    throw Error('install_page_inventory_unavailable');
  const origins = ports.flatMap(port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  // Direct PID Apple Events are essential. JXA Application(pid) can still
  // resolve via bundle id and silently address another Chrome instance.
  return `ObjC.import('Foundation');
var D = $.NSAppleEventDescriptor;
function code(s) { return ((s.charCodeAt(0)*16777216)+(s.charCodeAt(1)*65536)+(s.charCodeAt(2)*256)+s.charCodeAt(3)) >>> 0; }
function spec(want, form, selected, container) {
  var r = D.recordDescriptor;
  r.setDescriptorForKeyword(D.descriptorWithTypeCode(code(want)), code('want'));
  r.setDescriptorForKeyword(D.descriptorWithEnumCode(code(form)), code('form'));
  r.setDescriptorForKeyword(selected, code('seld'));
  r.setDescriptorForKeyword(container, code('from'));
  return r.coerceToDescriptorType(code('obj '));
}
var all = D.descriptorWithDescriptorTypeData(code('abso'), D.descriptorWithEnumCode(code('all ')).data);
var windows = spec('cwin', 'indx', all, D.nullDescriptor);
var tabs = spec('${bundleId === 'com.apple.Safari' ? 'bTab' : 'CrTb'}', 'indx', all, windows);
var urls = spec('prop', 'prop', D.descriptorWithTypeCode(code('${bundleId === 'com.apple.Safari' ? 'pURL' : 'URL '}')), tabs);
var request = D.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(code('core'), code('getd'), D.descriptorWithProcessIdentifier(${pid}), -1, 0);
request.setParamDescriptorForKeyword(urls, code('----'));
var error = Ref();
var reply = request.sendEventWithOptionsTimeoutError(3 | 16 | 4096, 3, error);
if (reply.isNil()) throw Error('Browser query unavailable');
var failure = reply.paramDescriptorForKeyword(code('errn'));
if (!failure.isNil() && failure.int32Value !== 0) throw Error('Browser query failed');
var workbenchCount = 0;
function visit(value) {
  if (value.isNil()) throw Error('Unknown tab');
  if (value.descriptorType === code('list')) {
    for (var i=1; i<=value.numberOfItems; i++) visit(value.descriptorAtIndex(i));
  } else {
    var tabAddress = ObjC.unwrap(value.stringValue);
    if (typeof tabAddress !== 'string') throw Error('Unknown tab');
    if ([${origins.map(origin => `'${origin}'`).join(', ')}].some(function(origin) {
      return tabAddress === origin || ['/', '?', '#'].some(function(separator) { return tabAddress.startsWith(origin + separator); });
    })) workbenchCount++;
  }
}
visit(reply.paramDescriptorForKeyword(code('----')));
String(workbenchCount);`;
}

export function workbenchBrowserProcesses(output) {
  if (typeof output !== 'string' || !output.trim() || output.includes('\0') || Buffer.byteLength(output) > 2 * 1024 * 1024)
    throw Error('install_page_inventory_unavailable');
  const found = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*([1-9][0-9]*)\s+(.+)$/.exec(line);
    if (!match) throw Error('install_page_inventory_unavailable');
    const name = match[2].trim().split('/').at(-1);
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) throw Error('install_page_inventory_unavailable');
    if (['browser_crashpad_handler', 'chrome_crashpad_handler'].includes(name)) continue;
    const browser = browsers.find(([, , pattern]) => pattern.test(name));
    if (browser && !name.includes(' Helper')) found.push({ name: browser[0], bundleId: browser[1], pid });
    // An unknown actual browser needs explicit support. Generic app renderers
    // and Apple's shared WebKit services are not evidence of workbench tabs.
    else if (/^(?:firefox|Firefox|firefox-bin|Opera|Opera GX|Arc)$/.test(name)
      || !browser && /browser|chromium|chrome|firefox/i.test(name) && name !== 'ChatGPT for Chrome')
      found.push({ name: 'unsupported-browser', pid });
  }
  return found.sort((a, b) => a.pid - b.pid);
}

export const workbenchBrowserHosts = output => [...new Set(workbenchBrowserProcesses(output).map(item => item.name))].sort();

// Closing workbench windows is one veto, never proof that remote tasks ended.
// Coordinator still requires exact per-version consent, ledger and freeze.
export async function workbenchPageCensus({ platform = process.platform, execute = run, ports = [8888] } = {}) {
  // Validate even when no browser is running.
  workbenchTabScript('com.google.Chrome', 1, ports);
  if (platform !== 'darwin') throw Error('install_page_inventory_unavailable');
  const options = { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } };
  const processList = async () => workbenchBrowserProcesses((await execute('/bin/ps', ['-axo', 'pid=,comm='], options)).stdout);
  try {
    const before = await processList(), blockers = []; let pages = 0;
    for (const { name, bundleId, pid } of before) {
      if (!bundleId) { blockers.push(name); continue; }
      const reply = (await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', workbenchTabScript(bundleId, pid, ports)], options)).stdout.trim();
      if (!/^(?:0|[1-9][0-9]{0,4})$/.test(reply)) throw Error();
      const count = Number(reply); pages += count;
      if (count) blockers.push(name);
    }
    if (JSON.stringify(before) !== JSON.stringify(await processList())) throw Error();
    return { workbenchPagesClosed: !blockers.length, blockers, pages, inventoryVerified: false, scope: 'workbench-tabs' };
  } catch { throw Error('install_page_inventory_unavailable'); }
}
