import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';

// Exercise the production size resolver without loading stores or contacting paid APIs.
const source = readFileSync(new URL('../src/canvas/services/api/image.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('image.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(['parseRatioValue', 'parseImageRatio', 'parseImageDimensions', 'validateImageSize', 'resolveSize', 'ensureMinimumImagePixels', 'resolveRequestSize']);
const functions = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text)).map(statement => statement.getText(ast)).join('\n');
assert.equal(ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text)).length, names.size);
const context = vm.createContext({
    IMAGE_MIN_PIXELS: 655360,
    apiText: key => key,
    imageSizePresets: { '1k': {}, '2k': {}, '4k': {} },
    QUALITY_BASE: { low: 1024, medium: 2048, high: 2880 },
    DEFAULT_IMAGE_SHORT_SIDE: 1024,
});
vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);

test('legal sizes pass through unchanged', () => {
    for (const size of ['1152x1536', '912x1216', '1024x640']) {
        assert.equal(context.resolveRequestSize('low', size), size);
    }
});

test('requests always align both edges to 16 while preserving common aspect ratios', () => {
    assert.equal(context.resolveRequestSize('low', '900x1200'), '912x1216');
    assert.equal(context.resolveRequestSize('low', '1086x1448'), '1104x1472');
    assert.equal(context.resolveRequestSize('low', '1152x1536'), '1152x1536');
});

test('unsupported ratios fail clearly and auto remains unchanged', () => {
    assert.equal(context.parseImageRatio('8:1').width, 8);
    assert.throws(() => context.resolveRequestSize('low', '8:1'), /3:1/);
    for (const size of ['5008x5008', '8000x112', '3840x3840', '799x499']) assert.throws(() => context.resolveRequestSize('low', size));
    assert.equal(context.resolveRequestSize('low', 'auto'), undefined);
});

test('malformed, zero and unsafe dimensions are still rejected', () => {
    for (const size of ['0x500', '800x0', '-800x500', '800.5x500', '9007199254740992x500']) {
        assert.throws(() => context.resolveRequestSize('low', size));
    }
    assert.throws(() => context.parseImageRatio('0:1'));
});

test('small dimensions expand globally while preserving the exact ratio', () => {
    for (const baseUrl of [undefined, 'https://zzone.cc.cd', 'https://zzone.cc.cd/v1', 'https://api-cn.hi-code.cc', 'https://www.tixyw.com', 'https://api2.jojocode.com/v1']) {
        assert.equal(context.resolveRequestSize('low', '800x500', baseUrl), '1024x640');
        assert.equal(context.resolveRequestSize('low', '500x800', baseUrl), '640x1024');
        assert.equal(context.resolveRequestSize('low', '1024x640', baseUrl), '1024x640');
        assert.equal(context.resolveRequestSize('low', '1200x1200', baseUrl), '1200x1200');
        assert.equal(context.resolveRequestSize('low', 'auto', baseUrl), undefined);
        for (const [width, height] of [[300, 200], [900, 1200], [512, 512], [100, 300]]) {
            const result = context.resolveRequestSize('low', `${width}x${height}`, baseUrl).split('x').map(Number);
            assert.ok(result[0] * result[1] >= 655360);
            assert.equal(result[0] * height, result[1] * width);
            assert.ok(result[0] >= width && result[1] >= height);
            assert.equal(result[0] % 16, 0);
            assert.equal(result[1] % 16, 0);
        }
    }
});

test('all generation and edit paths share the minimum-size resolver', () => {
    assert.equal(source.match(/resolveRequestSize\(quality, config\.size\)/g)?.length, 4);
    assert.ok(source.includes('resolveRequestSize(normalizeQuality(config.quality, config.model), config.size)'));
    assert.equal(context.resolveRequestSize('low', '1x1'), '816x816');
});
