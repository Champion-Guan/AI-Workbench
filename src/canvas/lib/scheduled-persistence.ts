import { createPersistenceCheckpoint } from "./persistence-checkpoint";
import { observeActivity } from "./update-activity";

const checkpoint = createPersistenceCheckpoint();

// Acquire before scheduling; a timer not yet fired is still pending work.
// No timeout/cancel path pretends a scheduled mutation was saved or stopped.
export function schedulePersistenceTask<T>(key: string, schedule: (start: () => void) => unknown, operation: () => T | PromiseLike<T>): Promise<T> {
    return observeActivity("storage", () => checkpoint.run(key, () => new Promise<T>((resolve, reject) => {
        let started = false;
        let abandoned = false;
        let schedulingFailed = false;
        let schedulingError: unknown;
        try {
            schedule(() => {
                if (started || abandoned) return;
                started = true;
                Promise.resolve().then(operation).then(
                    value => schedulingFailed ? reject(schedulingError) : resolve(value),
                    reject,
                );
            });
        } catch (error) {
            schedulingFailed = true;
            schedulingError = error;
            // If a synchronous scheduler already started work, wait for it.
            if (!started) { abandoned = true; reject(error); }
        }
    })));
}
