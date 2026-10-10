import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "../src/canvas/node_modules/typescript/lib/typescript.js";

const source = readFileSync(new URL("../src/canvas/stores/canvas/use-canvas-store.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("store.ts", source, ts.ScriptTarget.Latest, true);
function storeMethod(name) {
    let match;
    const visit = node => {
        if (ts.isPropertyAssignment(node) && node.name.getText(ast) === name && ts.isArrowFunction(node.initializer)) match = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    return ts.transpileModule(`const method = ${match.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
test("new canvas stores seeded nodes once; reopening and deleting do not reseed", () => {
    let state = { projects: [] };
    const context = vm.createContext({
        nanoid: () => "test-product", i18n: { t: () => "untitled" }, initialViewport: { x: 0, y: 0, k: 1 },
        set: updater => { state = { ...state, ...updater(state) }; }, get: () => state,
    });
    const invoke = (name, args) => {
        context.args = args;
        return vm.runInContext(`{ ${storeMethod(name)} method(...args); }`, context);
    };
    const node = { id: "parameters", type: "guan:prompt-variables", metadata: { promptVariableValues: {} } };
    const id = invoke("createProject", ["产品A", [node]]);
    assert.equal(invoke("openProject", [id]).nodes[0], node);
    assert.equal(invoke("openProject", [id]).nodes.length, 1);
    invoke("updateProject", [id, { nodes: [] }]);
    assert.equal(invoke("openProject", [id]).nodes.length, 0);
});
test("product deep-link seeds parameters only on creation; toolbar parameters precede text", () => {
    const page = readFileSync(new URL("../src/canvas/pages/canvas/project.tsx", import.meta.url), "utf8");
    assert.match(page, /const initialNodes = productTitle \|\| workbenchProductId/);
    assert.match(page, /createProject\(productTitle \|\| "未命名产品", initialNodes\)/);
    const toolbar = readFileSync(new URL("../src/canvas/components/canvas/canvas-toolbar.tsx", import.meta.url), "utf8");
    assert.equal(toolbar.match(/id="tool-prompt-variables"/g).length, 1);
    assert.ok(toolbar.indexOf('id="tool-prompt-variables"') < toolbar.indexOf('id="tool-text"'));
    assert.match(toolbar, /id="tool-batch-actions"/);
    assert.doesNotMatch(toolbar, /id="tool-auto-config"|id="tool-generate-all"/);
    assert.match(toolbar, /key: "auto-config".*onClick: onAddGenerationConfigs/);
    assert.match(toolbar, /key: "generate-all".*onClick: onGenerateAllConfigs/);
});
