import assert from 'node:assert/strict';
import test from 'node:test';
import { generatedImageName, numberGeneratedImages } from '../src/canvas/lib/canvas/generated-image-names.js';
const node = (id, base, count = 1) => ({ id, type: 'image', title: base, base, metadata: { images: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, status: 'loading' })) } });
const baseOf = node => node.base;

test('main and detail prompts each number independently, including batches and repeated generations', () => {
    const result = numberGeneratedImages([node('a', '主图', 2), node('b', '详情页01', 2), node('c', '主图')], baseOf);
    assert.deepEqual(result.map(node => node.title), ['主图-1', '详情页01-1', '主图-3']);
    assert.equal(generatedImageName(result[0], 'a-1'), '主图-2');
    assert.equal(generatedImageName(result[1], 'b-1'), '详情页01-2');
    assert.equal(numberGeneratedImages(result, baseOf), result, 'stable on rerender and reload');
});

test('failed slots keep names on retry; deleting a batch slot does not rename remaining images', () => {
    const [batch] = numberGeneratedImages([node('a', '主图', 3)], baseOf);
    batch.metadata.images = batch.metadata.images.filter(image => image.id !== 'a-1');
    const result = numberGeneratedImages([batch, node('b', '主图')], baseOf);
    assert.equal(generatedImageName(result[0], 'a-2'), '主图-3');
    assert.equal(result[1].title, '主图-4');
    batch.metadata.images[1].status = 'error';
    assert.equal(generatedImageName(batch, 'a-2'), '主图-3');
});

test('unrelated uploaded images remain untouched and legacy numbered batches have fallback names', () => {
    const uploaded = { id: 'upload', type: 'image', title: '产品照片', metadata: {} };
    assert.equal(numberGeneratedImages([uploaded], () => '' )[0], uploaded);
    assert.equal(generatedImageName({ title: '详情页01-1', metadata: { images: [{ id: 'a' }, { id: 'b' }] } }, 'b'), '详情页01-2');
});
