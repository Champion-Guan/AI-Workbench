import localforage from "localforage";
import { frontendActivity } from "@/lib/update-activity";
import { createPersistenceCheckpoint } from "@/lib/persistence-checkpoint";
import type { StateStorage } from "zustand/middleware";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

const fallbackMarker = (name: string) => `infinite-canvas:fallback:${name}`;
const operations = new Map<string, Promise<void>>();
let revision = 0;
const stagingCheckpoint = createPersistenceCheckpoint();
const commitCheckpoint = createPersistenceCheckpoint();
const recoveryCheckpoint = createPersistenceCheckpoint();

function stage<T>(name: string, operation: () => T): T {
    const release = frontendActivity.acquire("storage");
    try { return stagingCheckpoint.runSync(name, operation); }
    finally { release(); }
}

function observeRecovery(name: string, verify?: () => void) {
    const release = frontendActivity.acquire("storage");
    try {
        recoveryCheckpoint.runSync(name, verify || (() => { throw new Error("Recovery not confirmed"); }));
    } catch { /* Evidence only; preserve the original read/write result. */ }
    finally { release(); }
}

function verifyRecovery(name: string) {
    observeRecovery(name, () => {
        // Don't delete or replay an older/newer fallback to obtain confirmation.
        if (window.localStorage.getItem(fallbackMarker(name)) !== null || window.localStorage.getItem(name) !== null) {
            throw new Error("Recovery not confirmed");
        }
    });
}

async function confirmPrimaryWithoutFallback(name: string, value: string, marker: string) {
    // A quota error is recoverable only after byte-for-byte primary read-back
    // and proof that no old/partial fallback or tombstone can override it.
    // Never erase an existing recovery copy to make this check pass.
    try {
        await stagingCheckpoint.run(name, async () => {
            const verify = () => {
                if (marker !== `value:${revision}` || window.localStorage.getItem(name) !== null || window.localStorage.getItem(fallbackMarker(name)) !== null) {
                    throw new Error("Primary persistence not confirmed");
                }
            };
            verify();
            if (await localforage.getItem<string>(name) !== value) throw new Error("Primary persistence not confirmed");
            verify();
        });
    } catch { /* Retain failure evidence; do not change the existing save result. */ }
}

// Wait for the real per-key FIFO, including queued writes not yet inside their
// commit checkpoint. No retries, data migration or database cleanup here.
export async function flushLocalForagePersistence(): Promise<void> {
    for (;;) {
        const currentRevision = revision;
        await Promise.allSettled([...operations.values()]);
        if (currentRevision !== revision || operations.size) continue;
        const checkpoints = [stagingCheckpoint, commitCheckpoint, recoveryCheckpoint];
        const versions = checkpoints.map(checkpoint => checkpoint.revision());
        const results = await Promise.allSettled(checkpoints.map(checkpoint => checkpoint.flush()));
        if (currentRevision !== revision || operations.size || checkpoints.some((checkpoint, index) => checkpoint.revision() !== versions[index])) continue;
        if (results.some(result => result.status === "rejected")) throw new Error("Local persistence incomplete");
        return;
    }
}

function enqueue(name: string, operation: () => Promise<void>) {
    // Count waiting writes as well as the one currently committing.
    const release = frontendActivity.acquire("storage");
    const previous = operations.get(name) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    operations.set(name, next);
    return next.finally(() => {
        if (operations.get(name) === next) operations.delete(name);
        release();
    });
}

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            const marker = window.localStorage.getItem(fallbackMarker(name));
            if (marker?.startsWith("deleted:")) { observeRecovery(name); return null; }
            const fallback = window.localStorage.getItem(name);
            if (marker !== null || fallback !== null) observeRecovery(name);
            if (fallback !== null) return fallback;
        } catch {
            // Unreadable recovery storage cannot prove that no tombstone exists.
            observeRecovery(name);
        }
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            observeRecovery(name);
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        const marker = `value:${++revision}`;
        let staged = false;
        try {
            // Synchronous recovery copy survives navigation before IndexedDB commits.
            stage(name, () => {
                window.localStorage.setItem(name, value);
                window.localStorage.setItem(fallbackMarker(name), marker);
            });
            staged = true;
        } catch { /* Large canvases can exceed localStorage; IndexedDB remains primary. */ }
        await enqueue(name, async () => {
            let primarySucceeded = false;
            try {
                await commitCheckpoint.run(name, async () => {
                    await localforage.setItem(name, value);
                    primarySucceeded = true;
                    if (staged && window.localStorage.getItem(fallbackMarker(name)) === marker) {
                        window.localStorage.removeItem(name);
                        window.localStorage.removeItem(fallbackMarker(name));
                    }
                });
            } catch (error) {
                if (primarySucceeded || !staged) throw error;
                return;
            }
            if (!staged) await confirmPrimaryWithoutFallback(name, value, marker);
            verifyRecovery(name);
        });
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        const marker = `deleted:${++revision}`;
        stage(name, () => {
            window.localStorage.setItem(fallbackMarker(name), marker);
            window.localStorage.removeItem(name);
        });
        await enqueue(name, async () => {
            let primarySucceeded = false;
            try {
                await commitCheckpoint.run(name, async () => {
                    await localforage.removeItem(name);
                    primarySucceeded = true;
                    if (window.localStorage.getItem(fallbackMarker(name)) === marker) {
                        window.localStorage.removeItem(fallbackMarker(name));
                    }
                });
            } catch (error) {
                if (primarySucceeded) throw error;
                return;
            }
            verifyRecovery(name);
        });
    },
};
