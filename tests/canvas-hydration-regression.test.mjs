import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('image hydration retains resolved slots and marks invalid slots even when the primary URL is remote', () => {
    const source = readFileSync(new URL('../src/canvas/lib/canvas/canvas-generation-helpers.ts', import.meta.url), 'utf8');
    assert.match(source, /return \{ \.\.\.node, metadata: \{ \.\.\.metadata, images, \.\.\.\(hasInvalidImage/);
    assert.match(source, /imageMetadata\(await uploadImage\(content\)\)[\s\S]*images/);
});
