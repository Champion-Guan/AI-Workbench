import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "../src/canvas/node_modules/typescript/lib/typescript.js";

const source = readFileSync(new URL("../src/canvas/lib/canvas/prompt-generation-mode.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const context = vm.createContext({ exports: {} });
vm.runInContext(js, context);
const infer = context.exports.promptGenerationMode;
const node = (id, title, metadata = {}) => ({ id, type: "text", title, metadata });
test("prompt labels distinguish output type without inspecting incidental prose", () => {
    for (const [label, expected] of [["视频提示词", "video"], ["详情页提示词01", "image"], ["主图提示词", "image"], ["富内容提示词06", "image"], ["音频提示词", "audio"], ["文本提示词", "text"]]) {
        const n = node("a", label, { content: "video and audio reference" });
        assert.equal(infer(n, [n], []), expected);
    }
    const n = node("a", "文本", { content: "create video" });
    assert.equal(infer(n, [n], []), undefined);
});
test("final prompts follow provenance and text edges, with cycle safety", () => {
    const original = node("original", "产品 · 视频提示词");
    const final = node("final", "最终生图提示词", { promptVariableSourceNodeId: original.id });
    assert.equal(infer(final, [original, final], []), "video");
    const generic = node("generic", "最终生成提示图");
    assert.equal(infer(generic, [original, generic], [{ fromNodeId: original.id, toNodeId: generic.id }]), "video");
    assert.equal(infer(generic, [generic], [{ fromNodeId: generic.id, toNodeId: generic.id }]), undefined);
    assert.equal(infer(final, [final], []), undefined, "deleted sources are safe");
});
test("manual connection, drag-create and batch completion all infer modes", () => {
    const page = readFileSync(new URL("../src/canvas/pages/canvas/project.tsx", import.meta.url), "utf8");
    assert.match(page, /promptGenerationMode\(promptNode, nextNodes, connectionsRef.current\)/);
    assert.match(page, /promptGenerationMode\(source, nodesRef.current, connectionsRef.current\)/);
    assert.match(page, /promptGenerationMode\(sourceNode, nodesRef.current, connectionsRef.current\)/);
});
