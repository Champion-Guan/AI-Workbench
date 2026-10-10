import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as helpers from '../src/shared/data-contract/workbook-canvas-products.js';

const { CANVAS_PRODUCTS_KEY, readCanvasProducts, workbookCanvasProducts, registerCanvasProduct, activeCanvasProduct, rememberCanvasSelection } = helpers;
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const source = read('src/shared/data-contract/index.js');
function storage(initial = []) {
  const values = new Map([[CANVAS_PRODUCTS_KEY, JSON.stringify(initial)]]);
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function state(owner = 'a') {
  return { workspace: { activeProductSetId: owner, activeProductId: owner === 'a' ? 'excel-a' : 'excel-b' }, productSets: [{ id: 'a' }, { id: 'b' }], products: [{ id: 'excel-a', productSetId: 'a', order: 1 }, { id: 'excel-b', productSetId: 'b', order: 1 }] };
}

test('legacy global products adopt the current workbook once without changing IDs or routes', () => {
  const saved = storage([{ id: 'legacy', title: 'Old', route: '/canvas/legacy' }, { id: 'owned', productSetId: 'b' }]);
  const adopted = readCanvasProducts(saved, 'a');
  assert.deepEqual(adopted[0], { id: 'legacy', title: 'Old', route: '/canvas/legacy', productSetId: 'a' });
  assert.equal(readCanvasProducts(saved, 'b')[0].productSetId, 'a');
  assert.deepEqual(workbookCanvasProducts(adopted, 'a').map(item => item.id), ['legacy']);
  assert.deepEqual(workbookCanvasProducts(adopted, 'b').map(item => item.id), ['owned']);
});

test('new/imported products are workbook-scoped; rename and same titles never reparent or merge them', () => {
  const saved = storage();
  registerCanvasProduct(saved, { id: 'new-a', title: 'Same', productSetId: 'a' }, 'a');
  registerCanvasProduct(saved, { id: 'import-b', title: 'Same', productSetId: 'b' }, 'b');
  const projects = readCanvasProducts(saved, 'a');
  assert.deepEqual(workbookCanvasProducts(projects, 'a').map(item => item.id), ['new-a']);
  assert.deepEqual(workbookCanvasProducts(projects, 'b').map(item => item.id), ['import-b']);
  registerCanvasProduct(saved, { id: 'new-a', title: 'Renamed', productSetId: 'b' }, 'b');
  const renamed = readCanvasProducts(saved, 'b').find(item => item.id === 'new-a');
  assert.equal(renamed.productSetId, 'a');
  assert.equal(renamed.title, 'Renamed');
});

test('selection persists independently across switches and reloads; stale/cross-workbook IDs are ignored', () => {
  const saved = storage([{ id: 'a-new', productSetId: 'a' }, { id: 'b-import', productSetId: 'b' }]);
  rememberCanvasSelection(saved, 'a', 'a-new');
  rememberCanvasSelection(saved, 'b', 'b-import');
  assert.equal(activeCanvasProduct(state('a'), readCanvasProducts(saved), saved).id, 'a-new');
  assert.equal(activeCanvasProduct(state('b'), readCanvasProducts(saved), saved).id, 'b-import');
  assert.equal(activeCanvasProduct(state('a'), readCanvasProducts(saved), saved).standalone, true);
  for (const id of ['deleted', 'b-import']) {
    rememberCanvasSelection(saved, 'a', id);
    assert.equal(activeCanvasProduct(state('a'), readCanvasProducts(saved), saved).id, 'excel-a');
  }
});

test('an empty workbook never falls back to products from another workbook', () => {
  const saved = storage([{ id: 'a-new', productSetId: 'a' }]);
  const empty = state('b');
  empty.products = empty.products.filter(item => item.productSetId === 'a');
  assert.equal(activeCanvasProduct(empty, readCanvasProducts(saved), saved), null);
});

test('products explicitly created without a workbook are not repeatedly reassigned', () => {
  const saved = storage([{ id: 'unbound', productSetId: null }]);
  assert.deepEqual(workbookCanvasProducts(readCanvasProducts(saved, 'a'), 'a'), []);
  assert.equal(workbookCanvasProducts(readCanvasProducts(saved, 'a'), null)[0].id, 'unbound');
});

test('async import after switching workbooks keeps its original owner and does not steal focus', () => {
  const saved = storage(), current = state('b');
  const frame = { contentWindow: {}, dataset: { active: 'false' } };
  const controls = { dataset: { activeCanvasId: 'excel-b' } };
  let receive;
  const dispatched = [];
  const marker = source.indexOf('if (!["guan-canvas-project-created", "guan-canvas-project-active"]');
  const start = source.lastIndexOf('  window.addEventListener("message",', marker);
  const end = source.indexOf('\n  window.addEventListener("focus"', marker);
  const context = vm.createContext({ ...helpers, location: { origin: 'http://test' },
    window: { addEventListener: (_, callback) => { receive = callback; }, dispatchEvent: event => dispatched.push(event) },
    document: { querySelectorAll: () => [frame], querySelector: () => controls },
    readState: () => current, localStorage: saved, renderHeaderControls() {}, root: {}, alert: assert.fail,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  vm.runInContext(source.slice(start, end), context);
  receive({ origin: 'http://test', source: frame.contentWindow, data: { type: 'guan-canvas-project-created', projectId: 'async-a', title: 'Imported', productSetId: 'a' } });
  assert.equal(readCanvasProducts(saved)[0].productSetId, 'a');
  assert.equal(controls.dataset.activeCanvasId, 'excel-b');
  assert.equal(dispatched.length, 0);
  assert.equal(activeCanvasProduct(current, readCanvasProducts(saved), saved).id, 'excel-b');
});

test('actions capture ownership before awaiting service; every ZIP project echoes the original owner', () => {
  const bridge = read('src/canvas/services/product-recycle-bridge.ts');
  assert.match(source, /type: "guan-canvas-create-project", productSetId: activeWorkbookId\(readState\(\)\)/);
  assert.match(source, /canvasImportProductSetId = activeWorkbookId\(readState\(\)\)/);
  assert.match(source, /type: "guan-canvas-import-project", file, productSetId: controls.dataset.canvasImportProductSetId/);
  assert.equal((bridge.match(/productSetId: data.productSetId/g) || []).length, 2);
});

test('corrupt registry cannot be silently overwritten by registration', () => {
  const saved = storage();
  saved.setItem(CANVAS_PRODUCTS_KEY, '{bad');
  assert.throws(() => registerCanvasProduct(saved, { id: 'new', productSetId: 'a' }, 'a'));
  assert.equal(saved.getItem(CANVAS_PRODUCTS_KEY), '{bad');
});
