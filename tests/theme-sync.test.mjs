import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "../src/canvas/node_modules/typescript/lib/typescript.js";

const server = readFileSync(new URL("../src/server/index.mjs", import.meta.url), "utf8");
const script = server.match(/const localThemeToggleScript = `<script[^>]*>([\s\S]*?)<\/script>`;/)[1];
function shell(animated = false) {
    const listeners = {}, values = new Map(), sent = [], order = [], animations = [];
    const frameWindow = { postMessage: (data, origin) => sent.push({ data, origin }),
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        dispatchEvent: event => order.push([event.type, event.detail.theme]),
    };
    const frame = { contentWindow: frameWindow, addEventListener() {} };
    const button = { innerHTML: "", setAttribute() {} };
    const html = { dataset: {}, classList: { toggle() {} }, animate: (...args) => animations.push(args) };
    const document = {
        documentElement: html, body: { classList: { toggle() {} } },
        querySelector: selector => selector === ".local-workbench-theme-button" ? button : null,
        querySelectorAll: () => [frame],
        head: { append() {} }, createElement: () => ({ remove() {} }),
    };
    if (animated) document.startViewTransition = apply => {
        order.push("snapshot-old"); apply(); order.push("snapshot-new");
        return { ready: Promise.resolve(), finished: Promise.resolve() };
    };
    const window = { innerWidth: 1200, innerHeight: 900, addEventListener: (type, handler) => { listeners[type] = handler; } };
    const context = vm.createContext({ document, location: { origin: "http://localhost:5174" },
        localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
        window,
        MutationObserver: class { observe() {} },
    });
    vm.runInContext(script, context);
    const send = (theme, overrides = {}) => listeners.message({ origin: "http://localhost:5174", source: frameWindow, data: { type: "guan-theme-change", theme }, ...overrides });
    return { html, values, sent, send, window, order, animations };
}
test("one shell reveal commits canvas before snapshot with the clicked global origin", async () => {
    const s = shell(true);
    s.order.length = 0;
    s.window.__guanAnimateTheme("dark", { getBoundingClientRect: () => ({ left: 800, top: 700, width: 0, height: 0 }) });
    await Promise.resolve();
    assert.deepEqual(s.order, ["snapshot-old", ["guan-theme-apply", "dark"], "snapshot-new"]);
    assert.equal(s.animations.length, 1);
    assert.equal(s.animations[0][0].clipPath[0], "circle(0px at 800px 700px)");
    assert.equal(s.animations[0][1].duration, 400);
    s.window.__guanAnimateTheme("dark");
    assert.equal(s.animations.length, 1, "active theme must not animate again");
});
test("embedded toggler delegates before starting a local transition; provider flushes synchronously", () => {
    const toggler = readFileSync(new URL("../src/canvas/components/ui/animated-theme-toggler.tsx", import.meta.url), "utf8");
    assert.ok(toggler.indexOf("parent.__guanAnimateTheme(nextTheme") < toggler.indexOf("document.startViewTransition"));
    assert.match(toggler, /parent\.location\.origin === window\.location\.origin/);
    assert.match(toggler, /rect\.left \+ x \* scaleX/);
    const provider = readFileSync(new URL("../src/canvas/components/layout/app-providers.tsx", import.meta.url), "utf8");
    assert.match(provider, /flushSync\(\(\) => setTheme\(nextTheme\)\)/);
    assert.match(provider, /removeEventListener\("guan-theme-apply", handleThemeApply\)/);
});
test("canvas theme updates shell persistence and sibling canvases without feedback", () => {
    const s = shell();
    s.send("dark");
    assert.equal(s.html.dataset.workbenchTheme, "dark");
    assert.equal(s.values.get("guan-workbench-theme"), "dark");
    assert.equal(JSON.parse(s.values.get("infinite-canvas:theme_store")).state.theme, "dark");
    assert.equal(s.sent.at(-1).origin, "http://localhost:5174");
    const count = s.sent.length;
    s.send("dark");
    assert.equal(s.sent.length, count, "same-theme echoes must not broadcast again");
    s.send("light");
    assert.equal(s.html.dataset.workbenchTheme, "light");
});
test("shell rejects invalid theme, foreign origin and non-canvas message sources", () => {
    const s = shell();
    s.send("dark", { origin: "https://untrusted.example" });
    s.send("dark", { source: {} });
    s.send("invalid");
    assert.equal(s.html.dataset.workbenchTheme, "light");
});
test("canvas theme setter notifies parent but leaves standalone canvases standalone", () => {
    const source = readFileSync(new URL("../src/canvas/stores/use-theme-store.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("theme.ts", source, ts.ScriptTarget.Latest, true);
    let setter;
    const visit = node => {
        if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "setTheme") setter = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const sent = [];
    const window = { location: { origin: "http://localhost:5174" }, parent: { postMessage: (...args) => sent.push(args) } };
    let state;
    const context = vm.createContext({ window, set: value => { state = value; } });
    vm.runInContext(ts.transpileModule(`const setter = ${setter.getText(ast)}; setter("dark");`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    assert.equal(state.theme, "dark");
    assert.equal(sent[0][0].type, "guan-theme-change");
    window.parent = window;
    vm.runInContext('setter("light")', context);
    assert.equal(state.theme, "light");
    assert.equal(sent.length, 1);
});
