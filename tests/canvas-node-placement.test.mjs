import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';

const source = readFileSync(new URL('../src/canvas/lib/canvas/canvas-node-placement.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { placeCanvasNode, placeNewCanvasNodes, arrangeOverlappingCanvasNodes, nodesOverlap } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const card = (id, x = 637, y = 291, width = 340, height = 240, metadata = {}) => ({ id, type: 'config', title: id, position: { x, y }, width, height, metadata });
function noOverlaps(nodes) {
  const cards = nodes.filter(node => node.type !== 'group');
  cards.forEach((node, index) => cards.slice(index + 1).forEach(other => assert.equal(nodesOverlap(node, other), false, `${node.id} overlaps ${other.id}`)));
}

test('five same-position cards are reserved in one batch; existing cards stay fixed', () => {
  const first = card('first');
  const nodes = placeNewCanvasNodes([first], [first, ...Array.from({ length: 4 }, (_, i) => card(String(i)))]);
  noOverlaps(nodes);
  assert.equal(nodes[0], first);
  assert.equal(nodes[1].position.y, first.position.y + first.height + 48);
});

test('functional sequential additions use the latest transaction, not stale closure nodes', () => {
  let nodes = [];
  for (let i = 0; i < 40; i++) nodes = placeNewCanvasNodes(nodes, [...nodes, card(String(i))]);
  noOverlaps(nodes);
});

test('manual placement prefers visible free space at every zoom', () => {
  for (const zoom of [0.5, 1, 2]) {
    const existing = card('old', 100, 100, 150, 120);
    const bounds = { x: 0, y: 0, width: 1200 / zoom, height: 800 / zoom };
    const placed = placeCanvasNode(card('new', 100, 100, 150, 120), [existing], bounds);
    noOverlaps([existing, placed]);
    assert.ok(placed.position.x >= 0 && placed.position.y >= 0);
    assert.ok(placed.position.x + placed.width <= bounds.width && placed.position.y + placed.height <= bounds.height);
  }
});

test('organizer moves only overlapping victims and preserves content, IDs and fixed unrelated cards', () => {
  const original = [card('a'), card('b'), card('c'), card('unrelated', 637, 1000)];
  original[1].metadata = { content: 'customer input', status: 'success', storageKey: 'keep' };
  const snapshot = structuredClone(original);
  const arranged = arrangeOverlappingCanvasNodes(original);
  noOverlaps(arranged);
  assert.equal(arranged[0], original[0]);
  assert.equal(arranged[3], original[3]);
  assert.equal(arranged[1].metadata, original[1].metadata);
  assert.deepEqual(original, snapshot, 'pure and safe under React updater replay');
  assert.equal(arrangeOverlappingCanvasNodes(arranged), arranged, 'idempotent');
});

test('empty and already separated layouts are untouched; manual drag and resize may overlap', () => {
  const nodes = [card('a', 0, 0), card('b', 700, 0)];
  assert.equal(arrangeOverlappingCanvasNodes(nodes), nodes);
  const moved = [nodes[0], { ...nodes[1], position: { x: 0, y: 0 }, width: 500 }];
  assert.equal(placeNewCanvasNodes(nodes, moved), moved);
  const empty = [];
  assert.equal(arrangeOverlappingCanvasNodes(empty), empty);
});

test('container backgrounds are ignored, members avoid collisions and group bounds expand', () => {
  const group = { ...card('group', 0, 0, 600, 400), type: 'group' };
  const a = card('a', 40, 60, 340, 240, { groupId: 'group' });
  const b = card('b', 40, 60, 340, 240, { groupId: 'group' });
  const nodes = placeNewCanvasNodes([group, a], [group, a, b]);
  noOverlaps(nodes);
  assert.equal(nodes[2].metadata.groupId, 'group');
  assert.ok(nodes[0].position.y + nodes[0].height >= nodes[2].position.y + nodes[2].height);
  assert.equal(placeCanvasNode(card('standalone', 20, 20), [group]).position.x, 20);
});

test('final prompts and repeated results stay in their source column without overlapping', () => {
  const source = card('source', 0, 0);
  const preview = { ...card('preview', 436, 0), type: 'text' };
  const oldResult = { ...card('result', 872, 0, 640, 480), type: 'image' };
  const nodes = placeNewCanvasNodes([source, preview, oldResult], [source, preview, oldResult, { ...oldResult, id: 'result2' }]);
  noOverlaps(nodes);
  assert.equal(nodes[3].position.x, 872);
  assert.equal(nodes[3].position.y, 528);
});

test('generated image expansion is checked without moving its neighbors', () => {
  const original = { ...card('image', 0, 0, 340, 240, { generationStartedAt: 1, status: 'loading' }), type: 'image' };
  const neighbor = card('neighbor', 0, 350);
  const completed = { ...original, height: 640, metadata: { generationStartedAt: 1, status: 'success', content: '/asset.png' } };
  const nodes = placeNewCanvasNodes([original, neighbor], [completed, neighbor]);
  noOverlaps(nodes);
  assert.equal(nodes[1], neighbor);
});

test('malformed and very distant nodes cannot cause unbounded placement loops', () => {
  const bad = card('bad', NaN, Infinity);
  const distant = card('distant', 637, 1e9);
  const original = card('a');
  const placed = placeCanvasNode(card('b'), [original, bad, distant]);
  assert.ok(Number.isFinite(placed.position.y));
  assert.ok(placed.position.y < 10000);
  assert.equal(nodesOverlap(original, placed), false);
});

test('canvas hydration and undo/redo bypass new-node placement, canvas menu exposes organizer', () => {
  const project = readFileSync(new URL('../src/canvas/pages/canvas/project.tsx', import.meta.url), 'utf8');
  const toolbar = readFileSync(new URL('../src/canvas/components/canvas/canvas-toolbar.tsx', import.meta.url), 'utf8');
  assert.ok(project.includes('setRawNodes(restoredNodes)'));
  assert.ok(project.includes('setRawNodes(entry.nodes)'));
  assert.ok(project.includes('placeNewCanvasNodes(previous, typeof update'));
  assert.ok(project.includes('nodeTransactionRef.current = next'), 'reserve canonical positions synchronously before next batch creation');
  const menu = readFileSync(new URL('../src/canvas/components/canvas/canvas-top-bar.tsx', import.meta.url), 'utf8');
  assert.ok(menu.includes('onOrganizeOverlaps'));
  assert.ok(!toolbar.includes('onOrganizeOverlaps'));
});

test('canvas state bridge immediately publishes reserved positions for same-frame auto creation', () => {
  const project = readFileSync(new URL('../src/canvas/pages/canvas/project.tsx', import.meta.url), 'utf8');
  const hooks = project.slice(project.indexOf('const [nodes, setNodeState]'), project.indexOf('const [connections, setConnections]'));
  const js = ts.transpileModule(hooks, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let rendered = [];
  const api = new Function('useState', 'useRef', 'useCallback', 'placeNewCanvasNodes', js + ';return {setNodes,setRawNodes,nodesRef};')(
    () => [[], next => { rendered = next; }], initial => ({ current: initial }), callback => callback, placeNewCanvasNodes,
  );
  const original = [card('a')];
  api.setRawNodes(original);
  for (let i = 0; i < 5; i++) {
    // Several existing creation paths publish their preliminary array to the ref.
    const pending = [...api.nodesRef.current, card('new-' + i)];
    api.nodesRef.current = pending;
    api.setNodes(pending);
    noOverlaps(api.nodesRef.current);
    assert.equal(api.nodesRef.current, rendered);
  }
  api.setNodes(prev => [...prev, card('functional')]);
  noOverlaps(rendered);
  const exact = [card('a'), card('intentional-overlap')];
  api.setRawNodes(exact);
  assert.equal(api.nodesRef.current, exact, 'undo/load preserves original positions');
});
