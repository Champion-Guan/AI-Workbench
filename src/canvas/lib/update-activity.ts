// Observational only: this module cannot pause tasks or authorize installation.
// Counts contain no prompts, URLs, keys, product names or user data.
export const activityDomains = ["canvas", "workbench", "agent", "webdav", "storage"] as const;
export type ActivityDomain = (typeof activityDomains)[number];
export type ActivityCounts = Record<ActivityDomain, number>;
type Lifecycle = { begin: (domain: ActivityDomain) => unknown | PromiseLike<unknown>; complete: (lease: unknown, successful: boolean) => void | PromiseLike<void> };

export class FrontendActivityRegistry {
    private counts: ActivityCounts = { canvas: 0, workbench: 0, agent: 0, webdav: 0, storage: 0 };
    private listeners = new Set<() => void>();
    private changeRevision = 0;
    private lifecycle: Lifecycle | null = null;
    setLifecycle(value: Lifecycle) {
        if (this.lifecycle) throw Error("Activity lifecycle already registered");
        this.lifecycle = value;
        return () => { if (this.lifecycle === value) this.lifecycle = null; };
    }

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
    // Explicitly asynchronous network boundaries only. Synchronous mutations
    // and storage callback contracts keep using run(), never this hook.
    async runNetwork<T>(domain: ActivityDomain, operation: () => T | PromiseLike<T>): Promise<T> {
        const release = this.acquire(domain);
        const lifecycle = this.lifecycle;
        let lease: unknown, successful = false;
        try {
            // With no enabled write-ahead hook, preserve the existing contract:
            // operation starts synchronously, before this function's first await.
            if (lifecycle) {
                const beginning = lifecycle.begin(domain);
                lease = beginning && typeof (beginning as PromiseLike<unknown>).then === "function" ? await beginning : beginning;
            }
            const value = await operation(); successful = true; return value;
        } finally {
            // A lost completion must keep durable evidence, but must not turn
            // an already committed business write into a false business error.
            try { if (lifecycle) await lifecycle.complete(lease, successful); }
            catch { /* Durable row stays pending; never invent completion. */ }
            finally { release(); }
        }
    }
}

export const frontendActivity = new FrontendActivityRegistry();
export function observeActivity<T>(domain: ActivityDomain, operation: () => T | PromiseLike<T>): Promise<T> {
    return frontendActivity.run(domain, operation);
}
export function observeNetworkActivity<T>(domain: ActivityDomain, operation: () => T | PromiseLike<T>): Promise<T> {
    return frontendActivity.runNetwork(domain, operation);
}
