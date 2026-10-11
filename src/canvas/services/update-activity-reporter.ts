import { frontendActivity } from "@/lib/update-activity";
import { useAgentStore } from "@/stores/use-agent-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useCanvasSaveStore } from "@/stores/canvas/use-canvas-store";
import { remoteVideoJournal, remoteAgentJournal } from "@/lib/remote-task-journal";

export function startUpdateActivityReporter() {
    if (typeof window === "undefined") return () => {};
    remoteVideoJournal.restore();
    remoteAgentJournal.restore();
    const pageId = crypto.randomUUID();
    let sequence = 0, stopped = false, inFlight = false, dirty = false;
    let reportTimer: number | undefined;
    let agentRelease: (() => void) | undefined;
    let canvasSaveRelease: (() => void) | undefined;
    const taskReleases = new Map<string, () => void>();

    const observeAgent = () => {
        const state = useAgentStore.getState();
        const busy = state.sending || state.waiting || Boolean(state.pendingTool) || state.pendingApprovals.length > 0
            || ["preparing", "running"].includes(state.conversation.status);
        if (busy && !agentRelease) agentRelease = frontendActivity.acquire("agent");
        // A disconnected UI does not prove a remote Agent stopped working.
        if (!busy && state.connected && agentRelease) { agentRelease(); agentRelease = undefined; }
    };
    const observeTasks = () => {
        for (const task of useWorkbenchAgentStore.getState().tasks) {
            if (["queued", "running"].includes(task.status) && !taskReleases.has(task.id)) {
                taskReleases.set(task.id, frontendActivity.acquire("workbench"));
            } else if (["succeeded", "failed"].includes(task.status)) {
                taskReleases.get(task.id)?.();
                taskReleases.delete(task.id);
            }
        }
        // History truncation/deletion isn't terminal proof; retain unresolved leases.
    };
    const observeCanvasSave = () => {
        const { status } = useCanvasSaveStore.getState();
        // An unsuccessful write is not a safe-to-restart state. Retain the
        // blocker until a subsequent actual persistence attempt reports saved.
        if (status !== "saved" && !canvasSaveRelease) canvasSaveRelease = frontendActivity.acquire("storage");
        if (status === "saved" && canvasSaveRelease) { canvasSaveRelease(); canvasSaveRelease = undefined; }
    };
    const report = async () => {
        if (stopped) return;
        if (inFlight) { dirty = true; return; }
        inFlight = true;
        dirty = false;
        try {
            const response = await fetch("/local-app/activity/report", {
                method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
                body: JSON.stringify({ protocol: 1, pageId, sequence: sequence++, counts: frontendActivity.snapshot() }),
                signal: AbortSignal.timeout(4000),
            });
            await response.text();
        } catch { /* Old service/offline telemetry must not affect workbench operations. */ }
        finally {
            inFlight = false;
            if (dirty && !stopped) void report();
        }
    };
    observeAgent();
    observeTasks();
    observeCanvasSave();
    const unsubAgent = useAgentStore.subscribe(observeAgent);
    const unsubTasks = useWorkbenchAgentStore.subscribe(observeTasks);
    const unsubCanvasSave = useCanvasSaveStore.subscribe(observeCanvasSave);
    const unsubActivity = frontendActivity.subscribe(() => {
        // Streaming updates can enqueue many writes; coalesce observation traffic.
        if (reportTimer === undefined) reportTimer = window.setTimeout(() => {
            reportTimer = undefined;
            void report();
        }, 100);
    });
    const restoreRemoteTasks = () => { remoteVideoJournal.restore(); remoteAgentJournal.restore(); };
    const timer = window.setInterval(() => { restoreRemoteTasks(); void report(); }, 5000);
    const pageshow = () => { restoreRemoteTasks(); void report(); };
    const storageChanged = () => { restoreRemoteTasks(); void report(); };
    window.addEventListener("pageshow", pageshow);
    window.addEventListener("storage", storageChanged);
    void report();
    return () => {
        stopped = true;
        if (reportTimer !== undefined) window.clearTimeout(reportTimer);
        window.clearInterval(timer);
        window.removeEventListener("pageshow", pageshow);
        window.removeEventListener("storage", storageChanged);
        unsubAgent(); unsubTasks(); unsubCanvasSave(); unsubActivity();
        // No zero-count unload beacon: lost heartbeats must become unknown.
    };
}
