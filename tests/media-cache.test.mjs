import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function load(path, bindings) {
    const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
    const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/export /g, '');
    const context = vm.createContext({ Blob, AbortSignal, TextEncoder, Uint8Array, crypto: webcrypto, ...bindings });
    vm.runInContext(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context;
}
function fixture() {
    const images = new Map(), media = new Map();
    let fetches = 0;
    const context = load('src/canvas/services/media-download.ts', {
        getImageBlob: async key => images.get(key), getMediaBlob: async key => media.get(key),
        setImageBlob: async (key, blob) => images.set(key, blob), setMediaBlob: async (key, blob) => media.set(key, blob),
        withLocalProxy: url => url,
        fetch: async () => { fetches++; return { ok: true, blob: async () => new Blob(['original'], { type: 'image/png' }) }; },
    });
    return { context, images, media, fetches: () => fetches };
}

test('all media download types read persisted originals with no network even for expired URLs', async () => {
    const f = fixture();
    for (const kind of ['image', 'video', 'audio']) {
        const blob = new Blob([kind]);
        (kind === 'image' ? f.images : f.media).set(kind + ':original', blob);
        assert.equal(await f.context.readDownloadBlob({ kind, storageKey: kind + ':original', url: 'blob:expired' }), blob);
    }
    assert.equal(f.fetches(), 0);
});

test('legacy downloads refill original storage and deduplicate concurrent fetches', async () => {
    const f = fixture();
    const item = { kind: 'video', storageKey: 'video:missing', url: 'https://example.invalid/original.mp4' };
    const [a, b] = await Promise.all([f.context.readDownloadBlob(item), f.context.readDownloadBlob(item)]);
    assert.equal(a, b);
    assert.equal(f.fetches(), 1);
    f.context.fetch = () => { throw Error('offline'); };
    assert.equal(await f.context.readDownloadBlob(item), a);
});

test('legacy records without keys reuse a persistent URL-hash cache', async () => {
    const f = fixture();
    const item = { kind: 'image', url: 'https://example.invalid/old.png' };
    await f.context.readDownloadBlob(item);
    f.context.fetch = () => { throw Error('offline'); };
    await f.context.readDownloadBlob(item);
    assert.equal(f.fetches(), 1);
    assert.equal(f.images.size, 1);
});

test('HTTP errors and HTML error bodies are never cached as successful media', async () => {
    const f = fixture();
    f.context.fetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(f.context.readDownloadBlob({ kind: 'video', storageKey: 'video:bad', url: 'https://example.invalid/video' }), /403/);
    f.context.fetch = async () => ({ ok: true, blob: async () => new Blob(['error'], { type: 'text/html' }) });
    await assert.rejects(f.context.readDownloadBlob({ kind: 'video', storageKey: 'video:bad', url: 'https://example.invalid/video' }), /媒体文件/);
    assert.equal(f.media.size, 0);
});

test('generated video cache failures propagate instead of returning an uncached success URL', async () => {
    const source = read('src/canvas/services/api/video.ts');
    const ast = ts.createSourceFile('video.ts', source, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'storeGeneratedVideo');
    const context = vm.createContext({ uploadMediaFile: async () => { throw Error('disk full'); }, apiText: key => key });
    vm.runInContext(ts.transpileModule(fn.getText(ast).replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    await assert.rejects(context.storeGeneratedVideo({ url: 'https://example.invalid/video.mp4' }), /disk full/);
});

test('generated images require local persistence and thumbnails do not delay original readiness', () => {
    const source = read('src/canvas/services/image-storage.ts');
    assert.match(source, /await uploadImage\(input, \{ \.\.\.options, requireLocalCache: true \}\)/);
    assert.match(source, /if \(options\?\.requireLocalCache \|\|/);
    const storeImage = source.slice(source.indexOf('async function storeImage('), source.indexOf('async function fetchImageBlob('));
    assert.match(storeImage, /await store.setItem\(storageKey, blob\)/);
    assert.ok(storeImage.indexOf('await store.setItem') < storeImage.indexOf('await loadImageMeta'));
    assert.match(storeImage, /queueImagePreview\(storageKey\)/);
    assert.doesNotMatch(storeImage, /await storeImagePreview/);
});
