import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('history selection enters inline mode before download without opening the picker', () => {
    const source = readFileSync(new URL('../src/canvas/components/canvas/canvas-side-panel.tsx', import.meta.url), 'utf8');
    const select = source.indexOf('className="guan-history-select');
    const download = source.indexOf('title={selectionMode ? "打包下载选择模式中勾选的文件"');
    assert.ok(select > 0 && select < download);
    const button = source.slice(source.lastIndexOf('<button', select), source.indexOf('</button>', select));
    assert.match(button, /onClick=\{toggleSelectionMode\}/);
    assert.doesNotMatch(button, /openDownloadPicker/);
    assert.match(button, /selectionMode \? "取消" : "选择"/);
    assert.match(source, /guan-history-selection-footer/);
    assert.match(source, /downloadAll\(selectedHistoryFiles\)/);
    assert.match(source.slice(source.lastIndexOf('<button', download), download), /downloadAll\(selectionMode \? selectedHistoryFiles : validCompletedFiles\)/);
    assert.doesNotMatch(source, /<Modal title="选择下载文件"/);
});
