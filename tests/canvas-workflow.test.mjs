import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasTaskSummary, failedTaskTargets } from '../src/canvas/lib/canvas/task-summary.js';
import { dimensionsFromAnchor } from '../src/canvas/lib/ratio-dimensions.js';
const task=(id,status,started=1)=>({id,type:'image',metadata:{status,generationStartedAt:started}});
test('capsule aggregates running before errors before all successful, irrespective of start order',()=>{
    assert.equal(canvasTaskSummary([task('a','loading'),task('b','success',2)]).status,'loading');
    assert.equal(canvasTaskSummary([task('a','error'),task('b','loading',2)]).status,'loading');
    assert.equal(canvasTaskSummary([task('a','error'),task('b','success',2)]).status,'error');
    assert.equal(canvasTaskSummary([task('a','success'),task('b','success',2)]).status,'success');
    assert.equal(canvasTaskSummary([{id:'empty',type:'config',metadata:{status:'idle'}}]).status,'idle');
    assert.equal(canvasTaskSummary([]).status,'idle');
    const config={id:'config',type:'config',metadata:{status:'error',generationStartedAt:1}};
    assert.deepEqual(failedTaskTargets([config,task('output','error')],[{fromNodeId:'config',toNodeId:'output'}]).map(t=>t.node.id),['output']);
    assert.equal(canvasTaskSummary([config,task('output','success')],[{fromNodeId:'config',toNodeId:'output'}]).status,'success');
    config.metadata.generationStartedAt=2;
    assert.equal(canvasTaskSummary([config,task('output','success')],[{fromNodeId:'config',toNodeId:'output'}]).status,'error');
});
test('batch failed slots remain errors even if primary image is successful; retry excludes success/loading',()=>{
    const batch=task('batch','success');batch.metadata.images=[{id:'ok',status:'success'},{id:'bad1',status:'error'},{id:'bad2',status:'error'}];
    assert.equal(canvasTaskSummary([batch]).status,'error');
    assert.deepEqual(failedTaskTargets([batch,task('busy','loading'),task('done','success'),task('bad','error')]).map(t=>[t.node.id,t.imageId]),[['batch','bad1'],['batch','bad2'],['bad',undefined]]);
    batch.metadata.images.push({id:'busy',status:'loading'});
    assert.equal(canvasTaskSummary([batch]).status,'loading');
});
test('ratio selection preserves last edited dimension and computes the opposite dimension',()=>{
    assert.deepEqual(dimensionsFromAnchor('width',900,'3:4'),{width:900,height:1200});
    assert.deepEqual(dimensionsFromAnchor('height',1200,'3:4'),{width:900,height:1200});
    assert.deepEqual(dimensionsFromAnchor('width',800,'8:5'),{width:800,height:500});
    assert.deepEqual(dimensionsFromAnchor('height',500,'8:5'),{width:800,height:500});
    assert.deepEqual(dimensionsFromAnchor('width',900,'3:4',true),{width:912,height:1216});
    assert.equal(dimensionsFromAnchor('width',900,'auto'),null);
});
