import type { CanvasConnection, CanvasGenerationMode, CanvasNodeData } from "@/types/canvas";

// Follow final-prompt provenance rather than searching prompt prose: image
// instructions often mention video references without requesting video output.
export function promptGenerationMode(source: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasGenerationMode | undefined {
    const queue = [source];
    const visited = new Set<string>();
    while (queue.length) {
        const node = queue.shift()!;
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        const label = String(node.metadata?.excelPromptLabel || node.title || "");
        if (/视频提示词|(?:最终生成提示图|最终生图提示词)\s*·\s*视频|\bvideo\s*prompt\b/i.test(label)) return "video";
        if (/音频提示词|语音提示词|\baudio\s*prompt\b/i.test(label)) return "audio";
        if (/文本提示词|\btext\s*prompt\b/i.test(label)) return "text";
        if (/主图|详情页|富内容|图片提示词/i.test(label)) return "image";
        const ids = [node.metadata?.promptVariableSourceNodeId, ...connections.filter(edge => edge.toNodeId === node.id).map(edge => edge.fromNodeId)];
        for (const id of ids) {
            const upstream = nodes.find(candidate => candidate.id === id && candidate.type === "text");
            if (upstream) queue.push(upstream);
        }
    }
    return undefined;
}
