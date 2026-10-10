import type { RootScope } from "@/lib/page-drain-barrier";
import { assertTaskAdmission, runTaskActivity } from "@/services/task-admission";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasPluginHost } from "@/types/canvas-plugin";

type Capabilities = Omit<CanvasPluginHost, "runTask" | "applyOps"> & {
    applyOps: (ops: CanvasAgentOp[], parent?: RootScope) => Promise<unknown>;
};

// The scope is captured in host-owned closures, never accepted from plugin
// options, global mutable context or postMessage. Old independent calls remain
// roots; multi-step plugins must explicitly await runTask and its operations.
export function createPluginTaskHost(source: Capabilities, onError?: (error: unknown) => void, parent?: RootScope): CanvasPluginHost {
    const handled = <T,>(promise: Promise<T>) => {
        // Legacy plugins may ignore applyOps' return value. Handle rejection
        // without converting it into success for callers which do await it.
        void promise.catch(error => { try { onError?.(error); } catch { /* error reporting must not break cleanup */ } });
        return promise;
    };
    const host: CanvasPluginHost = {
        ...source,
        updateNode: (id, patch) => { assertTaskAdmission(parent); source.updateNode(id, patch); },
        updateMetadata: (id, patch) => { assertTaskAdmission(parent); source.updateMetadata(id, patch); },
        applyOps: ops => handled(runTaskActivity("canvas", async scope => { await source.applyOps(ops, scope); }, parent)),
        ai: {
            ...source.ai,
            generateImage: (prompt, options) => handled(runTaskActivity("canvas", () => source.ai.generateImage(prompt, options), parent)),
            generateVideo: (prompt, options) => handled(runTaskActivity("canvas", () => source.ai.generateVideo(prompt, options), parent)),
            generateText: (prompt, options) => handled(runTaskActivity("canvas", () => source.ai.generateText(prompt, options), parent)),
        },
        runTask: operation => handled(runTaskActivity("canvas", scope => operation(createPluginTaskHost(source, onError, scope)), parent)),
    };
    return host;
}
