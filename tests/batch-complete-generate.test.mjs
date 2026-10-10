import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "../src/canvas/node_modules/typescript/lib/typescript.js";
import { createActivityFixture } from "./helpers/frontend-activity.mjs";

const page = readFileSync(new URL("../src/canvas/pages/canvas/project.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("project.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "completeAndGenerateAll") callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
};
visit(ast);
function handler(add, generate, errors = []) {
    const context = vm.createContext({
        ...createActivityFixture(),
        completeAndGenerateRunning: { current: false },
        addGenerationConfigsForPromptNodes: add, generateAllConfigNodes: generate,
        message: { error: text => errors.push(text) },
    });
    vm.runInContext(ts.transpileModule(`const run = ${callback.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return () => vm.runInContext("run()", context);
}
test("combined action completes cards before generating, including existing and newly added cards", async () => {
    const cards = ["existing"], executed = [], order = [];
    const run = handler(() => { order.push("complete"); cards.push("new"); }, async () => { order.push("generate"); executed.push(...cards); });
    await run();
    assert.deepEqual(order, ["complete", "generate"]);
    assert.deepEqual(executed, ["existing", "new"]);
});
test("combined action does not duplicate an in-flight batch and unlocks after completion", async () => {
    let resolve, batches = 0;
    const pending = new Promise(done => { resolve = done; });
    const run = handler(() => { batches++; }, () => pending);
    const first = run();
    await run();
    assert.equal(batches, 1);
    resolve();
    await first;
    await run();
    assert.equal(batches, 2);
});
test("failure stops the combined flow and releases the guard for retry", async () => {
    const errors = [];
    let attempts = 0, generated = 0;
    const run = handler(() => { if (++attempts === 1) throw Error("completion failed"); }, async () => { generated++; }, errors);
    await run();
    assert.equal(generated, 0);
    assert.equal(errors.length, 1);
    await run();
    assert.equal(generated, 1);
});
test("batch menu keeps both original actions and adds the combined action", () => {
    const toolbar = readFileSync(new URL("../src/canvas/components/canvas/canvas-toolbar.tsx", import.meta.url), "utf8");
    assert.match(toolbar, /key: "auto-config".*onClick: onAddGenerationConfigs/);
    assert.match(toolbar, /key: "generate-all".*onClick: onGenerateAllConfigs/);
    assert.match(toolbar, /key: "complete-and-generate".*onClick: onCompleteAndGenerateAll/);
    assert.match(page, /onCompleteAndGenerateAll=\{\(\) => void completeAndGenerateAll\(\)\}/);
});
