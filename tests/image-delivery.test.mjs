import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';
import { parseDeliverySize, deliveryAction, resizeDeliveryBlob } from '../src/canvas/lib/image-delivery.js';

test('customer delivery size keeps non-16 dimensions; ratios/auto are not pixel targets', () => {
    for (const value of ['900x1200', '900 × 1200', '900 X 1200']) assert.deepEqual(parseDeliverySize(value), {width:900,height:1200});
    for (const value of ['auto', '3:4', '', '0x10']) assert.equal(parseDeliverySize(value), undefined);
    assert.throws(() => parseDeliverySize('50000x50000'));
    assert.equal(deliveryAction(1086,1448,parseDeliverySize('900x1200')), 'resize');
    assert.deepEqual(parseDeliverySize('800 x 500'), {width:800,height:500});
    assert.equal(deliveryAction(1024,640,parseDeliverySize('800x500')), 'resize');
    assert.equal(deliveryAction(1280,800,parseDeliverySize('800x500')), 'resize');
    assert.equal(deliveryAction(900,1200,parseDeliverySize('900x1200')), 'original');
    assert.equal(deliveryAction(1024,1024,parseDeliverySize('900x1200')), 'ratio-mismatch');
    assert.equal(deliveryAction(1093,1439,parseDeliverySize('900x1200')), 'ratio-mismatch');
});

const source = readFileSync(new URL('../src/canvas/services/image-storage.ts',import.meta.url),'utf8');
const ast = ts.createSourceFile('storage.ts',source,ts.ScriptTarget.Latest,true);
const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && ['uploadGeneratedImage', 'uploadGeneratedImageImpl'].includes(n.name?.text));
const activitySource = readFileSync(new URL('../src/canvas/lib/update-activity.ts', import.meta.url), 'utf8').replace(/export /g, '');
function fixture(w=1086,h=1448,failResize=false) {
    const originals = new Map(); let writes=0;
    const context = vm.createContext({parseDeliverySize,deliveryAction,resizeDeliveryBlob: async () => { assert.equal(context.activity.snapshot().storage, 1, 'resizing stays inside the delivery operation'); if(failResize) throw Error('encode failed'); return new Blob(['delivery'],{type:'image/png'}); },
        getImageBlob: async key => originals.get(key),
        uploadImage: async (input,options) => {
            assert.equal(options.requireLocalCache,true);
            const key = `image:${++writes}`;
            const blob = input instanceof Blob ? input : new Blob(['original']); originals.set(key,blob);
            return {storageKey:key,url:`blob:${writes}`,width:writes===1?w:900,height:writes===1?h:1200,bytes:blob.size,mimeType:blob.type};
        }, Error});
    const body = activitySource + '\nglobalThis.activity = frontendActivity;\n' + functions.map(fn => fn.getText(ast).replace('export ', '')).join('\n');
    vm.runInContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
    return {context,originals};
}
test('success persists original before delivery; default storage key points at delivery',async()=>{
    const f=fixture(); const r=await f.context.uploadGeneratedImage('https://upstream/image',{targetSize:'900x1200'});
    assert.equal(r.width,900);assert.equal(r.height,1200);assert.equal(r.storageKey,'image:2');
    assert.equal(r.originalImage.storageKey,'image:1');assert.equal(r.originalImage.width,1086);
    assert.equal(await f.originals.get('image:1').text(),'original');
    assert.equal(await f.originals.get(r.storageKey).text(),'delivery');
    assert.equal(f.context.activity.snapshot().storage, 0);
});
test('mismatch stays original with an explicit note; encoding failure preserves original',async()=>{
    const f=fixture(1024,1024); const r=await f.context.uploadGeneratedImage('input',{targetSize:'900x1200'});
    assert.equal(r.storageKey,'image:1');assert.match(r.deliveryNote,/比例/);assert.equal(f.originals.size,1);
    const bad=fixture(1086,1448,true);await assert.rejects(bad.context.uploadGeneratedImage('input',{targetSize:'900x1200'}),/encode failed/);
    assert.equal(bad.originals.size,1);
    assert.equal(bad.context.activity.snapshot().storage, 0);
});

test('PNG resizing uses high quality and releases bitmap even on errors',async()=>{
    let closed=false, drawn;
    globalThis.createImageBitmap=async()=>({close(){closed=true;}});
    globalThis.document={createElement:()=>({getContext:()=>({set imageSmoothingEnabled(v){},set imageSmoothingQuality(v){assert.equal(v,'high');},drawImage(...args){drawn=args.slice(1);}}),toBlob(fn,type){assert.equal(type,'image/png');fn(new Blob(['PNG'],{type}));}})};
    try {const blob=await resizeDeliveryBlob(new Blob(['input']),{width:900,height:1200});assert.equal(blob.type,'image/png');assert.deepEqual(drawn,[0,0,900,1200]);assert.equal(closed,true);}
    finally {delete globalThis.createImageBitmap;delete globalThis.document;}
});
