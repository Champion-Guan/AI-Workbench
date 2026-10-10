import type { ActivityDomain, FrontendActivityRegistry } from "./update-activity";

export type DrainReceipt = Readonly<{ epoch: string; revision: number }>;
export type RootScope = { runChild<T>(domain: ActivityDomain, operation: () => T | PromiseLike<T>): Promise<T> };

// No browser endpoint, installation permission or automatic activation.
// A trusted complete inventory must own the protocol.
export class PageDrainBarrier {
    private epoch: string | null = null;
    private receipt: DrainReceipt | null = null;
    private flushers = new Set<() => Promise<void>>();
    private flushing: Promise<DrainReceipt> | null = null;
    private generation = 0;
    private unsubscribe: () => void;
    private disposed = false;
    private controller: AbortController | null = null;
    private liveScopes = new WeakSet<RootScope>();

    constructor(private activity: FrontendActivityRegistry) {
        this.unsubscribe = activity.subscribe(() => { this.receipt = null; });
    }
    registerFlush(flush: () => Promise<void>) {
        if (this.disposed || this.epoch) throw new Error("update_quiescing");
        this.flushers.add(flush);
        return () => {
            this.flushers.delete(flush);
            // Unmount is not proof that pending React edits were persisted.
            this.generation++;
            this.receipt = null;
        };
    }
    async runRoot<T>(domain: ActivityDomain, operation: (scope: RootScope) => T | PromiseLike<T>): Promise<T> {
        if (this.disposed || this.epoch) throw new Error("update_quiescing");
        let live = true;
        const scope: RootScope = {
            runChild: (childDomain, child) => {
                if (!live) return Promise.reject(new Error("Root scope closed"));
                return this.activity.run(childDomain, child);
            },
        };
        Object.freeze(scope);
        this.liveScopes.add(scope);
        try { return await this.activity.run(domain, () => operation(scope)); }
        finally { live = false; this.liveScopes.delete(scope); }
    }
    runTask<T>(domain: ActivityDomain, operation: (scope: RootScope) => T | PromiseLike<T>, parent?: RootScope): Promise<T> {
        if (parent === undefined) return this.runRoot(domain, operation);
        // Never reinterpret a foreign/expired scope as a fresh root, nor trust
        // a lookalike object's runChild method. Explicit ownership is required.
        if (!this.liveScopes.has(parent) || this.disposed) return Promise.reject(new Error("Invalid task scope"));
        return parent.runChild(domain, () => operation(parent));
    }
    assertTaskAllowed(parent?: RootScope) {
        if (parent === undefined) {
            if (this.disposed || this.epoch) throw new Error("update_quiescing");
        } else if (!this.liveScopes.has(parent) || this.disposed) {
            throw new Error("Invalid task scope");
        }
    }
    invalidateCheckpoint() {
        this.generation++;
        this.receipt = null;
    }
    private waitIdle(signal?: AbortSignal) {
        return new Promise<number>((resolve, reject) => {
            let unsubscribe = () => {};
            const cleanup = () => { unsubscribe(); signal?.removeEventListener("abort", aborted); };
            const aborted = () => { cleanup(); reject(new Error("Drain aborted")); };
            const check = () => {
                if (Object.values(this.activity.snapshot()).every(count => count === 0)) { cleanup(); resolve(this.activity.revision()); }
            };
            if (signal?.aborted) { aborted(); return; }
            unsubscribe = this.activity.subscribe(check);
            signal?.addEventListener("abort", aborted, { once: true });
            check();
        });
    }
    async drain(epoch: string, signal?: AbortSignal): Promise<DrainReceipt> {
        if (this.disposed || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(epoch)) throw new Error("Invalid drain epoch");
        if (this.epoch && this.epoch !== epoch) throw new Error("Invalid drain epoch");
        if (this.flushing) throw new Error("Drain already pending");
        this.epoch = epoch;
        this.receipt = null;
        const controller = new AbortController();
        this.controller = controller;
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const generation = this.generation;
        const ensureCurrent = () => {
            if (controller.signal.aborted || this.disposed || this.epoch !== epoch || generation !== this.generation) throw new Error("Drain invalidated");
        };
        const work = async () => {
            await this.waitIdle(controller.signal);
            ensureCurrent();
            // Wait for every started flush even when one fails. Never race a
            // timeout against writes and claim that the writes disappeared.
            const outcomes = await Promise.allSettled([...this.flushers].map(flush => this.activity.run("storage", flush)));
            ensureCurrent();
            const failure = outcomes.find(result => result.status === "rejected");
            if (failure?.status === "rejected") throw new Error("Persistence flush failed");
            for (;;) {
                const revision = await this.waitIdle(controller.signal);
                ensureCurrent();
                if (revision === this.activity.revision() && Object.values(this.activity.snapshot()).every(count => count === 0)) break;
            }
            const receipt = Object.freeze({ epoch, revision: this.activity.revision() });
            this.receipt = receipt;
            return receipt;
        };
        this.flushing = work();
        try { return await this.flushing; }
        finally { this.flushing = null; this.controller = null; signal?.removeEventListener("abort", abort); }
        // Failure deliberately keeps roots blocked; trusted cancellation is
        // required. Existing writes and child requests are never cancelled.
    }
    isAcknowledged(receipt: DrainReceipt) {
        return !this.disposed && this.receipt === receipt && this.epoch === receipt.epoch && this.activity.revision() === receipt.revision
            && Object.values(this.activity.snapshot()).every(count => count === 0);
    }
    resume(epoch: string) {
        if (this.epoch !== epoch) throw new Error("Invalid drain epoch");
        this.generation++;
        this.controller?.abort();
        this.epoch = null;
        this.receipt = null;
    }
    dispose() {
        this.disposed = true;
        this.controller?.abort();
        this.generation++;
        this.receipt = null;
        this.unsubscribe();
    }
}
