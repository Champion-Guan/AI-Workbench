import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import * as canvasProducts from '../src/shared/data-contract/workbook-canvas-products.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
class CustomEvent extends Event { constructor(type, init = {}) { super(type); this.detail = init.detail; } }
function contract() {
    const saved = new Map();
    const context = vm.createContext({ ...canvasProducts, crypto: webcrypto, window: new EventTarget(), CustomEvent,
        localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } });
    const source = read('src/shared/data-contract/index.js').replace(/^import .*?;\s*/gm, '');
    return vm.runInContext(source.slice(0, source.indexOf('window.GuanWorkbenchData = api;')) + '; api', context);
}
const template = (id, route, prompt) => ({ id, route, order: 1, sourceRowNumber: 2, prompts: { 'Main Prompt': prompt } });
const upload = (api, hash, templates, fileName = 'products.xlsx') => api.importPromptProducts({ fileName, fileSha256: hash, sheetName: 'Prompts', promptTemplates: templates });

test('changed workbook updates existing product identities and source without losing history', () => {
    const api = contract();
    const first = upload(api, 'old', [template('one', 'A', 'old A'), template('two', 'B', 'old B')]);
    const before = api.getState();
    const [a, b] = before.productSets[0].productIds;
    api.setActiveProduct(b);
    const second = upload(api, 'new', [template('two', 'B', 'new B'), template('one', 'A', 'new A'), template('three', 'C', 'new C')]);
    const after = api.getState();
    assert.equal(first.productSetId, second.productSetId);
    assert.equal(after.productSets.length, 1);
    assert.deepEqual(Array.from(after.products.slice().sort((x, y) => x.order - y.order).slice(0, 2), p => p.id), [b, a]);
    assert.equal(after.workspace.activeProductId, b);
    assert.equal(after.productSets[0].source.fileSha256, 'new');
    assert.equal(after.products.find(p => p.id === a).attributes['Main Prompt'], 'new A');
    assert.equal(after.importRecords.length, 3, 'no duplicate import records for unchanged products');
    upload(api, 'new', [template('two', 'B', 'new B'), template('one', 'A', 'new A'), template('three', 'C', 'new C')]);
    assert.equal(api.getState().products.length, 3);
    assert.equal(api.getState().products.find(p => p.id === a).attributes['Main Prompt'], 'new A', 'row reorder remains stable on a second upload');
    upload(api, 'another', [template('one', 'A', 'other book')], 'another.xlsx');
    assert.equal(api.getState().productSets.length, 2, 'different workbooks remain isolated');
});

const helperSource = read('src/canvas/lib/canvas/excel-prompt-sync.ts').replace(/^import .*;\n/gm, '');
const context = vm.createContext({ exports: {},
    parseExcelPromptSpec: () => ({ tokens: ['[NAME]'], theme: 'new theme' }),
    resolvePromptVariables: (text, values = {}) => text.replace('[NAME]', values['[NAME]'] || '[NAME]'),
});
vm.runInContext(ts.transpileModule(helperSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
const sync = context.exports.syncExcelPromptNodes;
const promptContext = { templates: [template('one', 'A', 'new [NAME]')] };
function nodes(content = 'old [NAME]') {
    return [
        { id: 'parameters', type: 'guan:prompt-variables', metadata: { promptVariableValues: { '[NAME]': 'Kit' } } },
        { id: 'prompt', type: 'text', title: 'Main', position: { x: 20, y: 30 }, metadata: { excelPromptTemplateId: 'one', excelPromptKey: 'Main Prompt', excelPromptRaw: 'old [NAME]', content, excelPromptBindingNodeId: 'parameters' } },
        { id: 'final', type: 'text', metadata: { promptVariablePreviewOf: 'parameters', promptVariableSourceNodeId: 'prompt', content: 'old Kit' } },
        { id: 'result', type: 'image', metadata: { storageKey: 'cached-original', content: 'blob:original' } },
        { id: 'config', type: 'config', metadata: { size: '1152x1536' } },
    ];
}
test('reupload updates imported text and resolved final prompt in place, retaining parameters and outputs', () => {
    const before = nodes();
    const after = sync(before, promptContext, () => assert.fail('unchanged card needs no confirmation'));
    assert.equal(after[1].metadata.content, 'new [NAME]');
    assert.equal(after[2].metadata.content, 'new Kit');
    assert.equal(after[1].position, before[1].position);
    for (const index of [0, 3, 4]) assert.equal(after[index], before[index]);
    assert.equal(sync(after, promptContext, () => assert.fail('duplicate notification')), after);
});
test('manual edit requires confirmation; cancel persists per revision, accept replaces, hidden canvas defers', () => {
    const before = nodes('my manual prompt');
    let asks = 0;
    const kept = sync(before, promptContext, () => { asks++; return false; });
    assert.equal(kept[1].metadata.content, 'my manual prompt');
    assert.equal(sync(kept, promptContext, () => { asks++; return false; }), kept);
    assert.equal(asks, 1);
    assert.equal(sync(before, promptContext, () => undefined), before);
    assert.equal(sync(before, promptContext, () => true)[1].metadata.content, 'new [NAME]');
    const newer = { templates: [template('one', 'A', 'newest [NAME]')] };
    assert.equal(sync(kept, newer, () => true)[2].metadata.content, 'newest Kit');
});
test('removed columns and unrelated nodes are retained rather than erased', () => {
    const before = nodes();
    assert.equal(sync(before, { templates: [] }, () => true), before);
});

test('reupload notification does not run the import layout or recreate connections', () => {
    const page = read('src/canvas/pages/canvas/project.tsx');
    assert.doesNotMatch(page, /guan-excel-prompts-updated", handleExcelPromptsUpdated/);
    assert.match(page, /guan-excel-batch-imported", handleBatchImport/);
});

test('live Excel bridge listens to parent updates, isolates product workbooks and changes cache identity', () => {
    const api = contract();
    upload(api, 'first', [template('one', 'A', 'old')]);
    const productId = api.getState().products[0].id;
    const host = new EventTarget(); host.GuanWorkbenchData = api;
    const win = new EventTarget();
    win.parent = host; win.location = { search: '?workbenchProductId=' + productId, href: 'http://localhost/canvas/test' };
    win.fetch = async () => { throw Error('Excel source should not use network'); };
    const store = new Map();
    let event;
    win.addEventListener('guan-excel-prompts-updated', e => { event = e.detail; });
    const bridge = read('src/canvas/public/excel-prompts-bridge.js')
        .replace(/^  install(?:CanvasHeaderCleanup|FitAllButtonLabel|WorkbookMenuClickAway|PromptMenuEnhancement)\(\);$/gm, '');
    vm.runInNewContext(bridge, { window: win, CustomEvent, URLSearchParams, URL, Request, Response,
        localStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) } });
    const firstId = event.sources.at(-1).id;
    upload(api, 'changed', [template('one', 'A', 'new')]);
    host.dispatchEvent(new Event('guan-data-contract-change'));
    assert.equal(win.__guanExcelPromptItems[0].prompt, 'new');
    assert.notEqual(firstId, event.sources.at(-1).id);
    upload(api, 'other', [template('one', 'A', 'wrong workbook')], 'other.xlsx');
    host.dispatchEvent(new Event('guan-data-contract-change'));
    assert.equal(win.__guanExcelPromptItems[0].prompt, 'new');
});

test('same-name products keep their own full price/material route and never merge libraries', () => {
    const api = contract();
    const premium = template('premium', '可拆卸环形编织针套装 | 2,000-3,999₽ | 铝合金（详情明示）', 'premium alloy');
    const basic = template('basic', '可拆卸环形编织针套装 | 0-999₽ | 钢/不锈钢（详情明示）', 'basic steel');
    upload(api, 'first', [premium, basic]);
    const products = api.getState().products;
    const bridge = read('src/canvas/public/excel-prompts-bridge.js');
    const start = bridge.indexOf('  const readTemplates =');
    const end = bridge.indexOf('  const makeItems =', start);
    const readTemplates = search => vm.runInNewContext(
        'const clean = v => String(v ?? "").trim(); const productName = r => clean(r).split(/[|｜]/,1)[0].trim();' +
        bridge.slice(start, end) + 'readTemplates(state)',
        { state: api.getState(), window: { location: { search } }, URLSearchParams });
    for (const [index, prompt] of ['premium alloy', 'basic steel'].entries()) {
        const scoped = readTemplates('?workbenchProductId=' + products[index].id);
        assert.equal(scoped.templates.length, 1);
        assert.equal(scoped.templates[0].prompts['Main Prompt'], prompt);
    }
    upload(api, 'reordered', [basic, premium]);
    assert.equal(readTemplates('?workbenchProductId=' + products[0].id).templates[0].id, 'premium');
    assert.equal(readTemplates('?workbenchProductId=' + products[1].id).templates[0].id, 'basic');
});
