import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const known = [
  ['Chrome', /(?:^|\/)Google Chrome(?: Canary)?(?: Helper(?: \([^)]*\))?)?$/],
  ['Chromium', /(?:^|\/)Chromium(?: Helper(?: \([^)]*\))?)?$/],
  ['Edge', /(?:^|\/)Microsoft Edge(?: Helper(?: \([^)]*\))?)?$/],
  ['Brave', /(?:^|\/)Brave Browser(?: Helper(?: \([^)]*\))?)?$/],
  ['Firefox', /(?:^|\/)(?:firefox|Firefox|firefox-bin|plugin-container)$/],
  ['Safari', /(?:^|\/)(?:Safari|Safari Technology Preview|com\.apple\.WebKit\.[A-Za-z]+)$/],
  ['Opera', /(?:^|\/)(?:Opera|Opera GX)(?: Helper(?: \([^)]*\))?)?$/],
  ['Arc', /(?:^|\/)Arc(?: Helper(?: \([^)]*\))?)?$/],
];

// Read executable names only, never argv (which may contain URLs/tokens).
// This is one veto, not proof that every possible browser or remote task is
// absent. A coordinator additionally needs durable inventory + a backend lease.
export function parseBrowserProcesses(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 2 * 1024 * 1024 || output.includes('\0')) throw Error('browser_census_unavailable');
  const found = new Set(); let rows = 0;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*([1-9][0-9]*)\s+(.+)$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[1])) || ++rows > 32768) throw Error('browser_census_unavailable');
    const executable = match[2].trim();
    const name = executable.slice(executable.lastIndexOf('/') + 1);
    // Crash reporters cannot host pages. Directory names (e.g. our native
    // browser-bridge runtime) are not the executable's browser identity.
    if (['browser_crashpad_handler', 'chrome_crashpad_handler'].includes(name)) continue;
    for (const [name, pattern] of known) if (pattern.test(executable)) found.add(name);
    // Unknown browser-branded apps and WebView hosts remain a veto. Avoid
    // interpreting arbitrary arguments or trusting an unknown name as idle.
    if (/(?:browser|chromium|chrome|firefox|webkit|webview)/i.test(name)
      && !known.some(([, pattern]) => pattern.test(executable))) found.add('unknown-browser');
    if (/Helper \(Renderer\)$/.test(executable) && !known.some(([, pattern]) => pattern.test(executable))) found.add('unknown-browser');
  }
  if (!rows) throw Error('browser_census_unavailable');
  return { knownBrowsersExited: found.size === 0, blockers: [...found].sort(), inventoryVerified: false };
}

export async function browserProcessCensus({ platform = process.platform, execute = run } = {}) {
  if (platform !== 'darwin') throw Error('browser_census_unsupported');
  try {
    const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,comm='], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
    return parseBrowserProcesses(stdout);
  } catch { throw Error('browser_census_unavailable'); }
}
