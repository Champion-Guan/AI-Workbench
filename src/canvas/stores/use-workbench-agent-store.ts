import { create } from "zustand";
import { workbenchTaskHandoff } from "@/services/workbench-task-handoff";

// The Agent panel dispatches commands through this store to set workbench prompts and optionally start generation.
// The panel writes model, quality, size, count, and other options to use-config-store, which workbench pages read directly.
// Prompt and run are sent here; pages identify new commands by nonce and call clear after consuming them.

export type WorkbenchCommand = {
    nonce: number;
    taskId?: string;
    prompt?: string;
    run: boolean;
};

export type WorkbenchGenerationTask = {
    id: string;
    kind: "image" | "video";
    status: "queued" | "running" | "succeeded" | "failed";
    prompt?: string;
    createdAt: string;
    updatedAt: string;
    successCount?: number;
    failCount?: number;
    error?: string;
};

type WorkbenchAgentStore = {
    imageCommand: WorkbenchCommand | null;
    videoCommand: WorkbenchCommand | null;
    tasks: WorkbenchGenerationTask[];
    dispatchImage: (command: Omit<WorkbenchCommand, "nonce" | "taskId">) => string | undefined;
    dispatchVideo: (command: Omit<WorkbenchCommand, "nonce" | "taskId">) => string | undefined;
    updateTask: (id: string, patch: Partial<Pick<WorkbenchGenerationTask, "status" | "successCount" | "failCount" | "error">>) => void;
    clearImageCommand: (expectedNonce?: number) => void;
    clearVideoCommand: (expectedNonce?: number) => void;
};

let nonce = 0;
const nextNonce = () => (nonce += 1);

export const useWorkbenchAgentStore = create<WorkbenchAgentStore>((set) => ({
    imageCommand: null,
    videoCommand: null,
    tasks: [],
    dispatchImage: (command) => {
        assertWorkbenchCommandAvailable("image");
        const commandNonce = nextNonce();
        const task = command.run ? createTask("image", commandNonce, command.prompt) : undefined;
        const admitted = Object.freeze({ ...command, nonce: commandNonce, taskId: task?.id });
        workbenchTaskHandoff.admit(admitted);
        try { set((state) => ({ imageCommand: admitted, tasks: task ? [task, ...state.tasks].slice(0, 30) : state.tasks })); }
        catch (error) { workbenchTaskHandoff.cancelBeforeStart(admitted); throw error; }
        return task?.id;
    },
    dispatchVideo: (command) => {
        assertWorkbenchCommandAvailable("video");
        const commandNonce = nextNonce();
        const task = command.run ? createTask("video", commandNonce, command.prompt) : undefined;
        const admitted = Object.freeze({ ...command, nonce: commandNonce, taskId: task?.id });
        workbenchTaskHandoff.admit(admitted);
        try { set((state) => ({ videoCommand: admitted, tasks: task ? [task, ...state.tasks].slice(0, 30) : state.tasks })); }
        catch (error) { workbenchTaskHandoff.cancelBeforeStart(admitted); throw error; }
        return task?.id;
    },
    updateTask: (id, patch) => set((state) => ({ tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...patch, updatedAt: new Date().toISOString() } : task)) })),
    clearImageCommand: (expectedNonce) => set((state) => expectedNonce === undefined || state.imageCommand?.nonce === expectedNonce ? { imageCommand: null } : {}),
    clearVideoCommand: (expectedNonce) => set((state) => expectedNonce === undefined || state.videoCommand?.nonce === expectedNonce ? { videoCommand: null } : {}),
}));

// Called before Agent tools mutate configuration or navigate, as well as at
// dispatch. All steps are synchronous; no new root may slip between them.
export function assertWorkbenchCommandAvailable(kind: "image" | "video") {
    workbenchTaskHandoff.assertCanAdmit();
    const state = useWorkbenchAgentStore.getState();
    if (kind === "image" ? state.imageCommand : state.videoCommand) throw new Error("Workbench command already pending");
}

function createTask(kind: "image" | "video", commandNonce: number, prompt?: string): WorkbenchGenerationTask {
    const now = new Date().toISOString();
    return { id: `${kind}-${commandNonce}`, kind, status: "queued", prompt, createdAt: now, updatedAt: now };
}
