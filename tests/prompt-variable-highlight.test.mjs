import test from 'node:test';
import assert from 'node:assert/strict';
import { promptHighlightSegments as split } from '../src/canvas/lib/canvas/prompt-variable-highlight.js';

test('source variables retain exact text, whitespace and repeated tokens',()=>{
    const content='Hello [PRODUCT NAME]\n[NEEDLE SIZE / DIAMETER] [PRODUCT NAME] <script>x</script>';
    const parts=split(content);
    assert.equal(parts.map(p=>p.text).join(''),content);
    assert.deepEqual(parts.filter(p=>p.token).map(p=>p.token),['[PRODUCT NAME]','[NEEDLE SIZE / DIAMETER]','[PRODUCT NAME]']);
    assert.equal(split('plain text').some(p=>p.token),false);
});
test('final variables highlight replacements only at original token positions',()=>{
    const raw='Kit: [PRODUCT NAME]. Kit: ordinary. [COLOR]';
    const parts=split('Kit: Kit. Kit: ordinary. [COLOR]',raw,{'[PRODUCT NAME]':' Kit '});
    assert.deepEqual(parts.filter(p=>p.token),[{text:'Kit',token:'[PRODUCT NAME]'},{text:'[COLOR]',token:'[COLOR]'}]);
    assert.equal(parts.map(p=>p.text).join(''),'Kit: Kit. Kit: ordinary. [COLOR]');
});
test('manual final edits and missing sources are never replaced or guessed',()=>{
    const text='Manual Kit [COLOR]';
    const parts=split(text,'[PRODUCT NAME] [COLOR]',{'[PRODUCT NAME]':'Kit'});
    assert.equal(parts.map(p=>p.text).join(''),text);
    assert.deepEqual(parts.filter(p=>p.token),[{text:'[COLOR]',token:'[COLOR]'}]);
    assert.deepEqual(split(''),[]);
});
