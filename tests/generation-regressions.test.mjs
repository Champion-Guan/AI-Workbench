import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { createActivityFixture } from './helpers/frontend-activity.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function callback(path, name, bindings) {
    const source = read(path);
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let result;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) {
            result = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
        }
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(result, name);
    const context = vm.createContext({ ...createActivityFixture(), ...bindings });
    vm.runInContext(ts.transpileModule(`const run = ${result.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return (...args) => { context.__testArgs = args; return vm.runInContext('run(...__testArgs)', context); };
}

test('all batch cards run with at most 3 concurrent requests, surviving one rejection', async () => {
    const nodes = Array.from({ length: 8 }, (_, id) => ({ id, type: 'config', metadata: {} }));
    const started = [], gates = [];
    let active = 0, maximum = 0;
    const run = callback('src/canvas/pages/canvas/project.tsx', 'generateAllConfigNodes', {
        nodesRef: { current: nodes }, CanvasNodeType: { Config: 'config' }, NODE_STATUS_LOADING: 'loading',
        batchGenerationRunning: { current: false }, message: { info() {}, warning() {} },
        handleGenerateNode: async id => {
            started.push(id); maximum = Math.max(maximum, ++active);
            await new Promise(resolve => gates.push(resolve));
            active--;
            if (id === 0) throw Error('missing reference');
        },
    });
    const first = run();
    assert.equal(started.length, 3);
    await run();
    assert.equal(started.length, 3, 'duplicate clicks do not create another batch');
    while (gates.length) { gates.shift()(); await new Promise(resolve => setImmediate(resolve)); }
    await first;
    assert.equal(maximum, 3);
    assert.deepEqual(started.sort(), nodes.map(node => node.id));
});

test('ZIP download uses original IndexedDB blobs even when saved object URLs have expired', async () => {
    const original = new Blob(['original-image'], { type: 'image/png' });
    const history = [{ type: 'image', title: '主图-1', metadata: { status: 'success', content: 'blob:expired', storageKey: 'original' } }];
    const filesToDownload = [{ node: history[0], content: 'blob:expired', storageKey: 'original', name: '主图-1' }];
    let downloaded, fileNames;
    const run = callback('src/canvas/components/canvas/canvas-side-panel.tsx', 'downloadAll', {
        downloadGuard: { current: false },
        filesToDownload,
        displayedHistory: history,
        setDownloading() {}, CanvasNodeType: { Video: 'video' }, Blob, Uint8Array,
        readDownloadBlob: async media => { assert.equal(media.storageKey, 'original'); assert.equal(media.kind, 'image'); return original; },
        fetch: () => { throw Error('must not fetch an expired URL'); },
        withLocalProxy: value => value,
        message: { info() {}, error: value => assert.fail(value) },
        zipSync: files => { fileNames = Object.keys(files); assert.equal(new TextDecoder().decode(files[fileNames[0]]), 'original-image'); return new Uint8Array([1]); },
        saveAs: (blob, name) => { downloaded = name; assert.equal(blob.type, 'application/zip'); },
    });
    await run(filesToDownload);
    assert.deepEqual(fileNames, ['主图-1.png']);
    assert.equal(downloaded, '生成历史.zip');
});

test('settings bridge anchors to settings host instead of the first unrelated modal', () => {
    const source = read('src/server/index.mjs');
    const install = source.slice(source.indexOf('    const install = () => {', source.indexOf('const localCanvasSettingsBridgeScript')));
    assert.match(install, /document.querySelector\("\[data-guan-fallback-host\]"\)/);
    assert.match(install, /fallbackHost\?\.closest\("\[role=dialog\]"\)/);
    assert.match(install, /if \(!fallbackHost.contains\(fallbackPanel\)\)/);
    assert.match(install, /if \(pane instanceof HTMLElement && !pane.contains\(networkPanel\)\)/);
});

test('details distinguish actual dimensions from request and manual sizes preserve customer input', () => {
    const source = read('src/canvas/pages/canvas/project.tsx');
    assert.match(source, /previewImage\?\.naturalWidth \|\| previewMetadata\?\.naturalWidth/);
    assert.match(source, /title="请求尺寸：客户设置的目标图片尺寸">\{previewRequestedSize/);
    assert.match(source, /API 实际响应值：上游返回原图的真实尺寸/);
    assert.match(source, /\["最终图片尺寸", previewSize\]/);
    assert.match(read('src/canvas/components/image-settings-panel.tsx'), /\[snapDimensionToStep, setSnapDimensionToStep\] = useState\(false\)/);
    assert.doesNotMatch(read('src/canvas/components/image-settings-panel.tsx'), /checked=\{snapDimensionToStep\} disabled/);
});
