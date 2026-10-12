import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchBrowserHosts, workbenchPageCensus, workbenchTabScript } from '../src/server/workbench-page-census.mjs';

const list = '1 /sbin/launchd\n42 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n';
const fake = (reply = '0\n') => async (file, args, options) => {
  assert.deepEqual(options.env, { PATH: '/usr/bin:/bin', LC_ALL: 'C' });
  if (file === '/bin/ps') { assert.deepEqual(args, ['-axo', 'pid=,comm=']); return { stdout: list }; }
  assert.equal(file, '/usr/bin/osascript'); assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.equal(args[3], workbenchTabScript('com.google.Chrome', 42));
  return { stdout: reply };
};
test('Chrome may remain open with unrelated websites; only matching workbench tabs veto', async () => {
  const closed = await workbenchPageCensus({ execute: fake() });
  assert.equal(closed.workbenchPagesClosed, true); assert.equal(closed.pages, 0);
  assert.equal(closed.inventoryVerified, false);
  const opened = await workbenchPageCensus({ execute: fake('2\n') });
  assert.equal(opened.workbenchPagesClosed, false); assert.equal(opened.pages, 2);
  assert.deepEqual(opened.blockers, ['Chrome']);
});
test('unrelated app renderers and shared WebKit processes never require closing those apps', async () => {
  const rows = '1 /sbin/launchd\n2 /Applications/Clash Party.app/Clash Party Helper (Renderer)\n'
    + '3 /Applications/WeChat.app/WeChatAppEx Helper (Renderer)\n4 /Applications/Spotify.app/Spotify Helper (Renderer)\n'
    + '5 /System/Library/Frameworks/WebKit.framework/com.apple.WebKit.WebContent\n6 /Applications/ChatGPT.app/browser_crashpad_handler\n';
  assert.deepEqual(workbenchBrowserHosts(rows), []);
  assert.equal((await workbenchPageCensus({ execute: async file => {
    assert.equal(file, '/bin/ps'); return { stdout: rows };
  } })).workbenchPagesClosed, true);
});
test('unavailable automation, malformed results, unsupported browsers and reopening cannot mean closed', async () => {
  for (const reply of ['unknown', '-1', '100000', '0\nsecret-url'])
    await assert.rejects(workbenchPageCensus({ execute: fake(reply) }), /inventory_unavailable/);
  await assert.rejects(workbenchPageCensus({ execute: async () => { throw Error('secret'); } }), /^Error: install_page_inventory_unavailable$/);
  await assert.rejects(workbenchPageCensus({ platform: 'linux' }), /inventory_unavailable/);
  let calls = 0;
  await assert.rejects(workbenchPageCensus({ execute: async file => {
    if (file === '/usr/bin/osascript') return { stdout: '0' };
    return { stdout: ++calls === 1 ? list : list + '43 /Applications/Safari.app/Contents/MacOS/Safari\n' };
  } }), /inventory_unavailable/);
  const unsupported = await workbenchPageCensus({ execute: async () => ({ stdout: '1 /sbin/launchd\n2 /Applications/Firefox.app/firefox\n' }) });
  assert.equal(unsupported.workbenchPagesClosed, false);
  assert.deepEqual(unsupported.blockers, ['unsupported-browser']);
});
test('tab query enumerates every window and tab and returns only count without site data or mutations', () => {
  const script = workbenchTabScript('com.google.Chrome', 42);
  assert.match(script, /spec\('cwin', 'indx'/); assert.match(script, /spec\('CrTb', 'indx'/);
  assert.match(script, /descriptorWithProcessIdentifier\(42\)/);
  assert.ok(script.includes("'http://127.0.0.1:8888'"));
  assert.ok(script.includes("'http://localhost:8888'"));
  assert.match(script, /String\(workbenchCount\)/);
  assert.doesNotMatch(script, /execute javascript|close |quit|make new|title|contents/);
  assert.throws(() => workbenchTabScript('untrusted" app'), /unavailable/);
});
test('all main processes of the same browser are queried independently, including separate profiles', async () => {
  const processes = list + '81 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n';
  const queried = [];
  const result = await workbenchPageCensus({ execute: async (file, args) => {
    if (file === '/bin/ps') return { stdout: processes };
    queried.push(args[3]);
    return { stdout: args[3].includes('descriptorWithProcessIdentifier(81)') ? '1' : '0' };
  } });
  assert.equal(queried.length, 2); assert.equal(result.workbenchPagesClosed, false); assert.equal(result.pages, 1);
});
