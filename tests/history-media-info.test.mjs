import test from 'node:test';
import assert from 'node:assert/strict';
import { historyMediaInfo } from '../src/canvas/lib/canvas/history-media-info.js';

test('history shows real delivered dimensions and format, not requested or original sizes', () => {
    assert.deepEqual(historyMediaInfo({ metadata: { channel:'ZZ One', model:'gpt-image-2', size:'912x1200', naturalWidth:1093, naturalHeight:1439, bytes:2200000, mimeType:'image/png', originalImage:{width:2048,height:3072} } }), {
        channel:'ZZ One', model:'gpt-image-2', dimensions:'1093x1439', bytes:2200000, format:'PNG'
    });
});

test('batch info matches the primary image, without borrowing another image dimensions', () => {
    const metadata={ primaryImageId:'second', naturalWidth:100, naturalHeight:100, images:[{id:'first',content:'first',naturalWidth:100,naturalHeight:100,bytes:200,mimeType:'image/png'},{id:'second',content:'second',naturalWidth:900,naturalHeight:1200,bytes:300,mimeType:'image/jpeg'}] };
    assert.equal(historyMediaInfo({metadata}).dimensions,'900x1200');
    assert.equal(historyMediaInfo({metadata}).format,'JPG');
    metadata.images[1].naturalWidth=0;
    assert.equal(historyMediaInfo({metadata}).dimensions,'尺寸未知');
});

test('failed media remains honest about unknown fields, and video formats are supported', () => {
    assert.equal(historyMediaInfo({metadata:{size:'1152x1536',status:'error'}}).dimensions,'尺寸未知');
    assert.equal(historyMediaInfo({metadata:{mimeType:'video/mp4'}}).format,'MP4');
    assert.equal(historyMediaInfo({}).format,'格式未知');
});
