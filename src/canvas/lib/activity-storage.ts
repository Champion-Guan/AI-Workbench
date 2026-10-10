import { observeActivity } from "./update-activity";
import { createPersistenceCheckpoint } from "./persistence-checkpoint";

// Explicit adapter for our stores, not a global patch to localForage/IndexedDB.
// Keep the original receiver and generic/callback API, and await write settlement.
export function observeStorageWrites(store: LocalForage): LocalForage {
    const checkpoint = createPersistenceCheckpoint();
    const writes = new Set(["setItem", "removeItem", "clear", "dropInstance"]);
    const methods = new Map<PropertyKey, unknown>();
    return new Proxy(store, {
        get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== "function") return value;
            if (!methods.has(key)) {
                methods.set(key, writes.has(String(key))
                    ? (...args: unknown[]) => observeActivity("storage", () => checkpoint.run(
                        `${String(key)}:${typeof args[0] === "string" ? args[0] : "*"}`,
                        () => Reflect.apply(value, target, args),
                        key !== "dropInstance", // Options may name another database; don't infer recovery.
                    ))
                    : value.bind(target));
            }
            return methods.get(key);
        },
    });
}
