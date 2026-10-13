import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';

const source = readFileSync(new URL('../src/canvas/components/canvas/nodes/prompt-variables-node.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('prompt.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const resolver = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'resolvePromptVariables');
const context = vm.createContext({ VARIABLE_PATTERN: /\[[^\]\r\n]{1,160}\]/g });
vm.runInContext(ts.transpileModule(resolver.getText(ast).replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const resolve = (prompt, values) => { context.prompt = prompt; context.values = values; return vm.runInContext('resolvePromptVariables(prompt, values)', context); };

test('dimension cards prioritize verified measurements while retaining the original prompt', () => {
  const raw = 'COMPOSITION LOCK: scale / dimension visual\nDimensions: [DIMENSIONS]\nFeatures: [KEY SELLING POINTS]';
  const text = resolve(raw, { '[DIMENSIONS]': '800 x 500 mm', '[KEY SELLING POINTS]': '便携' });
  assert.ok(text.startsWith('COMPOSITION LOCK: scale / dimension visual\nDimensions: 800 x 500 mm\nFeatures: 便携'));
  assert.match(text, /不得替代尺寸信息/);
  assert.match(text, /已确认尺寸参数：[\s\S]*800 x 500 mm/);
});
test('missing dimensions remain unfilled and no measurements are invented', () => {
  const text = resolve('Theme: dimension display\n[DIMENSIONS]', {});
  assert.match(text, /\[DIMENSIONS\]/);
  assert.match(text, /未填写尺寸参数/);
});
test('case and separator variants bind the same variable without guessing unrelated fields', () => {
  assert.equal(resolve('Color [product-color]; size [SIZE]', { '[PRODUCT_COLOR]': '红色', '[SELLING POINTS]': '便携' }), 'Color 红色; size [SIZE]');
});
