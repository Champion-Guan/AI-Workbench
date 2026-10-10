import { DeferredTaskHandoff } from "@/lib/deferred-task-handoff";
import { frontendTaskBarrier, runTaskActivity } from "@/services/task-admission";

export const workbenchTaskHandoff = new DeferredTaskHandoff(frontendTaskBarrier);
export function runWorkbenchTask<T>(command: object | undefined, operation: () => T | PromiseLike<T>): Promise<T> {
    return command ? workbenchTaskHandoff.execute(command, operation) : runTaskActivity("workbench", operation);
}
