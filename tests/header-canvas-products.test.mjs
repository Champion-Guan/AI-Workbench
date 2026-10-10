import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { activeCanvasProduct, readCanvasProducts, rememberCanvasSelection } from '../src/shared/data-contract/workbook-canvas-products.js';

const source = readFileSync(new URL('../src/shared/data-contract/index.js', import.meta.url), 'utf8');
const render = source.slice(source.indexOf('function renderHeaderControls('), source.indexOf('\nfunction ', source.indexOf('function renderHeaderControls(') + 1));

test('capsule navigation grows into remaining header space at every breakpoint', () => {
  const css = readFileSync(new URL('../src/shared/data-contract/index.css', import.meta.url), 'utf8');
  const blocks = [...css.matchAll(/\.guan-dc-product-nav\s*\{([^}]+)\}/g)].map(match => match[1]);
  assert.match(blocks[0], /flex:\s*1 1 0;/);
  assert.match(blocks[0], /min-width:\s*0;/);
  assert.match(blocks[0], /max-width:\s*none;/);
  assert.match(blocks[0], /overflow-x:\s*auto;/);
  for (const block of blocks) {
    assert.doesNotMatch(block, /max-width:\s*(?:min\(|[\d.]+(?:px|vw))/);
    assert.doesNotMatch(block, /transform:\s*translateX/);
  }
  const controls = css.match(/\.guan-dc-header-controls\s*\{([^}]+)\}/)[1];
  assert.match(controls, /flex:\s*1 1 0;/);
  assert.match(css.match(/\.guan-dc-file-picker\s*\{([^}]+)\}/)[1], /flex:\s*0 0 auto;/);
});

test('header retains workbook controls, names new canvases and updates active capsules', () => {
  const state = { productSets: [], products: [{ id: 'excel', productSetId: '', order: 1, identity: { titleZh: 'Excel product' } }], workspace: { activeProductId: 'excel' } };
  const values = new Map([['guan-header-canvas-projects', JSON.stringify([{ id: 'new', title: 'New product' }])]]);
  const controls = { dataset: { interactionsBound: 'true' }, querySelector: () => null, innerHTML: '' };
  const header = { querySelector: () => controls };
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const context = vm.createContext({
    document: { visibilityState: 'visible', querySelector: () => ({ querySelector: () => header }) },
    localStorage: storage,
    api: { getCanvasProducts: () => readCanvasProducts(storage), getActiveCanvasProduct: () => activeCanvasProduct(state, readCanvasProducts(storage), storage) },
    readState: () => state, canvasDisplayName: product => product.title || product.identity.titleZh,
    readCanvasCapsuleStatus: () => 'idle', escapeHtml: value => value,
    productIsRunning: () => false,
  });
  vm.runInContext(render, context);
  vm.runInContext('renderHeaderControls({})', context);
  assert.match(controls.innerHTML, /New product/);
  assert.match(controls.innerHTML, /当前工作表/);
  assert.match(controls.innerHTML, /新建产品/);
  assert.match(controls.innerHTML, /导入产品/);
  controls.dataset.activeCanvasId = 'new';
  rememberCanvasSelection(storage, null, 'new');
  vm.runInContext('renderHeaderControls({})', context);
  assert.match(controls.innerHTML, /aria-selected="true" data-product-id="new"/);
  controls.dataset.activeCanvasId = 'excel';
  rememberCanvasSelection(storage, null, 'excel');
  vm.runInContext('renderHeaderControls({})', context);
  assert.match(controls.innerHTML, /aria-selected="true" data-product-id="excel"/);
});

test('canvas registry uses header container and messages synchronize creation, imports and rename', () => {
  assert.match(source, /const controls = document\.querySelector\("\.guan-dc-header-controls"\)/);
  assert.match(source, /frame\.contentWindow === event\.source/);
  assert.match(source, /sourceFrame\.dataset\.active !== "true"/);
  assert.match(source, /if \(!readState\(\)\.products\.some/);
  const canvas = readFileSync(new URL('../src/canvas/pages/canvas/project.tsx', import.meta.url), 'utf8');
  assert.match(canvas, /type: "guan-canvas-project-active"/);
  assert.match(canvas, /\[currentProject\?\.title, projectId, workbenchProductId\]/);
  const bridge = readFileSync(new URL('../src/canvas/services/product-recycle-bridge.ts', import.meta.url), 'utf8');
  assert.match(bridge, /for \(const id of ids\)/);
});

test('standalone canvas switching reuses independent frames without changing their routes', () => {
  const shell = readFileSync(new URL('../public/assets/local-canvas/canvas.js', import.meta.url), 'utf8');
  const create = shell.slice(shell.indexOf('  const createNativeFrame ='), shell.indexOf('  const buildRoot ='));
  let created = 0;
  const context = vm.createContext({
    state: { frameCache: new Map() },
    document: { createElement: () => { created++; return { dataset: {}, addEventListener() {} }; } },
    canvasRouteForProduct: product => `/canvas/${product.id}`,
    productDisplayName: product => product.title,
  });
  vm.runInContext(create + '\nglobalThis.createFrame = createNativeFrame;', context);
  const excel = context.createFrame({ id: 'excel', title: 'Excel' });
  const fresh = context.createFrame({ id: 'new', title: 'New', standalone: true });
  const imported = context.createFrame({ id: 'import', title: 'Imported', standalone: true });
  for (let i = 0; i < 3; i++) {
    assert.equal(context.createFrame({ id: 'excel' }), excel);
    assert.equal(context.createFrame({ id: 'new', standalone: true }), fresh);
    assert.equal(context.createFrame({ id: 'import', standalone: true }), imported);
  }
  assert.equal(created, 3);
  assert.equal(excel.src, '/canvas/excel');
  assert.equal(fresh.src, '/canvas/new');
  assert.equal(imported.src, '/canvas/import');
  assert.match(shell, /if \(product\?\.standalone\) return `\/canvas\//);
  assert.match(shell, /previousFrame\.dataset\.active = "false"/);
  assert.match(source, /new CustomEvent\("guan-native-canvas-select"/);
  assert.doesNotMatch(source, /type: "guan-canvas-open-project"/);
});

test('legacy standalone routes never replace workbook canvas routes', () => {
  const shell = readFileSync(new URL('../public/assets/local-canvas/canvas.js', import.meta.url), 'utf8');
  const routeCode = shell.slice(shell.indexOf('  const canvasRouteForProduct ='), shell.indexOf('  const storageKey ='));
  const values = new Map([
    ['guan-native-canvas-route:excel', '/canvas/imported'],
    ['guan-header-canvas-projects', JSON.stringify([{ id: 'imported', title: 'Imported' }])],
  ]);
  const context = vm.createContext({ localStorage: { getItem: key => values.get(key) || null }, productDisplayName: () => 'Excel' });
  vm.runInContext(routeCode + '\nglobalThis.route = canvasRouteForProduct;', context);
  assert.match(context.route({ id: 'excel' }), /^\/canvas\/excel\?/);
  assert.equal(context.route({ id: 'imported', standalone: true }), '/canvas/imported');
  values.set('guan-native-canvas-route:excel', '/canvas/original');
  assert.match(context.route({ id: 'excel' }), /^\/canvas\/original\?/);
});
