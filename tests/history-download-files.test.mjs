import test from 'node:test';
import assert from 'node:assert/strict';
import { historyDownloadFiles } from '../src/canvas/lib/canvas/history-download-files.js';
import { historyMediaInfo } from '../src/canvas/lib/canvas/history-media-info.js';

test('picker lists successful image and video files, excluding running and failed outputs', () => {
    const files = historyDownloadFiles([
        { id: 'main', title: '主图-1', metadata: { content: 'image', storageKey: 'cached', status: 'success' } },
        { id: 'video', title: '视频', metadata: { content: 'video', status: 'success' } },
        { id: 'loading', metadata: { content: 'old', status: 'loading' } },
        { id: 'error', metadata: { content: 'old', status: 'error' } },
        { id: 'empty', metadata: {} },
    ]);
    assert.deepEqual(files.map(file => file.name), ['主图-1', '视频']);
    assert.equal(files[0].storageKey, 'cached');
});

test('picker metadata follows each batch file rather than the primary image', () => {
    const files = historyDownloadFiles([{ id: 'batch', metadata: { channel: '渠道', model: '模型', primaryImageId: 'a', images: [
        { id: 'a', content: 'a', status: 'success', naturalWidth: 900, naturalHeight: 1200, bytes: 100, mimeType: 'image/png' },
        { id: 'b', content: 'b', status: 'success', naturalWidth: 800, naturalHeight: 500, bytes: 200, mimeType: 'image/jpeg' },
    ] } }]);
    const file = files[1];
    assert.deepEqual(historyMediaInfo({ ...file.node, metadata: { ...file.node.metadata, primaryImageId: file.imageId } }), {
        channel: '渠道', model: '模型', dimensions: '800x500', bytes: 200, format: 'JPG',
    });
});

test('partial batches expose individual successes without duplicating the primary output', () => {
    const files = historyDownloadFiles([{ id: 'batch', title: '详情页01-1', metadata: {
        content: 'one', status: 'error', images: [
            { id: '1', content: 'one', status: 'success' },
            { id: '2', content: 'two', status: 'success' },
            { id: '3', content: 'old', status: 'loading' },
            { id: '4', content: 'old', status: 'error' },
        ],
    } }]);
    assert.deepEqual(files.map(file => file.name), ['详情页01-1', '详情页01-2']);
    const selected = new Set([files[1].id]);
    assert.deepEqual(files.filter(file => selected.has(file.id)).map(file => file.content), ['two']);
    assert.equal(new Set(files.map(file => file.id)).size, files.length);
    assert.deepEqual(historyDownloadFiles([]), []);
});
