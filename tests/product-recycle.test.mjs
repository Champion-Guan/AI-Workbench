import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { detachProduct, reattachProduct } from '../src/shared/data-contract/product-recycle.js';
import { filterRecycledProjects, recycleMarkerKey } from '../src/canvas/lib/canvas/product-recycle-markers.js';
import { canvasTaskSummary } from '../src/canvas/lib/canvas/task-summary.js';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import * as canvasProducts from '../src/shared/data-contract/workbook-canvas-products.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';
import { createPersistenceFixture } from './helpers/persistence-checkpoint.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
class CustomEvent extends Event { constructor(type, init = {}) { super(type); this.detail = init.detail; } }

test('recycling one Excel product preserves its workbook and other products; restoration validates', () => {
  const saved = new Map();
  const context = vm.createContext({ ...canvasProducts, crypto: webcrypto, window: new EventTarget(), CustomEvent,
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } });
  const source = read('src/shared/data-contract/index.js').replace(/^import .*?;\s*/gm, '');
  const api = vm.runInContext(source.slice(0, source.indexOf('window.GuanWorkbenchData = api;')) + '; api', context);
  api.importPromptProducts({ fileName: 'original.xlsx', sheetName: 'Products', fileSha256: 'test', promptTemplates: [
    { id: 'one', route: 'A', order: 1, sourceRowNumber: 2, prompts: { 'Main Prompt': 'A' } },
    { id: 'two', route: 'B', order: 2, sourceRowNumber: 3, prompts: { 'Main Prompt': 'B' } },
  ] });
  const state = JSON.parse(JSON.stringify(api.getState()));
  const original = JSON.parse(JSON.stringify(state));
  const productId = state.products[0].id;
  const remaining = state.products[1];
  const archived = detachProduct(state, productId);
  assert.equal(state.products.length, 1);
  assert.deepEqual(state.products[0], remaining);
  assert.deepEqual(state.productSets[0].source, original.productSets[0].source);
  assert.ok(!state.productSets[0].productIds.includes(productId));
  api.saveState(state);
  reattachProduct(state, archived);
  api.saveState(state);
  assert.deepEqual(state.products.find(item => item.id === productId), original.products[0]);
  for (const name of ['slots', 'prompts', 'tasks', 'runs', 'providerAttempts', 'assets']) assert.equal(state[name].length, original[name].length);
  reattachProduct(state, archived);
  assert.equal(state.products.length, 2, 'restoring twice does not duplicate records');
});

test('other cached frames cannot persist a recycled canvas; restore retains the same id', () => {
  const markers = new Map();
  const storage = { getItem: key => markers.get(key) || null };
  const projects = [{ id: 'a', nodes: [{ metadata: { storageKey: 'image:original' } }] }, { id: 'b' }];
  markers.set(recycleMarkerKey('a'), 'deleted');
  assert.deepEqual(filterRecycledProjects(projects, storage), [projects[1]]);
  markers.delete(recycleMarkerKey('a'));
  assert.deepEqual(filterRecycledProjects(projects, storage), projects);
});

function bridgeHarness(projects, options = {}) {
  const markers = new Map(), saved = new Map(), replies = [], handlers = new Map();
  let state = { hydrated: true, projects: structuredClone(projects), deletedProjects: [] };
  const api = {
    getState: () => ({ ...state, openProject: id => state.projects.find(item => item.id === id),
      deleteProjects: ids => { state.projects = state.projects.filter(item => !ids.includes(item.id)); },
      replaceProjects: (projects, deletedProjects) => { state = { ...state, projects, deletedProjects }; },
    }),
  };
  saved.set('infinite-canvas:canvas_store', JSON.stringify({ state, version: 0 }));
  const parent = { postMessage: data => replies.push(data) };
  const storage = { getItem: key => markers.get(key) || null, setItem: (key, value) => markers.set(key, value), removeItem: key => markers.delete(key) };
  const activity = createActivityFixture(), persistence = createPersistenceFixture();
  const context = vm.createContext({
    ...persistence, ...activity, frontendActivity: activity.registry,
    window: { parent, addEventListener: (type, handler) => handlers.set(type, handler), dispatchEvent() {} },
    location: { origin: 'http://test' }, localStorage: storage, CustomEvent,
    useCanvasStore: api, canvasTaskSummary, recycleMarkerKey,
    filterRecycledProjects: projects => filterRecycledProjects(projects, storage),
    localForageStorage: { getItem: async key => saved.get(key) || null, setItem: async (key, value) => { if (options.failArchive && key.includes('product-recycle:')) throw new Error('disk full'); saved.set(key, value); } },
  });
  const checkpointCode = read('src/canvas/lib/checkpoint-local-storage.ts').replace(/^import .*?;\s*/gm, '').replace(/\bexport /g, '');
  vm.runInContext(ts.transpileModule(checkpointCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const code = read('src/canvas/services/product-recycle-bridge.ts').replace(/^import .*?;\s*/gm, '').replace('export function', 'function');
  vm.runInContext(ts.transpileModule(code + '\ninitProductRecycleBridge();', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { saved, markers, replies, flush: persistence.flushStorageCheckpoints, getState: () => state, request: data => handlers.get('message')({ origin: 'http://test', source: parent, data }) };
}

test('bridge archives and restores canvas content and media references, without deleting files', async () => {
  const project = { id: 'a', title: 'A', nodes: [{ id: 'image', type: 'image', metadata: { status: 'success', generationType: 'image', storageKey: 'image:keep' } }], connections: [], viewport: { x: 20, y: 30, k: 1 } };
  const harness = bridgeHarness([project, { id: 'b', nodes: [], connections: [] }]);
  await harness.request({ type: 'guan-product-recycle', projectId: 'a', recycleId: 'archive-a', requestId: 'delete' });
  assert.equal(harness.replies.at(-1).ok, true);
  assert.equal(harness.getState().projects.length, 1);
  assert.equal(harness.markers.get(recycleMarkerKey('a')), 'deleted');
  await harness.request({ type: 'guan-product-restore', projectId: 'a', recycleId: 'archive-a', requestId: 'restore' });
  assert.equal(harness.replies.at(-1).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.replies.at(-1).project)), project);
  assert.equal(harness.getState().projects.length, 2);
  assert.equal(harness.markers.has(recycleMarkerKey('a')), false);
  await harness.flush();
});

test('running batches and failed archive writes prevent deletion', async () => {
  const project = { id: 'a', nodes: [{ id: 'busy', type: 'image', metadata: { status: 'success', images: [{ status: 'loading' }], generationType: 'image' } }], connections: [] };
  const running = bridgeHarness([project]);
  await running.request({ type: 'guan-product-recycle', projectId: 'a', recycleId: 'archive-a', requestId: 'delete' });
  assert.equal(running.replies.at(-1).ok, false);
  assert.equal(running.getState().projects.length, 1);
  assert.equal(running.markers.size, 0);
  project.nodes = [];
  const failed = bridgeHarness([project], { failArchive: true });
  await failed.request({ type: 'guan-product-recycle', projectId: 'a', recycleId: 'archive-a', requestId: 'delete' });
  assert.equal(failed.replies.at(-1).ok, false);
  assert.equal(failed.getState().projects.length, 1);
  assert.equal(failed.markers.size, 0);
});

test('restore rejects mismatched snapshots before changing any live data', async () => {
  const harness = bridgeHarness([{ id: 'b', nodes: [], connections: [] }]);
  harness.saved.set('infinite-canvas:product-recycle:archive-a', JSON.stringify({ project: { id: 'wrong' } }));
  harness.markers.set(recycleMarkerKey('a'), 'deleted');
  await harness.request({ type: 'guan-product-restore', projectId: 'a', recycleId: 'archive-a', requestId: 'restore' });
  assert.equal(harness.replies.at(-1).ok, false);
  assert.equal(harness.getState().projects.length, 1);
  assert.equal(harness.markers.get(recycleMarkerKey('a')), 'deleted');
});
