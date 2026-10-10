import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "../src/canvas/node_modules/typescript/lib/typescript.js";

const source = readFileSync(new URL("../src/canvas/components/canvas/canvas-toolbar.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("toolbar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handlePointerDown") handler = node.initializer;
    ts.forEachChild(node, visit);
};
visit(ast);
function press(target) {
    const closed = [];
    const context = vm.createContext({ target,
        rootRef: { current: { contains: value => value === "toolbar" } },
        batchMenuRef: { current: { contains: value => value === "menu" } },
        setBatchOpen: open => closed.push(["batch", open]),
        setAppearanceOpen: open => closed.push(["appearance", open]),
        setExtensionsOpen: open => closed.push(["extensions", open]),
    });
    vm.runInContext(ts.transpileModule(`const handle = ${handler.getText(ast)}; handle({target});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return closed;
}
test("canvas pointerdown dismisses the batch menu before dragging begins", () => {
    assert.ok(press("canvas").some(([name, open]) => name === "batch" && open === false));
    assert.match(source, /addEventListener\("pointerdown", handlePointerDown, true\)/);
    assert.match(source, /removeEventListener\("pointerdown", handlePointerDown, true\)/);
});
test("portalled menu and toolbar pointerdown preserve menu actions", () => {
    assert.deepEqual(press("menu"), []);
    assert.deepEqual(press("toolbar"), []);
    assert.match(source, /open=\{batchOpen\}/);
    assert.match(source, /onClick: \(\) => setBatchOpen\(false\)/);
});
