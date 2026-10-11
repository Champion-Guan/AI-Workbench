import test from 'node:test';
import assert from 'node:assert/strict';
import { browserProcessCensus, parseBrowserProcesses } from '../src/server/browser-process-census.mjs';

test('known browsers and background helpers are installation vetoes, not tab counters', () => {
  const result = parseBrowserProcesses('1 /sbin/launchd\n42 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n43 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer)\n44 /Applications/Safari.app/Contents/MacOS/Safari\n');
  assert.deepEqual(result.blockers, ['Chrome', 'Safari']); assert.equal(result.knownBrowsersExited, false);
  assert.equal(result.inventoryVerified, false);
});
test('custom browser hosts and WebKit workers remain blocked while unrelated names do not fabricate authority', () => {
  assert.deepEqual(parseBrowserProcesses('1 /sbin/launchd\n9 /Applications/Custom Browser.app/Contents/MacOS/custom-browser\n').blockers, ['unknown-browser']);
  assert.deepEqual(parseBrowserProcesses('1 /sbin/launchd\n9 /Applications/Custom.app/Contents/Frameworks/Custom Helper (Renderer)\n').blockers, ['unknown-browser']);
  assert.deepEqual(parseBrowserProcesses('1 /sbin/launchd\n9 /System/Library/Frameworks/WebKit.framework/com.apple.WebKit.WebContent\n').blockers, ['Safari']);
  assert.deepEqual(parseBrowserProcesses('1 /sbin/launchd\n9 /Applications/Notes.app/Contents/MacOS/Notes\n'),
    { knownBrowsersExited: true, blockers: [], inventoryVerified: false });
});
test('malformed, empty, oversized, failed and unsupported census never means idle', async () => {
  for (const value of ['', 'not a process', '1 node\0private', '1 ' + 'x'.repeat(2 * 1024 * 1024)]) assert.throws(() => parseBrowserProcesses(value));
  await assert.rejects(browserProcessCensus({ platform: 'linux' }), /unsupported/);
  await assert.rejects(browserProcessCensus({ platform: 'darwin', execute: async () => { throw Error('private argv'); } }), /^Error: browser_census_unavailable$/);
});
test('crash reporters and native bridge paths are not page hosts, while unknown renderers still veto', () => {
  const rows = '1 /sbin/launchd\n10 /Applications/Codex.app/Helpers/browser_crashpad_handler\n'
    + '11 /Applications/Google Chrome.app/Helpers/chrome_crashpad_handler\n'
    + '12 /private/browser-bridge/runtime/node\n';
  assert.deepEqual(parseBrowserProcesses(rows), { knownBrowsersExited: true, blockers: [], inventoryVerified: false });
  assert.deepEqual(parseBrowserProcesses(rows + '13 /Applications/Custom.app/Custom Helper (Renderer)\n').blockers, ['unknown-browser']);
  assert.deepEqual(parseBrowserProcesses(rows + '14 /Applications/Custom.app/embedded-webview\n').blockers, ['unknown-browser']);
});
test('census requests only command names through fixed ps, never shell/argv or inherited secrets', async () => {
  const result = await browserProcessCensus({ platform: 'darwin', execute: async (file, args, options) => {
    assert.equal(file, '/bin/ps'); assert.deepEqual(args, ['-axo', 'pid=,comm=']);
    assert.deepEqual(options.env, { PATH: '/usr/bin:/bin', LC_ALL: 'C' });
    assert.equal(options.timeout, 3000); return { stdout: '1 /sbin/launchd\n' };
  } });
  assert.equal(result.knownBrowsersExited, true); assert.equal(result.inventoryVerified, false);
});
