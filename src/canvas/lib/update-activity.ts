// Observational only: this module cannot pause tasks or authorize installation.
// Counts contain no prompts, URLs, keys, product names or user data.
export const activityDomains = ["canvas", "workbench", "agent", "webdav", "storage"] as const;
export type ActivityDomain = (typeof activityDomains)[number];
export type ActivityCounts = Record<ActivityDomain, number>;

export class FrontendActivityRegistry {
    private counts: ActivityCounts = { canvas: 0, workbench: 0, agent: 0, webdav: 0, storage: 0 };
    private listeners = new Set<() => void>();
    private changeRevision = 0;

    snapshot(): ActivityCounts { return { ...this.counts }; }
    revision() { return this.changeRevision; }
    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    private changed() {
        this.changeRevision++;
        // Telemetry must never break a business operation or its cleanup.
        for (const listener of this.listeners) { try { listener(); } catch { /* observation only */ } }
    }
    acquire(domain: ActivityDomain) {
        if (!activityDomains.includes(domain)) throw new Error("Invalid activity domain");
        this.counts[domain]++;
        this.changed();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.counts[domain]--;
            this.changed();
        };
    }
    async run<T>(domain: ActivityDomain, operation: () => T | PromiseLike<T>): Promise<T> {
        const release = this.acquire(domain);
        try { return await operation(); }
        finally { release(); }
    }
}

export const frontendActivity = new FrontendActivityRegistry();
export function observeActivity<T>(domain: ActivityDomain, operation: () => T | PromiseLike<T>): Promise<T> {
    return frontendActivity.run(domain, operation);
}
