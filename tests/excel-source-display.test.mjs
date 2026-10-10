import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/canvas/components/canvas/canvas-node.tsx', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('function TextContent('));
const declarations = renderer.slice(renderer.indexOf('    const texts ='), renderer.indexOf('    const isExcelPrompt ='));
const display = (metadata, isEditingContent = false) => vm.runInNewContext(declarations + '\ncontent;', { node: { metadata }, isEditingContent });

test('Excel source cards retain placeholders in display and editing, even with cached resolved text', () => {
    const metadata = { content: 'Hello [PRODUCT NAME]', excelPromptRaw: 'Hello [PRODUCT NAME]', excelPromptResolved: 'Hello Kit' };
    assert.equal(display(metadata), 'Hello [PRODUCT NAME]');
    assert.equal(display(metadata, true), 'Hello [PRODUCT NAME]');
    assert.equal(display({ ...metadata, content: 'Manual [PRODUCT NAME]' }), 'Manual [PRODUCT NAME]');
    assert.equal(display({ ...metadata, content: '' }), '');
    assert.equal(display({ excelPromptRaw: metadata.excelPromptRaw, excelPromptResolved: 'Hello Kit' }), metadata.excelPromptRaw);
});

test('final previews and batch text cards display their own content', () => {
    assert.equal(display({ content: 'Hello Kit', promptVariablePreviewOf: 'parameters' }), 'Hello Kit');
    assert.equal(display({ content: 'fallback', texts: [{ id: 'a', content: 'first' }, { id: 'b', content: 'second' }], primaryTextId: 'b' }), 'second');
});
