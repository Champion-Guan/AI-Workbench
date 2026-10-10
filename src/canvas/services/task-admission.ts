import { frontendActivity, type ActivityDomain } from "@/lib/update-activity";
import { PageDrainBarrier, type RootScope } from "@/lib/page-drain-barrier";
import { canvasUpdateFlush } from "@/services/canvas-update-flush";
import { flushStorageCheckpoints, subscribePersistenceCheckpoints } from "@/lib/persistence-checkpoint";
import { flushLocalForagePersistence } from "@/lib/localforage-storage";

// Local task admission only. No HTTP/window/postMessage control, inventory
// verification or automatic drain. Production installation remains disabled.
export const frontendTaskBarrier = new PageDrainBarrier(frontendActivity);
frontendTaskBarrier.registerFlush(flushStorageCheckpoints);
frontendTaskBarrier.registerFlush(flushLocalForagePersistence);
subscribePersistenceCheckpoints(() => frontendTaskBarrier.invalidateCheckpoint());
frontendTaskBarrier.registerFlush(async () => {
    // No mounted canvas in an image/video page is not a global inventory proof.
    if (canvasUpdateFlush.count()) await canvasUpdateFlush.flushAll();
});
canvasUpdateFlush.subscribe(() => frontendTaskBarrier.invalidateCheckpoint());
export function runTaskActivity<T>(domain: ActivityDomain, operation: (scope: RootScope) => T | PromiseLike<T>, parent?: RootScope): Promise<T> {
    return frontendTaskBarrier.runTask(domain, operation, parent);
}
// Synchronous plugin mutations keep their existing synchronous contract. This
// is local admission only, not evidence that React/storage has committed them.
export function assertTaskAdmission(parent?: RootScope) {
    frontendTaskBarrier.assertTaskAllowed(parent);
}
