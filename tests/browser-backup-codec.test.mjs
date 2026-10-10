import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBackupValue, encodeBackupValue } from '../scripts/lib/browser-backup-codec.mjs';
test('browser backup codec roundtrips blobs, files, reference cycles and structured values', async () => {
  const source = { absent: undefined, zero: -0, big: 18n, nan: NaN,
    blob: new Blob([new Uint8Array([0, 255, 42])], { type: 'image/png' }),
    file: new File(['bytes'], 'fixture.png', { type: 'image/png', lastModified: 123 }),
    date: new Date('2026-10-10T00:00:00Z'), regexp: /fixture/gi,
    buffer: new Uint8Array([1, 2]).buffer, view: new Int16Array([34, -2]),
    map: new Map([['one', 1]]), set: new Set(['one', 'two']), array: [undefined, Infinity] };
  source.self = source;
  source.shared = source.blob;
  const packed = await encodeBackupValue(source), restored = decodeBackupValue(packed);
  assert.equal(restored.self, restored);
  assert.equal(restored.shared, restored.blob);
  assert.equal(restored.file.name, 'fixture.png');
  assert.deepEqual(await encodeBackupValue(restored), packed);
});
test('backup decoder rejects invalid refs/types/bytes and does not pollute prototypes', () => {
  for (const item of [{ $type: 'ref', id: 1 }, { $type: 'unsupported', id: 1 },
    { $type: 'blob', id: 1, mime: '', bytes: 10, base64: 'AA==' },
    { $type: 'typedarray', id: 1, kind: '__proto__', base64: '' }]) assert.throws(() => decodeBackupValue(item));
  const result = decodeBackupValue({ $type: 'object', id: 1, entries: [['__proto__', { $type: 'object', id: 2, entries: [['polluted', true]] }]] });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
});

test('large image payload validation does not overflow the regex stack', async () => {
  const original = new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'image/png' });
  const packed = await encodeBackupValue(original);
  const restored = decodeBackupValue(packed);
  assert.equal(restored.size, original.size);
  assert.equal(restored.type, original.type);
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), new Uint8Array(await original.arrayBuffer()));
});
