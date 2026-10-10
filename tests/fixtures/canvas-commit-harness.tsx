// Isolated browser fixture. Real React + actual hook, memory-only fake writes.
// Never bundled into the application or release packages.
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useCanvasUpdateFlush } from "../../src/canvas/pages/canvas/hooks/use-update-flush";
import { canvasUpdateFlush } from "../../src/canvas/services/canvas-update-flush";
import { frontendActivity } from "../../src/canvas/lib/update-activity";
import { frontendTaskBarrier, runTaskActivity } from "../../src/canvas/services/task-admission";
import { runWorkbenchTask } from "../../src/canvas/services/workbench-task-handoff";
import { useWorkbenchAgentStore } from "../../src/canvas/stores/use-workbench-agent-store";

const writes: Array<{ nodes: string[]; viewport: { x: number; y: number } }> = [];
const pending: Array<() => void> = [];
let edit: (label: string) => void;
let setReady: (ready: boolean) => void;
let finishBatch: (() => void) | undefined;
let finishCommand: (() => void) | undefined;
function Harness() {
    const [nodes, setNodes] = useState(["original"]);
    const [viewport, setViewport] = useState({ x: 0, y: 0 });
    const [ready, changeReady] = useState(true);
    const snapshot = useMemo(() => ({ nodes, viewport }), [nodes, viewport]);
    edit = label => { setNodes([label]); setViewport({ x: label.length, y: 17 }); };
    setReady = changeReady;
    useCanvasUpdateFlush(snapshot, () => ready, async value => {
        writes.push(value);
        await new Promise<void>(resolve => pending.push(resolve));
    });
    return <div>{nodes.join(",")} · {viewport.x},{viewport.y}</div>;
}
const root = createRoot(document.getElementById("qa-root")!);
root.render(<React.StrictMode><Harness /></React.StrictMode>);
Object.assign(window, { qa: {
    edit: (label: string) => edit(label),
    setReady: (ready: boolean) => setReady(ready),
    flush: () => canvasUpdateFlush.flushAll(),
    resolveWrites: () => { for (const resolve of pending.splice(0)) resolve(); },
    status: () => ({ count: canvasUpdateFlush.count(), writes, counts: frontendActivity.snapshot() }),
    unmount: () => root.unmount(),
    runBatch: () => runTaskActivity("canvas", async scope => {
        await new Promise<void>(resolve => { finishBatch = resolve; });
        await runTaskActivity("canvas", async () => { edit("batch-finished"); }, scope);
    }),
    finishBatch: () => finishBatch?.(),
    newTask: () => runTaskActivity("canvas", async () => { edit("must-not-run"); }),
    drain: (epoch: string) => frontendTaskBarrier.drain(epoch),
    acknowledged: (receipt: Parameters<typeof frontendTaskBarrier.isAcknowledged>[0]) => frontendTaskBarrier.isAcknowledged(receipt),
    resume: (epoch: string) => frontendTaskBarrier.resume(epoch),
    enqueueCommand: () => useWorkbenchAgentStore.getState().dispatchImage({ run: true, prompt: "qa-memory-only" }),
    runCommand: () => {
        const command = useWorkbenchAgentStore.getState().imageCommand;
        if (!command) throw new Error("QA command absent");
        return runWorkbenchTask(command, async () => {
            useWorkbenchAgentStore.getState().clearImageCommand(command.nonce);
            await new Promise<void>(resolve => { finishCommand = resolve; });
            edit("command-finished");
        });
    },
    finishCommand: () => finishCommand?.(),
} });
