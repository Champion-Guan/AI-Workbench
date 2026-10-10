import { createPersistenceCheckpoint } from "./persistence-checkpoint";
import { frontendActivity } from "./update-activity";

const checkpoint = createPersistenceCheckpoint();

// Explicit synchronous writes only. Same key/value and exception behavior;
// no global Storage patch, credentials logging or migration.
export function checkpointLocalStorageWrite(name: string, value: string): void {
    const release = frontendActivity.acquire("storage");
    try { checkpoint.runSync(`set:${name}`, () => localStorage.setItem(name, value)); }
    finally { release(); }
}

export function checkpointLocalStorageJsonWrite(name: string, value: unknown): void {
    const release = frontendActivity.acquire("storage");
    try { checkpoint.runSync(`set:${name}`, () => localStorage.setItem(name, JSON.stringify(value))); }
    finally { release(); }
}

export function checkpointLocalStorageRemove(name: string): void {
    const release = frontendActivity.acquire("storage");
    try { checkpoint.runSync(`remove:${name}`, () => localStorage.removeItem(name)); }
    finally { release(); }
}
