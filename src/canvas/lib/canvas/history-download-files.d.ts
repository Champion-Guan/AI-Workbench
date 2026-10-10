import type { CanvasNodeData } from "@/types/canvas";

export type HistoryDownloadFile = {
    id: string;
    imageId?: string;
    node: CanvasNodeData;
    content: string;
    storageKey?: string;
    name: string;
};

export function historyDownloadFiles(nodes: CanvasNodeData[]): HistoryDownloadFile[];
