import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/canvas/public/excel-prompts-bridge.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('  const clean ='), source.indexOf('  const parentContractState ='));

test('video import defaults off, persists an explicit choice and safely handles unavailable storage', () => {
    for (const [saved, expected] of [[null, false], ['true', true], ['false', false]]) {
        assert.equal(vm.runInNewContext(helpers + 'includeVideoPrompts()', { localStorage: { getItem: () => saved } }), expected);
    }
    assert.equal(vm.runInNewContext(helpers + 'includeVideoPrompts()', { localStorage: { getItem: () => { throw Error('blocked'); } } }), false);
    assert.match(source, /videoLabel\.title =/);
    assert.doesNotMatch(source, /createTextNode\("是否导入视频提示词"\)/);
});

test('batch import skips only video metadata when off and includes all prompt types when on', () => {
    const keys = ['Main Prompt', 'Detail Prompt 01', 'Rich Prompt 01', 'Video Prompt'];
    for (const enabled of [false, true]) {
        const selected = vm.runInNewContext(helpers + 'keys.filter(key => shouldImportPrompt(key, enabled))', { keys, enabled });
        assert.deepEqual(Array.from(selected), enabled ? keys : keys.slice(0, 3));
    }
    assert.match(source, /shouldImportPrompt\(key, includeVideo\)/);
    assert.match(source, /getAttribute\("data-excel-prompt-key"\)/);
    const panel = readFileSync(new URL('../src/canvas/components/canvas/canvas-side-panel.tsx', import.meta.url), 'utf8');
    assert.match(panel, /data-excel-prompt-key=\{excelPrompt\?\.key\}/);
});
