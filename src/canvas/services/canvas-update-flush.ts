// Only the currently mounted canvases in this JS realm. This is not a trusted
// inventory of browser windows, cached iframes, old pages or remote tasks.
export class CanvasFlushRegistry {
    private participants = new Map<symbol, () => Promise<void>>();
    private revision = 0;
    private listeners = new Set<() => void>();
    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    private changed() {
        this.revision++;
        for (const listener of this.listeners) { try { listener(); } catch { /* Diagnostic consumers must not break mounting. */ } }
    }
    register(flush: () => Promise<void>) {
        const id = Symbol();
        this.participants.set(id, flush);
        this.changed();
        let removed = false;
        return () => {
            if (removed) return;
            removed = true;
            this.participants.delete(id);
            this.changed();
        };
    }
    count() { return this.participants.size; }
    async flushAll() {
        const revision = this.revision;
        if (!this.participants.size) throw new Error("Canvas inventory empty");
        const outcomes = await Promise.allSettled([...this.participants.values()].map(async flush => { await flush(); }));
        if (revision !== this.revision || outcomes.some(result => result.status === "rejected")) throw new Error("Canvas flush unconfirmed");
    }
}

export const canvasUpdateFlush = new CanvasFlushRegistry();
