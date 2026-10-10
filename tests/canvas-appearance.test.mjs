import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "../src/canvas/node_modules/typescript/lib/typescript.js";

const store = readFileSync(new URL("../src/canvas/stores/canvas/use-canvas-store.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("store.ts", store, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = ast.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "withCanvasAppearanceDefaults");
const context = vm.createContext({});
vm.runInContext(ts.transpileModule(fn.getText(ast).replace("export ", ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);

test("legacy canvases enable image info once without modifying canvas data", () => {
    const project = { showImageInfo: false, nodes: [], title: "existing" };
    const next = context.withCanvasAppearanceDefaults(project);
    assert.equal(next.showImageInfo, true);
    assert.equal(next.imageInfoDefaultVersion, 1);
    assert.equal(next.nodes, project.nodes);
    assert.equal(project.showImageInfo, false);
});
test("after migration a user's explicit image info choice is preserved", () => {
    const project = { showImageInfo: false, imageInfoDefaultVersion: 1 };
    assert.equal(context.withCanvasAppearanceDefaults(project), project);
});
test("theme cleanup protects appearance controls while hiding header duplicates", () => {
    const bridge = readFileSync(new URL("../src/canvas/public/excel-prompts-bridge.js", import.meta.url), "utf8");
    const toolbar = readFileSync(new URL("../src/canvas/components/canvas/canvas-toolbar.tsx", import.meta.url), "utf8");
    assert.match(toolbar, /data-canvas-appearance-theme="true"/);
    assert.match(bridge, /if \(element.hasAttribute\("data-canvas-appearance-theme"\)\)/);
    assert.match(bridge, /label === "切换到浅色主题"/);
});
