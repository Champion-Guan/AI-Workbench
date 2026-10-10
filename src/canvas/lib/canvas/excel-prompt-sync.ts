import type { CanvasNodeData } from "@/types/canvas";
import { parseExcelPromptSpec, resolvePromptVariables, type ExcelPromptContext } from "@/components/canvas/nodes/prompt-variables-node";

// Update existing cards in place. No nodes, edges or generated assets are removed.
// undefined means a hidden canvas should defer asking until it becomes active.
export function syncExcelPromptNodes(nodes: CanvasNodeData[], context: ExcelPromptContext, confirmOverwrite: (node: CanvasNodeData) => boolean | undefined) {
    let changed = false;
    const sources = nodes.map((node) => {
        const metadata = node.metadata;
        if (!metadata?.excelPromptKey || metadata.promptVariablePreviewOf) return node;
        const template = context.templates.find((item) => item.id === metadata.excelPromptTemplateId)
            || (context.templates.length === 1 ? context.templates[0] : undefined);
        const raw = template?.prompts[metadata.excelPromptKey];
        // Removed Excel columns must not silently erase existing work.
        if (!raw || raw === metadata.excelPromptRaw || raw === metadata.excelPromptSkippedValue) return node;
        const edited = String(metadata.content ?? metadata.prompt ?? "") !== String(metadata.excelPromptRaw ?? "");
        if (edited) {
            const decision = confirmOverwrite(node);
            if (decision === undefined) return node;
            if (!decision) {
                changed = true;
                return { ...node, metadata: { ...metadata, excelPromptSkippedValue: raw } };
            }
        }
        const spec = parseExcelPromptSpec(metadata.excelPromptKey, raw);
        const parameters = nodes.find((item) => item.id === metadata.excelPromptBindingNodeId);
        changed = true;
        return { ...node, metadata: { ...metadata,
            content: raw, prompt: raw, excelPromptRaw: raw, excelPromptSkippedValue: undefined,
            excelPromptResolved: resolvePromptVariables(raw, parameters?.metadata?.promptVariableValues),
            excelPromptTemplateId: template!.id, excelPromptTokens: spec.tokens,
            excelPromptTheme: spec.theme, excelPromptCompositionLock: spec.compositionLock, excelPromptPurpose: spec.purpose,
        } };
    });
    const next = sources.map((preview) => {
        const metadata = preview.metadata;
        if (!metadata?.promptVariablePreviewOf || !metadata.promptVariableSourceNodeId) return preview;
        const source = sources.find((node) => node.id === metadata.promptVariableSourceNodeId);
        const oldSource = nodes.find((node) => node.id === metadata.promptVariableSourceNodeId);
        const parameters = sources.find((node) => node.id === metadata.promptVariablePreviewOf);
        if (!source || source === oldSource || !parameters || source.metadata?.excelPromptRaw === oldSource?.metadata?.excelPromptRaw) return preview;
        const text = resolvePromptVariables(source.metadata?.excelPromptRaw || "", parameters.metadata?.promptVariableValues);
        changed = true;
        return { ...preview, metadata: { ...metadata, content: text, prompt: text } };
    });
    return changed ? next : nodes;
}
