import type { FrontendActivityRegistry } from "./update-activity";

type Commit<T> = { snapshot: T; revision: number; generation: number };

// A render request is only acknowledged by an actual layout-effect commit.
// It is not a timer, a captured event-handler closure or an install permission.
export class RenderCommitCheckpoint<T> {
    private active = false;
    private generation = 0;
    private revision = 0;
    private ticket = 0;
    private latest: T | undefined;
    private ready = false;
    private pending = new Map<number, { resolve: (commit: Commit<T>) => void; reject: (error: Error) => void }>();

    constructor(private activity: FrontendActivityRegistry, private requestRender: (ticket: number) => void) {}
    mount() { this.active = true; this.generation++; }
    unmount() {
        this.active = false;
        this.generation++;
        for (const pending of this.pending.values()) pending.reject(new Error("Canvas commit invalidated"));
        this.pending.clear();
        this.latest = undefined;
        this.ready = false;
    }
    commit(ticket: number, snapshot: T, ready: boolean) {
        if (!this.active) return;
        if (this.latest !== snapshot || this.ready !== ready) {
            this.latest = snapshot;
            this.ready = ready;
            this.revision++;
            // Invalidate any page-drain receipt on a new committed edit,
            // including a commit whose persistence hasn't started yet.
            this.activity.acquire("storage")();
        }
        for (const [id, pending] of this.pending) {
            if (id > ticket) continue;
            this.pending.delete(id);
            if (!ready) pending.reject(new Error("Canvas not ready to flush"));
            else pending.resolve({ snapshot, revision: this.revision, generation: this.generation });
        }
    }
    async flush(persist: (snapshot: T) => Promise<void>) {
        return this.activity.run("storage", async () => {
            if (!this.active || this.pending.size >= 32) throw new Error("Canvas commit unavailable");
            const generation = this.generation;
            const ticket = ++this.ticket;
            const committed = await new Promise<Commit<T>>((resolve, reject) => {
                this.pending.set(ticket, { resolve, reject });
                try { this.requestRender(ticket); }
                catch { this.pending.delete(ticket); reject(new Error("Canvas commit unavailable")); }
            });
            if (!this.active || generation !== this.generation || committed.revision !== this.revision) throw new Error("Canvas commit invalidated");
            await persist(committed.snapshot);
            if (!this.active || committed.generation !== this.generation || committed.revision !== this.revision) throw new Error("Canvas changed during flush");
        });
    }
}
