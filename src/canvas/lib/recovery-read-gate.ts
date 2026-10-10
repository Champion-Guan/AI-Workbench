import { createPersistenceCheckpoint } from "./persistence-checkpoint";
import { frontendActivity } from "./update-activity";

// A failed/pending restore is not an empty library. Preserve the disk record
// until an explicit, non-overlapping successful read has confirmed recovery.
// No business values, credentials or original errors are retained here.
export function createRecoveryReadGate() {
    const checkpoint = createPersistenceCheckpoint();
    const states = new Map<string, { active: number; failed: boolean; revision: number }>();
    let overflow = false;
    return {
        read<T>(name: string, operation: () => T): T {
            let state = states.get(name);
            if (!state) {
                if (states.size >= 4096) overflow = true;
                else { state = { active: 0, failed: false, revision: 0 }; states.set(name, state); }
            }
            const overlapped = Boolean(state?.active);
            if (state) state.active++;
            const revision = state ? ++state.revision : 0;
            const release = frontendActivity.acquire("storage");
            const finish = (success: boolean) => {
                if (state) {
                    state.active--;
                    if (!success) state.failed = true;
                    else if (!overlapped && state.revision === revision) state.failed = false;
                    if (!state.active && !state.failed) states.delete(name);
                }
                release();
            };
            let value: T;
            let asynchronous = false;
            try { value = checkpoint.runSync(`start:${name}`, () => {
                const result = operation();
                // Inspect inside the checkpoint: an accessor can throw before
                // Promise assimilation, and must not leak the restore lease.
                asynchronous = Boolean(result && typeof (result as { then?: unknown }).then === "function");
                return result;
            }); }
            catch (error) { finish(false); throw error; }
            if (asynchronous) {
                const work = checkpoint.run(`read:${name}`, () => value).then(
                    result => { finish(true); return result; },
                    error => { finish(false); throw error; },
                );
                // Observe rejection even when Zustand restores asynchronously.
                void work.catch(() => undefined);
                return work as T;
            }
            // Also supersede a prior asynchronous read failure on a sync retry.
            checkpoint.runSync(`read:${name}`, () => undefined);
            finish(true);
            return value;
        },
        assertWritable(name: string) {
            const state = states.get(name);
            if (overflow || state?.active || state?.failed) throw new Error("Stored data recovery incomplete; original data retained");
        },
    };
}
