import type { RootScope, PageDrainBarrier } from "./page-drain-barrier";

// In-memory identity only. No timers, persistence, task-name lookup, or unload
// release: an unconsumed command is pending work, not evidence of idle.
export class DeferredTaskHandoff {
    private pending = new Map<object, { scope: RootScope; finish: () => void; claimed: boolean }>();
    constructor(private barrier: PageDrainBarrier, private capacity = 16) {}
    assertCanAdmit() {
        this.barrier.assertTaskAllowed();
        if (this.pending.size >= this.capacity) throw new Error("Task handoff unavailable");
    }
    admit(command: object) {
        this.assertCanAdmit();
        if (this.pending.has(command)) throw new Error("Task handoff unavailable");
        let finish!: () => void;
        const completed = new Promise<void>(resolve => { finish = resolve; });
        // runTask starts the callback synchronously after the admission check.
        const root = this.barrier.runTask("workbench", scope => {
            this.pending.set(command, { scope, finish, claimed: false });
            return completed;
        });
        // Do not leak an ignored rejection; admission must still fail closed.
        void root.catch(() => { this.barrier.invalidateCheckpoint(); });
        if (!this.pending.has(command)) throw new Error("Task handoff unavailable");
    }
    async execute<T>(command: object, operation: () => T | PromiseLike<T>): Promise<T> {
        const entry = this.pending.get(command);
        if (!entry || entry.claimed) throw new Error("Invalid task handoff");
        entry.claimed = true;
        try { return await this.barrier.runTask("workbench", operation, entry.scope); }
        finally { this.pending.delete(command); entry.finish(); }
    }
    cancelBeforeStart(command: object) {
        const entry = this.pending.get(command);
        if (!entry || entry.claimed) throw new Error("Invalid task handoff");
        this.pending.delete(command);
        entry.finish();
    }
}
