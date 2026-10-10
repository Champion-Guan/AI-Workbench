import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stableReleaseNotes } from '../scripts/lib/stable-release-notes.mjs';

test('version-specific notes exclude historical entries and preserve important release boundaries', async () => {
  const notes = stableReleaseNotes(await readFile(new URL('../docs/RELEASE-NOTES.md', import.meta.url), 'utf8'), '1.0.4');
  assert.match(notes, /自动安装关闭/); assert.match(notes, /notarization/); assert.doesNotMatch(notes, /SIGHUP/);
});
test('missing, duplicate, empty, oversized or unsafe-version release notes are rejected', () => {
  for (const [source, version] of [['## 1.0.3 — date\nold', '1.0.4'], ['## 1.0.4 — date\nx\n## 1.0.4 — date\ny', '1.0.4'],
    ['## 1.0.4 — date\n', '1.0.4'], ['x'.repeat(256 * 1024 + 1), '1.0.4'], ['## 1.0.4 — date\nx', '../1.0.4']]) assert.throws(() => stableReleaseNotes(source, version));
});
