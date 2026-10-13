import { useCanvasStore } from '@/stores/canvas/use-canvas-store';
import { localForageStorage } from '@/lib/localforage-storage';
import { checkpointLocalStorageWrite, checkpointLocalStorageRemove } from '@/lib/checkpoint-local-storage';
import { canvasTaskSummary } from '@/lib/canvas/task-summary.js';
import { recycleMarkerKey, filterRecycledProjects } from '@/lib/canvas/product-recycle-markers.js';
import { readZip } from '@/lib/zip';
import { setImageBlob } from '@/services/image-storage';
import { setMediaBlob } from '@/services/file-storage';
import type { CanvasExportFile } from '@/types/canvas-export';
import type { CanvasProject } from '@/stores/canvas/use-canvas-store';
import { runTaskActivity } from '@/services/task-admission';
import { settleActivityGroup } from '@/lib/settle-activity-group';

const STORE_KEY = 'infinite-canvas:canvas_store';
const archiveKey = (id: string) => `infinite-canvas:product-recycle:${id}`;
const waitForHydration = () => new Promise<void>(resolve => {
    if (useCanvasStore.getState().hydrated) return resolve();
    const unsubscribe = useCanvasStore.subscribe(state => { if (state.hydrated) { unsubscribe(); resolve(); } });
});

export function initProductRecycleBridge() {
    if (window.parent === window) return;
    window.addEventListener('message', async event => {
        if (event.origin !== location.origin || event.source !== window.parent) return;
        const data = event.data;
        if (!['guan-product-recycle', 'guan-product-restore', 'guan-canvas-create-project', 'guan-canvas-import-project', 'guan-product-restore-sync'].includes(data?.type)) return;
        try {
            await runTaskActivity('storage', async () => {
            await waitForHydration();
            if (data.type === 'guan-product-restore-sync') {
                const store = useCanvasStore.getState();
                if (data.project) store.replaceProjects([...store.projects.filter(item => item.id !== data.project.id), data.project], store.deletedProjects.filter(item => item.id !== data.project.id));
                return;
            }
            if (data.type === 'guan-canvas-create-project') {
                const projects = useCanvasStore.getState().projects;
                const highest = projects.reduce((max, project) => {
                    const number = project.title.match(/^未命名产品(\d+)$/)?.[1];
                    return number && Number.isSafeInteger(Number(number)) ? Math.max(max, Number(number)) : max;
                }, 0);
                const title = typeof data.title === 'string' && /^未命名产品\d{1,15}$/.test(data.title) ? data.title : `未命名产品${highest + 1}`;
                const id = useCanvasStore.getState().createProject(title);
                const project = useCanvasStore.getState().openProject(id)!;
                window.parent.postMessage({ type: 'guan-canvas-project-created', projectId: id, title: project.title, productSetId: data.productSetId }, location.origin);
                return;
            }
            if (data.type === 'guan-canvas-import-project') {
                if (!(data.file instanceof File)) throw new Error('请选择画布 ZIP 文件');
                const zip = await readZip(data.file);
                const projectFile = zip.get('projects.json');
                if (!projectFile) throw new Error('导入包缺少 projects.json');
                const exported = JSON.parse(await projectFile.text()) as CanvasExportFile;
                if (!Array.isArray(exported.projects) || !exported.projects.length) throw new Error('导入包没有画布');
                await settleActivityGroup(exported.projects.flatMap(project => project.files.map(async item => {
                    const blob = zip.get(item.path);
                    if (!blob) throw new Error(`导入包缺少文件：${item.path}`);
                    const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                    await (item.storageKey.startsWith('image:') ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
                })));
                const ids = exported.projects.map(item => useCanvasStore.getState().importProject(item.project));
                for (const id of ids) {
                    const project = useCanvasStore.getState().openProject(id)!;
                    window.parent.postMessage({ type: 'guan-canvas-project-created', projectId: id, title: project.title, productSetId: data.productSetId, activate: id === ids[0] }, location.origin);
                }
                return;
            }
            if (typeof data.projectId !== 'string' || typeof data.recycleId !== 'string' || typeof data.requestId !== 'string') throw new Error('无效的产品回收请求');
            let restoredProject: CanvasProject | null = null;
            if (data.type === 'guan-product-recycle') {
                // The mounted page commits its latest nodes and viewport before
                // we snapshot. Never erase a live generation task.
                window.dispatchEvent(new CustomEvent('guan-product-before-recycle', { detail: { projectId: data.projectId } }));
                const raw = await localForageStorage.getItem(STORE_KEY);
                const stored = raw ? JSON.parse(raw) : { state: { projects: [], deletedProjects: [] }, version: 0 };
                const live = useCanvasStore.getState().openProject(data.projectId);
                const project = live || stored.state.projects.find((item: CanvasProject) => item.id === data.projectId) || null;
                if (project && canvasTaskSummary(project.nodes, project.connections).status === 'loading') throw new Error('该产品有生成任务运行中，请等待任务结束后再删除。');
                await localForageStorage.setItem(archiveKey(data.recycleId), JSON.stringify({ project }));
                checkpointLocalStorageWrite(recycleMarkerKey(data.projectId), 'deleted');
                useCanvasStore.getState().deleteProjects([data.projectId]);
                stored.state.projects = filterRecycledProjects(stored.state.projects);
                stored.state.deletedProjects = [...(stored.state.deletedProjects || []).filter((item: { id: string }) => item.id !== data.projectId), { id: data.projectId, deletedAt: new Date().toISOString() }];
                await localForageStorage.setItem(STORE_KEY, JSON.stringify(stored));
            } else {
                const archived = await localForageStorage.getItem(archiveKey(data.recycleId));
                if (!archived) throw new Error('未找到画布恢复快照，产品未恢复。');
                restoredProject = JSON.parse(archived).project;
                if (restoredProject && restoredProject.id !== data.projectId) throw new Error('画布恢复快照与产品不匹配，未修改任何数据。');
                const raw = await localForageStorage.getItem(STORE_KEY);
                const stored = raw ? JSON.parse(raw) : { state: { projects: [], deletedProjects: [] }, version: 0 };
                checkpointLocalStorageRemove(recycleMarkerKey(data.projectId));
                if (restoredProject) stored.state.projects = [...stored.state.projects.filter((item: CanvasProject) => item.id !== restoredProject!.id), restoredProject];
                stored.state.deletedProjects = (stored.state.deletedProjects || []).filter((item: { id: string }) => item.id !== data.projectId);
                useCanvasStore.getState().replaceProjects(stored.state.projects, stored.state.deletedProjects);
                await localForageStorage.setItem(STORE_KEY, JSON.stringify(stored));
            }
            window.parent.postMessage({ type: 'guan-product-recycle-result', requestId: data.requestId, ok: true, project: restoredProject }, location.origin);
            });
        } catch (error) {
            window.parent.postMessage({ type: 'guan-product-recycle-result', requestId: data.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }, location.origin);
        }
    });
}
