import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { filterRecycledProjects } from '@/lib/canvas/product-recycle-markers.js';
import { localForageStorage } from "@/lib/localforage-storage";
import { createRecoveryReadGate } from "@/lib/recovery-read-gate";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    imageInfoDefaultVersion?: number;
    viewport: ViewportTransform;
    deletedNodeBatches?: CanvasDeletedNodeBatch[];
};

export type CanvasDeletedNodeBatch = {
    id: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    relatedNodes?: CanvasNodeData[];
    deletedAt: string;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string, initialNodes?: CanvasNodeData[]) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport" | "deletedNodeBatches">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
const canvasReadGate = createRecoveryReadGate();
type PersistedCanvasState = Pick<CanvasStore, "projects" | "deletedProjects">;
let queuedPersistState: PersistedCanvasState | null = null;
export const useCanvasSaveStore = create<{ status: "saving" | "saved" | "error" }>(() => ({ status: "saved" }));
let saveRevision = 0;
let pendingCanvasPersistence: Promise<void> = Promise.resolve();

function recordCanvasPersistence(operation: () => unknown) {
    const revision = ++saveRevision;
    useCanvasSaveStore.setState({ status: "saving" });
    try {
        pendingCanvasPersistence = Promise.resolve(operation()).then(() => {
            if (revision === saveRevision) useCanvasSaveStore.setState({ status: "saved" });
        }, () => {
            if (revision === saveRevision) useCanvasSaveStore.setState({ status: "error" });
            throw new Error("Canvas persistence failed");
        });
    } catch {
        useCanvasSaveStore.setState({ status: "error" });
        pendingCanvasPersistence = Promise.reject(new Error("Canvas persistence failed"));
    }
    // Retain rejection for the explicit drain without an unhandled rejection
    // when Zustand uses its original fire-and-forget setItem interface.
    void pendingCanvasPersistence.catch(() => undefined);
    return pendingCanvasPersistence;
}

// A caller must first flush committed React edits and viewport timers. This
// only waits for canvas-store writes already submitted, not unrendered state.
export async function flushCanvasPersistence(): Promise<void> {
    for (;;) {
        const revision = saveRevision;
        try { await pendingCanvasPersistence; }
        catch {
            if (revision === saveRevision) throw new Error("Canvas persistence failed");
        }
        if (revision !== saveRevision) continue;
        if (useCanvasSaveStore.getState().status !== "saved") throw new Error("Canvas persistence incomplete");
        return;
    }
}

export function withCanvasAppearanceDefaults<T extends { showImageInfo?: boolean; imageInfoDefaultVersion?: number }>(project: T) {
    if (project.imageInfoDefaultVersion === 1) return project;
    return { ...project, showImageInfo: true, imageInfoDefaultVersion: 1 };
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: (name) => canvasReadGate.read(name, async () => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        parsed.state.projects = filterRecycledProjects(parsed.state.projects || []).map(withCanvasAppearanceDefaults);
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    }),
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects && queuedPersistState.deletedProjects === nextState.deletedProjects && useCanvasSaveStore.getState().status !== "error") return;
        queuedPersistState = nextState;
        void recordCanvasPersistence(() => {
            canvasReadGate.assertWritable(name);
            const serialized = JSON.stringify({ ...value, state: { ...value.state, projects: filterRecycledProjects(value.state.projects || []) } });
            return localForageStorage.setItem(name, serialized);
        });
    },
    removeItem: (name) => {
        queuedPersistState = null;
        return recordCanvasPersistence(() => { canvasReadGate.assertWritable(name); return localForageStorage.removeItem(name); });
    },
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            deletedProjects: [],
            createProject: (title = i18n.t("canvas.project.untitled"), initialNodes = []) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: initialNodes,
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: true,
                    imageInfoDefaultVersion: 1,
                    viewport: initialViewport,
                    deletedNodeBatches: [],
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: withCanvasAppearanceDefaults(source).showImageInfo ?? true,
                    imageInfoDefaultVersion: 1,
                    viewport: source.viewport || initialViewport,
                    deletedNodeBatches: source.deletedNodeBatches || [],
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    const projects = state.projects.filter((project) => !removing.has(project.id));
                    const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
                    return { projects, deletedProjects };
                }),
            replaceProjects: (projects, deletedProjects = []) => set({ projects, deletedProjects }),
            updateProject: (id, patch) =>
                set((state) => {
                    const current = state.projects.find((project) => project.id === id);
                    if (!current || Object.entries(patch).every(([key, value]) => current[key as keyof CanvasProject] === value)) return state;
                    return { projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)) };
                }),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                    deletedProjects: state.deletedProjects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => (_state, error) => {
                if (_state !== undefined && error === undefined) useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
