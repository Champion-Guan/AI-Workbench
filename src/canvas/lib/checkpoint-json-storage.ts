import type { PersistStorage, StorageValue } from "zustand/middleware";
import { createPersistenceCheckpoint } from "./persistence-checkpoint";
import { frontendActivity } from "./update-activity";
import { createRecoveryReadGate } from "./recovery-read-gate";

// Same localStorage key and JSON envelope as Zustand's default JSON storage.
// Include serialization and synchronous storage exceptions in failure evidence.
export function createCheckpointJsonStorage<T>(getStorage: () => Storage): PersistStorage<T> | undefined {
    const checkpoint = createPersistenceCheckpoint();
    const recovery = createRecoveryReadGate();
    const write = <R>(key: string, operation: () => R): R => {
        const release = frontendActivity.acquire("storage");
        try { return checkpoint.runSync(key, operation); }
        finally { release(); }
    };
    let storage: Storage;
    try { storage = write("availability", getStorage); }
    catch { return undefined; } // Preserve Zustand's unavailable-storage behavior; flush refuses.
    return {
        getItem: name => recovery.read(name, () => {
            const value = storage.getItem(name);
            return value === null ? null : JSON.parse(value) as StorageValue<T>;
        }),
        setItem: (name, value) => write(`set:${name}`, () => { recovery.assertWritable(name); storage.setItem(name, JSON.stringify(value)); }),
        removeItem: name => write(`remove:${name}`, () => { recovery.assertWritable(name); storage.removeItem(name); }),
    };
}
