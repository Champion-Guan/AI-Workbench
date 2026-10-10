import type { CanvasNodeData } from "@/types/canvas";

export type HistoryMediaInfo = {
    channel: string;
    model: string;
    dimensions: string;
    bytes: number;
    format: string;
};

export function historyMediaInfo(node: CanvasNodeData): HistoryMediaInfo;
