import test from 'node:test';
import assert from 'node:assert/strict';
import { sortGenerationHistory } from '../src/canvas/lib/canvas/history-sort.js';

test('history sorts category, prompt number and image number numerically', () => {
    const titles=['其他任务','富内容02-1','详情页10-1','主图-10','详情页01-2','富内容01-2','详情页02-1','主图-2','详情页01-1','主图-1','富内容01-1','其他视频'];
    const nodes=titles.map(title=>({title}));
    assert.deepEqual(sortGenerationHistory(nodes).map(node=>node.title), ['主图-1','主图-2','主图-10','详情页01-1','详情页01-2','详情页02-1','详情页10-1','富内容01-1','富内容01-2','富内容02-1','其他任务','其他视频']);
    assert.deepEqual(nodes.map(node=>node.title),titles,'canvas node order is untouched');
});

test('same-name cards and other tasks retain their original relative order', () => {
    const nodes=[{id:'a',title:'未命名'},{id:'b',title:'主图-1'},{id:'c',title:'主图-1'},{id:'d'}];
    assert.deepEqual(sortGenerationHistory(nodes).map(node=>node.id),['b','c','a','d']);
    assert.deepEqual(sortGenerationHistory([]),[]);
});
