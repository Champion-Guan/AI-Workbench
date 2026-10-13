import { nanoid } from "nanoid";
import type { CanvasNodeData, CanvasConnection } from "@/types/canvas";

const nodeReferences = new Set(["groupId", "generationParamsSourceNodeId", "promptVariablePreviewNodeId", "promptVariableSourceNodeId", "promptVariablePreviewOf", "promptVariableEnglishPreviewOf", "promptVariableTranslationOf", "excelPromptBindingNodeId"]);

/** Prepare the whole import before writing media or changing the current canvas. */
export function prepareCanvasContentImport(data: unknown, zip: Map<string, Blob>, occupied: CanvasNodeData[]) {
    const document = data as { app?: string; version?: number; projects?: Array<{ project: { nodes: CanvasNodeData[]; connections: CanvasConnection[] }; files: Array<{ storageKey: string; path: string; mimeType: string; bytes: number }> }> };
    if (!document || document.app !== "infinite-canvas" || document.version !== 3 || !Array.isArray(document.projects) || !document.projects.length) throw Error("请选择导出当前画布生成的 ZIP 文件");
    const nodes: CanvasNodeData[] = [], connections: CanvasConnection[] = [], media: Array<{ key: string; blob: Blob }> = [];
    let right = occupied.reduce((max, node) => Math.max(max, node.position.x + node.width), 0) + 80;
    for (const item of document.projects) {
        if (!item?.project || !Array.isArray(item.project.nodes) || !Array.isArray(item.project.connections) || !Array.isArray(item.files)) throw Error("画布 ZIP 格式不完整");
        const ids = new Map<string, string>(), keys = new Map<string, string>();
        for (const node of item.project.nodes) {
            if (!node || typeof node.id !== "string" || ids.has(node.id) || typeof node.type !== "string" || typeof node.title !== "string" || !node.position || ![node.position.x, node.position.y, node.width, node.height].every(Number.isFinite) || node.width <= 0 || node.height <= 0) throw Error("画布包含无效或重复卡片");
            ids.set(node.id, nanoid());
        }
        for (const file of item.files) {
            const blob = zip.get(file.path);
            if (typeof file.storageKey !== "string" || !/^(image|video|audio|file):/.test(file.storageKey) || keys.has(file.storageKey) || !blob || blob.size !== file.bytes || typeof file.mimeType !== "string") throw Error("画布媒体缺失或文件大小不匹配");
            const key = file.storageKey.split(":")[0] + ":" + nanoid();
            keys.set(file.storageKey, key);
            media.push({ key, blob: blob.slice(0, blob.size, file.mimeType) });
        }
        const remap = (value: unknown, field = ""): unknown => {
            if (field === "storageKey" && typeof value === "string") {
                const key = keys.get(value);
                if (!key) throw Error("卡片引用的媒体未包含在 ZIP 中");
                return key;
            }
            if (nodeReferences.has(field) && typeof value === "string") return ids.get(value);
            if (field === "references" && typeof value === "string" && /^(image|video|audio|file):/.test(value)) {
                const key = keys.get(value);
                if (!key) throw Error("卡片引用的媒体未包含在 ZIP 中");
                return key;
            }
            if (Array.isArray(value)) return value.map(entry => remap(entry, field));
            if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["__proto__", "constructor", "prototype", "videoTaskId", "videoTaskProvider"].includes(key)).map(([key, entry]) => [key, remap(entry, key)]));
            return value;
        };
        const left = item.project.nodes.reduce((min, node) => Math.min(min, node.position.x), Infinity);
        const top = item.project.nodes.reduce((min, node) => Math.min(min, node.position.y), Infinity);
        const imported = item.project.nodes.map(node => {
            const next = remap(node) as CanvasNodeData;
            next.id = ids.get(node.id)!;
            next.position = { x: node.position.x - left + right, y: node.position.y - top };
            if (next.metadata) {
                // A snapshot does not carry a live generation process.
                if (next.metadata.status === "loading") { next.metadata.status = "error"; next.metadata.errorDetails = "导入的任务快照未完成，请重试生成"; }
                if (next.metadata.images) for (const image of next.metadata.images) if (image.status === "loading") { image.status = "error"; image.errorDetails = "导入的任务快照未完成，请重试生成"; }
                if (next.metadata.texts) for (const text of next.metadata.texts) if (text.status === "loading") { text.status = "error"; text.errorDetails = "导入的任务快照未完成，请重试生成"; }
            }
            return next;
        });
        for (const connection of item.project.connections) {
            const fromNodeId = ids.get(connection.fromNodeId), toNodeId = ids.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) throw Error("连线引用了不存在的卡片");
            connections.push({ id: nanoid(), fromNodeId, toNodeId });
        }
        nodes.push(...imported);
        right = imported.reduce((max, node) => Math.max(max, node.position.x + node.width), right) + 80;
    }
    if (!nodes.length) throw Error("ZIP 中没有可导入的卡片");
    return { nodes, connections, media };
}
