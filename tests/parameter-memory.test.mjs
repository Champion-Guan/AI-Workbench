import test from 'node:test';
import assert from 'node:assert/strict';
import { parameterMemoryKey, readParameterMemory, saveParameterMemory } from '../src/canvas/lib/canvas/parameter-memory.js';

const memory = () => {
    const data = new Map();
    return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
};

test('parameter memory follows stable product identity, not card id or renamed title', () => {
    const a = parameterMemoryKey('http://localhost/infinite-canvas/canvas/one?workbenchProductId=A&productTitle=Old');
    assert.equal(a, parameterMemoryKey('http://localhost/infinite-canvas/canvas/two?workbenchProductId=A&productTitle=New'));
    assert.notEqual(a, parameterMemoryKey('http://localhost/infinite-canvas/canvas/one?workbenchProductId=B'));
    assert.notEqual(parameterMemoryKey('http://localhost/canvas/one'), parameterMemoryKey('http://localhost/canvas/two'));
    assert.equal(parameterMemoryKey('http://localhost/'), null);
});

test('per-field saves survive card deletion, preserve other fields and explicit clears', () => {
    const storage = memory();
    saveParameterMemory(storage, 'A', { '[PRODUCT NAME]': '针套装', '[COLOR]': '红色' });
    saveParameterMemory(storage, 'A', { '[PRODUCT NAME]': '新名称' });
    assert.deepEqual(readParameterMemory(storage, 'A'), { '[PRODUCT NAME]': '新名称', '[COLOR]': '红色' });
    saveParameterMemory(storage, 'A', { '[COLOR]': '' });
    assert.equal(readParameterMemory(storage, 'A')['[COLOR]'], '');
    assert.deepEqual(readParameterMemory(storage, 'B'), {});
});

test('unavailable storage and malformed backups do not crash card editing', () => {
    const storage = memory();
    storage.setItem('A', '{broken');
    assert.deepEqual(readParameterMemory(storage, 'A'), {});
    storage.setItem('A', JSON.stringify({ '[COLOR]': '蓝色', invalid: 123 }));
    assert.deepEqual(readParameterMemory(storage, 'A'), { '[COLOR]': '蓝色' });
    assert.equal(saveParameterMemory(null, 'A', {}), false);
    assert.equal(saveParameterMemory(storage, null, {}), false);
});
