import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { localizePromptTheme } from '../src/canvas/lib/canvas/prompt-theme-labels.js';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const bridge = read('src/canvas/public/excel-prompts-bridge.js');
const bridgeFunction = bridge.slice(bridge.indexOf('  const localizeTheme ='), bridge.indexOf('  const promptTokens ='));
const bridgeLabel = value => vm.runInNewContext(bridgeFunction + 'localizeTheme(value)', { value });

test('library and canvas translate screenshot themes and new theme variants consistently', () => {
    const expected = {
        'installation/assembly sequence': '安装与组装流程',
        'checklist / use boundary': '使用清单与适用边界',
        'selection-guide narrative': '选购指南',
        'technical macro narrative': '技术细节微距展示',
        'assembly / structural proof': '组装与结构验证',
        'hands-in-use narrative': '手部使用演示',
        'checklist / care-storage': '清单与保养收纳',
        'compatibility/selection guide': '兼容性与选购指南',
        'MACRO MATERIAL / FINISH': '材质与表面细节',
        'scale / dimension visual': '尺寸规格展示',
        'care/storage': '保养与收纳',
        'topView': '俯视图',
        'material + texture detail': '材质与纹理细节',
        'exploded view': '拆解展示',
        'front view': '正面图',
        'UNKNOWN CUSTOM THEME': 'UNKNOWN CUSTOM THEME',
        '自定义中文主题': '自定义中文主题',
    };
    for (const [input, output] of Object.entries(expected)) {
        assert.equal(localizePromptTheme(input), output, input);
        assert.equal(bridgeLabel(input), output, 'bridge: ' + input);
    }
    // Prevent drift between the standalone bridge and bundled canvas.
    const module = read('src/canvas/lib/canvas/prompt-theme-labels.js');
    assert.equal(module.slice(module.indexOf('    const theme'), module.lastIndexOf('\n}')).trim(), bridgeFunction.slice(bridgeFunction.indexOf('    const theme'), bridgeFunction.lastIndexOf('\n  };')).trim());
});

test('new imports and stored card headings localize presentation, not prompt bodies', () => {
    const parser = read('src/canvas/components/canvas/nodes/prompt-variables-node.tsx');
    const renderer = read('src/canvas/components/canvas/canvas-node.tsx');
    assert.match(parser, /const theme = localizePromptTheme\(explicitTheme/);
    assert.match(renderer, /localizePromptTheme\(node.metadata.excelPromptTheme\)/);
    assert.match(parser, /prompt: text, tokens:/);
});
