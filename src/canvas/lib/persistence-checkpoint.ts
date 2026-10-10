// Local persistence evidence, not a complete browser inventory. No values,
// credentials or backend error text are retained or exposed by checkpoints.
export class PersistenceCheckpoint {
    private states = new Map<string, { active: number; failed: boolean; generation: number }>();
    private pending = new Set<Promise<unknown>>();
    private overflow = false;
    private changeRevision = 0;

    constructor(private capacity = 4096) {}
    revision() { return this.changeRevision; }

    private begin(key: string, recoverable = true) {
        this.changeRevision++;
        let state = this.states.get(key);
        if (!state) {
            if (this.states.size >= this.capacity) {
                // Preserve business operations, but never silently evict evidence.
                this.overflow = true;
                return (_success: boolean) => {};
            }
            state = { active: 0, failed: false, generation: 0 };
            this.states.set(key, state);
        }
        const overlapped = state.active > 0;
        state.active++;
        const generation = ++state.generation;
        return (success: boolean) => {
            this.changeRevision++;
            state.active--;
            if (!success) state.failed = true;
            // Concurrent writes have no reliable commit ordering. Only a fresh,
            // non-overlapping successful retry of this operation clears failure.
            else if (recoverable && !overlapped && state.generation === generation) state.failed = false;
            if (!state.active && !state.failed) this.states.delete(key);
        };
    }

    runSync<T>(key: string, operation: () => T): T {
        const finish = this.begin(key);
        try { const result = operation(); finish(true); return result; }
        catch (error) { finish(false); throw error; }
    }

    run<T>(key: string, operation: () => T | PromiseLike<T>, recoverable = true): Promise<T> {
        const finish = this.begin(key, recoverable);
        // Invoke synchronously to preserve native callback timing/receiver.
        let result: T | PromiseLike<T>;
        try { result = operation(); }
        catch (error) { finish(false); return Promise.reject(error); }
        const work = Promise.resolve(result).then(
            value => { finish(true); return value; },
            error => { finish(false); throw error; },
        );
        this.pending.add(work);
        // Handle cleanup without creating a detached rejected promise. The
        // caller still receives the original failure, not a success substitute.
        void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
        return work;
    }

    async flush(): Promise<void> {
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        if (this.overflow || [...this.states.values()].some(state => state.failed || state.active)) {
            throw new Error("Persistence checkpoint incomplete");
        }
    }
}

const checkpoints = new Set<PersistenceCheckpoint>();
const listeners = new Set<() => void>();
let topology = 0;
let overflow = false;

export function createPersistenceCheckpoint() {
    const checkpoint = new PersistenceCheckpoint();
    if (checkpoints.size < 256) checkpoints.add(checkpoint);
    else overflow = true;
    topology++;
    for (const listener of listeners) { try { listener(); } catch { /* diagnostics must not break writes */ } }
    return checkpoint;
}

export function subscribePersistenceCheckpoints(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export async function flushStorageCheckpoints() {
    const revision = topology;
    for (;;) {
        const entries = [...checkpoints].map(checkpoint => ({ checkpoint, revision: checkpoint.revision() }));
        const results = await Promise.allSettled(entries.map(({ checkpoint }) => checkpoint.flush()));
        if (overflow || revision !== topology || results.some(result => result.status === "rejected")) {
            throw new Error("Storage persistence incomplete");
        }
        // A previously flushed store may receive another write while a sibling
        // is finishing. Revalidate the whole set, not only the slowest store.
        if (entries.every(entry => entry.revision === entry.checkpoint.revision())) return;
    }
}
