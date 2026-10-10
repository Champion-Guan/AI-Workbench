import { observeActivity } from "./update-activity";
import { unresolvedWebdavActivity } from "./unresolved-activity";

let syncQueue: Promise<unknown> = Promise.resolve();
const LOCK_NAME = "guan-workbench-webdav-sync-v1";

export function withWebdavActivityLock<T>(operation: () => Promise<T>, locks = typeof navigator === "undefined" ? undefined : navigator.locks): Promise<T> {
    // Count time waiting both in this page's FIFO and other pages' Web Lock.
    return observeActivity("webdav", () => {
        const next = syncQueue.catch(() => undefined).then(async (): Promise<T> => {
            if (locks) return await locks.request(LOCK_NAME, { mode: "exclusive" }, operation);
            // Keep legacy sync working, but never claim cross-page safety here.
            unresolvedWebdavActivity.markUnknown();
            return await operation();
        });
        syncQueue = next.then(() => undefined, () => undefined);
        return next;
    });
}
