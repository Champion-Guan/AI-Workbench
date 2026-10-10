import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../src/canvas/node_modules/typescript/lib/typescript.js';

const source = readFileSync(new URL('../src/canvas/components/canvas/nodes/prompt-variables-node.tsx', import.meta.url), 'utf8');
const labels = source.slice(source.indexOf('const VARIABLE_LABELS:'), source.indexOf('function promptEntries('));
const compiled = ts.transpileModule(labels, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const label = token => vm.runInNewContext(compiled + '\nvariableLabel(token)', { token });

test('product variable headings use Chinese without changing original placeholder tokens', () => {
    const expected = {
        'USE SCENARIO': '使用场景', 'SURFACE FINISH': '表面处理', COLOR: '颜色',
        'KIT USE CASE': '套件用途', 'TOOL AND ACCESSORY LIST': '工具及配件清单',
        'KIT QUANTITY': '套件数量', 'CASE SIZE': '收纳盒尺寸', 'STORAGE FORMAT': '收纳方式',
        'ACCESSORIES AND QUANTITIES': '配件及数量', 'RUSSIAN SHORT HEADLINE': '俄文短标题',
        'PRODUCT NAME': '产品名称',
        'NEEDLE TYPE': '编织针类型', 'NEEDLE SIZE / DIAMETER': '针号/直径',
        'NEEDLE SIZE RANGE': '针号范围', 'CABLE OR NEEDLE LENGTH': '连接线或针身长度',
        'TIP MATERIAL': '针尖材质', 'SET CONTENTS AND QUANTITIES': '套装内容及数量',
        LENGTH: '长度', 'CONNECTION / CABLE': '连接方式/连接线', 'SET CONTENTS': '套装内容',
    };
    for (const [key, value] of Object.entries(expected)) assert.equal(label(`[${key}]`), value);
    assert.equal(label('[use   scenario]'), '使用场景');
    assert.equal(label('[自定义参数]'), '自定义参数');
    assert.equal(label('[UNKNOWN FIELD]'), '变量 [UNKNOWN FIELD]');
    assert.match(source, /placeholder=\{token\}/, 'inputs retain original English placeholders');
});

test('new workbook field variants and known compound headings resolve without guessing unknown terms', () => {
    const expected = {
        product_name: '产品名称', productName: '产品名称', 'PRODUCT-NAME': '产品名称',
        'needle size/diameter': '针号/直径', 'SET_CONTENTS & QUANTITIES': '套装内容及数量',
        'PRODUCT WEIGHT': '产品重量', 'PACKAGE WIDTH (mm)': '包装宽度 MM',
        'COMPATIBLE DEVICE MODELS': '兼容设备型号', 'CORE FEATURE 12': '核心卖点 12',
        'BATTERY CAPACITY MAH': '电池容量 MAH', 'MY PRODUCT COLOR': '我的产品颜色',
        'POWER SUPPLY': '供电方式', 'NET WEIGHT': '净重', 'WATERPROOF RATING': '防水等级',
        'CARE INSTRUCTIONS': '保养说明', 'TARGET AUDIENCE': '适用人群',
        'PRODUCT UNKNOWN TECHNOLOGY': '变量 [PRODUCT UNKNOWN TECHNOLOGY]',
        'CUSTOMER INTERNAL CODE': '变量 [CUSTOMER INTERNAL CODE]',
    };
    for (const [key, value] of Object.entries(expected)) assert.equal(label(`[${key}]`), value, key);
});
