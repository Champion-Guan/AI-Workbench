import { createJSONStorage, type PersistStorage, type StateStorage } from "zustand/middleware";
import { createPersistenceCheckpoint } from "./persistence-checkpoint";
import { frontendActivity, observeActivity } from "./update-activity";
import { createRecoveryReadGate } from "./recovery-read-gate";

// For asynchronous StateStorage (our localForage adapter). Keep the original
// JSON envelope and synchronous serialization errors before the async write.
export function createCheckpointAsyncJsonStorage<T>(getStorage: () => StateStorage): PersistStorage<T> | undefined {
    const checkpoint = createPersistenceCheckpoint();
    const recovery = createRecoveryReadGate();
    const synchronous = <R>(key: string, operation: () => R): R => {
        const release = frontendActivity.acquire("storage");
        try { return checkpoint.runSync(key, operation); }
        finally { release(); }
    };
    let storage: StateStorage;
    try { storage = synchronous("availability", getStorage); }
    catch { return undefined; }
    const reader = createJSONStorage<T>(() => storage)!;
    return {
        getItem: name => recovery.read(name, () => reader.getItem(name)),
        setItem: (name, value) => {
            const serialized = synchronous(`serialize:${name}`, () => { recovery.assertWritable(name); return JSON.stringify(value); });
            const work = observeActivity("storage", () => checkpoint.run(`set:${name}`, () => storage.setItem(name, serialized)));
            void work.catch(() => undefined);
            return work;
        },
        removeItem: name => {
            const work = observeActivity("storage", () => checkpoint.run(`remove:${name}`, () => { recovery.assertWritable(name); return storage.removeItem(name); }));
            void work.catch(() => undefined);
            return work;
        },
    };
}
