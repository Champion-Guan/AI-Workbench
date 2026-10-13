import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
const source = readFileSync(new URL('../src/canvas/lib/canvas/canvas-content-import.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace('"nanoid"', JSON.stringify(new URL('../src/canvas/node_modules/nanoid/index.js', import.meta.url).href));
const { prepareCanvasContentImport } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const node = (id, metadata = {}) => ({ id, type: 'image', title: id, position: { x: 0, y: 0 }, width: 200, height: 200, metadata });
const document = (nodes, connections = [], files = []) => ({ app: 'infinite-canvas', version: 3, projects: [{ project: { nodes, connections }, files }] });
test('imports remap node, connection, group and media references without changing existing data', () => {
  const blob = new Blob(['image']);
  const original = document([node('group'), node('image', { groupId: 'group', storageKey: 'image:old', references: ['image:old'], status: 'loading', videoTaskId: 'old-task' })], [{ id: 'wire', fromNodeId: 'group', toNodeId: 'image' }], [{ storageKey: 'image:old', path: 'media/image', bytes: blob.size, mimeType: 'image/png' }]);
  const snapshot = structuredClone(original), occupied = [node('existing')];
  const result = prepareCanvasContentImport(original, new Map([['media/image', blob]]), occupied);
  assert.notEqual(result.nodes[0].id, 'group');
  assert.equal(result.nodes[1].metadata.groupId, result.nodes[0].id);
  assert.equal(result.connections[0].toNodeId, result.nodes[1].id);
  assert.equal(result.nodes[1].metadata.storageKey, result.media[0].key);
  assert.deepEqual(result.nodes[1].metadata.references, [result.media[0].key]);
  assert.equal(result.nodes[1].metadata.status, 'error');
  assert.equal(result.nodes[1].metadata.videoTaskId, undefined);
  assert.ok(result.nodes[0].position.x > occupied[0].width);
  assert.deepEqual(original, snapshot);
});
test('missing media, duplicate nodes and broken connections refuse before canvas mutation', () => {
  assert.throws(() => prepareCanvasContentImport(document([node('a', { storageKey: 'image:missing' })]), new Map(), []), /媒体/);
  assert.throws(() => prepareCanvasContentImport(document([node('a'), node('a')]), new Map(), []), /重复/);
  assert.throws(() => prepareCanvasContentImport(document([node('a')], [{ fromNodeId: 'a', toNodeId: 'missing' }]), new Map(), []), /连线/);
});
