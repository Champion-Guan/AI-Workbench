// Browser-only QA fixture. Synthetic Chrome API bindings, real MessageChannel,
// actual local barrier and real isolated IndexedDB. Never included in Release.
import { startManagedPageRelay } from "../../src/canvas/services/managed-page-relay";
import { frontendTaskBarrier } from "../../src/canvas/services/task-admission";
import { frontendActivity } from "../../src/canvas/lib/update-activity";

const epoch = "22222222-2222-4222-8222-222222222222";
let commands: ((value: unknown) => void) | undefined, sequence = -1, session: string | null = null;
let finishTask: (() => void) | undefined, finishSave: (() => void) | undefined;
let phase = "unsupported", acknowledged = false, persisted = false, denied = false, task: Promise<unknown> | undefined;
const callbacks = <T>() => { const listeners: ((v: T) => void)[] = []; return { addListener: (fn: (v: T) => void) => listeners.push(fn), emit: (v: T) => listeners.forEach(fn => fn(v)) }; };
const update = () => {
    document.getElementById("state")!.textContent = JSON.stringify({ phase, acknowledged, persisted, denied,
        counts: frontendActivity.snapshot(), installAllowed: false, fullRootCoverage: false });
};
const port = { onMessage: { addListener: (fn: (value: unknown) => void) => { commands = fn; } }, onDisconnect: callbacks<void>(), disconnect() {},
    postMessage(value: { op: string; session: string; phase?: string; acknowledged?: boolean }) {
        if (value.op === "page-ready") { session = value.session; phase = "ready"; }
        else if (value.op === "page-state") { phase = value.phase!; acknowledged = value.acknowledged!; }
        update();
    } };
Object.assign(globalThis, { chrome: { runtime: { connect: () => port } } });
const stop = startManagedPageRelay();
frontendTaskBarrier.registerFlush(async () => {
    await new Promise<void>(resolve => { finishSave = resolve; });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("guan-managed-page-qa", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("qa");
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error("QA database open failed"));
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction("qa", "readwrite");
            transaction.objectStore("qa").put("qa-sentinel", "saved");
            transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(Error("QA database write failed"));
        });
        const value = await new Promise<unknown>((resolve, reject) => {
            const request = database.transaction("qa").objectStore("qa").get("saved");
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error("QA database read failed"));
        });
        if (value !== "qa-sentinel") throw Error("QA persistence mismatch");
        persisted = true; update();
    } finally { database.close(); }
});
frontendActivity.subscribe(update);
function send(op: string) {
    if (!session || !commands) throw Error("QA page unsupported");
    commands({ protocol: 1, session, sequence: ++sequence, op, epoch: op === "probe" ? null : epoch });
}
document.getElementById("start")!.onclick = () => {
    task = frontendTaskBarrier.runTask("canvas", async scope => {
        await new Promise<void>(resolve => { finishTask = resolve; });
        await scope.runChild("storage", async () => {});
    });
    void task.catch(() => { denied = true; update(); });
};
document.getElementById("pause")!.onclick = () => send("pause");
document.getElementById("new-root")!.onclick = () => { void frontendTaskBarrier.runTask("canvas", async () => {}).catch(() => { denied = true; update(); }); };
document.getElementById("finish-task")!.onclick = () => finishTask?.();
document.getElementById("finish-save")!.onclick = () => finishSave?.();
document.getElementById("assert")!.onclick = () => send("assert");
document.getElementById("aba")!.onclick = () => { const release = frontendActivity.acquire("storage"); release(); send("assert"); };
document.getElementById("resume")!.onclick = () => send("resume");
window.addEventListener("pagehide", stop, { once: true });
update();
const script = document.createElement("script"); script.src = "/__qa/content.js"; document.head.appendChild(script);
