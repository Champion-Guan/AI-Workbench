import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { checkpointLocalStorageWrite, checkpointLocalStorageJsonWrite } from "@/lib/checkpoint-local-storage";
import type { ReactNode, ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Group, Video } from "lucide-react";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";
import { canvasTaskSummary } from "@/lib/canvas/task-summary.js";
import { frontendActivity, observeActivity } from "@/lib/update-activity";
import { runTaskActivity, assertTaskAdmission } from "@/services/task-admission";
import { readZip } from "@/lib/zip";
import { prepareCanvasContentImport } from "@/lib/canvas/canvas-content-import";
import { setImageBlob } from "@/services/image-storage";
import { setMediaBlob } from "@/services/file-storage";
import type { RootScope } from "@/lib/page-drain-barrier";
import { settleActivityGroup } from "@/lib/settle-activity-group";
import { arrangeOverlappingCanvasNodes, placeCanvasNode, placeNewCanvasNodes } from "@/lib/canvas/canvas-node-placement";

import { requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { createVideoGenerationTask, isVideoTaskFailed, storeGeneratedVideo, waitForVideoGenerationTask } from "@/services/api/video";
import { decodeChannelModel, defaultConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { ensureImagePreview, uploadGeneratedImage, uploadImage } from "@/services/image-storage";
import { readDownloadBlob } from "@/services/media-download";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { nanoid } from "nanoid";
import { formatBytes, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { captureVideoFrame, type VideoFramePosition } from "@/lib/canvas/canvas-video-frame";
import { App, Button, Modal, Tooltip } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { buildNodeGenerationContext, buildNodeGenerationInputs, buildNodeResponseMessages, hydrateNodeGenerationContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { CanvasSelectionToolbar } from "@/components/canvas/canvas-selection-toolbar";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasStore, useCanvasSaveStore, flushCanvasPersistence, type CanvasDeletedNodeBatch } from "@/stores/canvas/use-canvas-store";
import { useCanvasUpdateFlush } from "./hooks/use-update-flush";
import { useAgentBridge } from "@/pages/canvas/hooks/use-agent-bridge";
import { usePluginHost } from "@/pages/canvas/hooks/use-plugin-host";
import { buildNodeMentionReferences, getGroupResourceNodes, isCanvasReferenceNode, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { isRecycledCanvas } from '@/lib/canvas/product-recycle-markers.js';
import { applyNodeConfigPatch, audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { promptGenerationMode } from "@/lib/canvas/prompt-generation-mode";
import { applyGroupSelection, applyUngroupSelection, canGroupSelectedNodes, canUngroupSelectedNodes, collectGroupMemberNodes, findContainingGroupId, findGroupDropTarget, getConnectionTargetAnchor, getGroupWrapRect, nodeBounds, normalizeConnection, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import {
    audioExtension,
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    findRetrySourceNode,
    generationReferenceUrls,
    getGenerationCount,
    getInputSummary,
    hasResumableVideoTask,
    hydrateAssistantImages,
    hydrateCanvasImages,
    imageExtension,
    isAudioFile,
    isGenerationCanceled,
    resetInterruptedGeneration,
    resolveMetadataReferences,
    sourceNodeReferenceImages,
} from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasPluginManagerModal } from "@/components/canvas/canvas-plugin-manager-modal";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import { buildPromptVariablesMetadata, promptVariableTokens, PROMPT_VARIABLES_NODE_TYPE, resolvePromptVariables, readExcelPromptContext } from "@/components/canvas/nodes/prompt-variables-node";
import { generatedImageName, numberGeneratedImages } from "@/lib/canvas/generated-image-names";
import { syncExcelPromptNodes } from "@/lib/canvas/excel-prompt-sync";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeImage,
    type CanvasNodeText,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();

function promptGenerationPatch(prompt: string): CanvasNodeMetadata {
    const size = prompt.match(/\b(\d{3,5})\s*[x×]\s*(\d{3,5})\s*px\b/i);
    const ratio = prompt.match(/\b(\d+\s*:\s*\d+)\b/);
    const imageType = prompt.match(/\b(MAIN IMAGE|DETAIL IMAGE|RICH[- ]CONTENT IMAGE|VIDEO FRAME)\b/i)?.[1] || "";
    const normalizedRatio = ratio?.[1]?.replace(/\s+/g, "");
    const pixelSize = size ? `${size[1]}x${size[2]}` : undefined;
    return {
        ...(pixelSize || normalizedRatio ? { size: pixelSize || normalizedRatio } : {}),
        ...(normalizedRatio ? { generationAspectRatio: normalizedRatio } : {}),
        ...(size ? { generationPixelWidth: Number(size[1]), generationPixelHeight: Number(size[2]) } : {}),
        ...(imageType ? { generationImageType: imageType.toLowerCase() } : {}),
        ...(normalizedRatio || size || imageType ? { generationParamsDetected: true } : {}),
    };
}

function imageDimensionsMatch(first: string | undefined, second: string | undefined): boolean {
    if (!first || !second) return false;
    const parse = (value: string) => {
        const match = value.match(/^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i);
        return match ? [Number(match[1]), Number(match[2])] as const : null;
    };
    const firstDimensions = parse(first);
    const secondDimensions = parse(second);
    return Boolean(firstDimensions && secondDimensions && firstDimensions[0] === secondDimensions[0] && firstDimensions[1] === secondDimensions[1]);
}

function imageFormatLabel(mimeType: string | undefined, dataUrl: string | undefined): string {
    const resolvedMimeType = mimeType || dataUrl?.match(/^data:([^;,]+)/i)?.[1] || "";
    if (!resolvedMimeType.startsWith("image/")) return "";
    const format = resolvedMimeType.slice("image/".length).split("+", 1)[0].toLowerCase();
    return format === "jpeg" ? "jpg" : format;
}

function finalPromptPreviewTitle(promptNode?: CanvasNodeData): string {
    const sourceLabel = String(promptNode?.metadata?.excelPromptLabel || promptNode?.title || "").trim();
    if (/主图/.test(sourceLabel)) return "最终生成提示图 · 主图";
    const detail = sourceLabel.match(/详情页提示词\s*0*(\d+)/i);
    if (detail) return `最终生成提示图 · 详情页${String(Number(detail[1])).padStart(2, "0")}`;
    const rich = sourceLabel.match(/富内容提示词\s*0*(\d+)/i);
    if (rich) return `最终生成提示图 · 富内容${String(Number(rich[1])).padStart(2, "0")}`;
    if (/视频提示词/i.test(sourceLabel)) return "最终生成提示图 · 视频";
    return "最终生成提示图";
}

function generatedImageCardTitle(promptNode?: CanvasNodeData): string {
    const sourceLabel = String(promptNode?.metadata?.excelPromptLabel || promptNode?.title || "").trim();
    if (/主图/.test(sourceLabel)) return "主图";
    const detail = sourceLabel.match(/详情页(?:提示词)?\s*0*(\d+)/i);
    if (detail) return `详情页${String(Number(detail[1])).padStart(2, "0")}`;
    const rich = sourceLabel.match(/富内容(?:提示词)?\s*0*(\d+)/i);
    if (rich) return `富内容${String(Number(rich[1])).padStart(2, "0")}`;
    if (/视频提示词/i.test(sourceLabel)) return "视频";
    return "";
}

function findGeneratedImageSourcePrompt(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData | undefined {
    const incoming = connections.filter((connection) => connection.toNodeId === node.id);
    const directPrompt = incoming
        .map((connection) => nodes.find((candidate) => candidate.id === connection.fromNodeId))
        .find((candidate) => candidate?.type === CanvasNodeType.Text);
    if (directPrompt) return directPrompt;
    const configIds = incoming
        .map((connection) => nodes.find((candidate) => candidate.id === connection.fromNodeId))
        .filter((candidate): candidate is CanvasNodeData => candidate?.type === CanvasNodeType.Config)
        .map((candidate) => candidate.id);
    return connections
        .filter((connection) => configIds.includes(connection.toNodeId))
        .map((connection) => nodes.find((candidate) => candidate.id === connection.fromNodeId))
        .find((candidate) => candidate?.type === CanvasNodeType.Text);
}

function renameGeneratedImageNodes(nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData[] {
    return numberGeneratedImages(nodes, (node: CanvasNodeData) => generatedImageCardTitle(findGeneratedImageSourcePrompt(node, nodes, connections)));
}

function isExcelPromptNode(node: CanvasNodeData): boolean {
    if (node.type !== CanvasNodeType.Text) return false;
    if (node.metadata?.promptVariableTranslationOf) return false;
    return Boolean(node.metadata?.excelPromptLabel || node.metadata?.excelPromptKey || node.metadata?.excelPromptRaw || (node.title?.includes("提示词") && !node.title.includes("最终")));
}

function arrangeExcelPromptNodes(nodes: CanvasNodeData[], force = false): CanvasNodeData[] {
    const prompts = nodes.filter(isExcelPromptNode);
    if (prompts.length < 2) return nodes;
    const overlaps = prompts.some((left, leftIndex) => prompts.slice(leftIndex + 1).some((right) =>
        left.position.x < right.position.x + right.width && left.position.x + left.width > right.position.x &&
        left.position.y < right.position.y + right.height && left.position.y + left.height > right.position.y,
    ));
    const previews = nodes.filter((node) => node.metadata?.promptVariablePreviewOf !== undefined && node.metadata?.promptVariableSourceNodeId);
    const previewsNeedLayout = previews.some((preview) => {
        const source = nodes.find((candidate) => candidate.id === preview.metadata?.promptVariableSourceNodeId);
        return source && (Math.abs(preview.position.x - (source.position.x + source.width + 72)) > 2 || Math.abs(preview.position.y - source.position.y) > 2);
    });
    const previewsNeedRename = previews.some((preview) => {
        const source = nodes.find((candidate) => candidate.id === preview.metadata?.promptVariableSourceNodeId);
        return source && preview.title !== finalPromptPreviewTitle(source);
    });
    const translations = nodes.filter((node) => node.metadata?.promptVariableTranslationOf);
    const translationsNeedLayout = translations.some((translation) => {
        const source = nodes.find((candidate) => candidate.id === translation.metadata?.promptVariableTranslationOf);
        return source && (Math.abs(translation.position.x - (source.position.x + source.width + 72)) > 2 || Math.abs(translation.position.y - source.position.y) > 2);
    });
    if (!overlaps && !previewsNeedLayout && !previewsNeedRename && !translationsNeedLayout && !force) return nodes;
    const anchor = prompts[0].position;
    const columns = 1;
    const arranged = nodes.map((node) => {
        const index = prompts.findIndex((prompt) => prompt.id === node.id);
        if (index < 0) return node;
        return { ...node, position: { x: anchor.x, y: anchor.y + index * (node.height + 72) } };
    });
    const withPreviews = arranged.map((node) => {
        if (node.metadata?.promptVariablePreviewOf !== undefined && node.metadata?.promptVariableSourceNodeId) {
            const source = arranged.find((candidate) => candidate.id === node.metadata?.promptVariableSourceNodeId);
            if (source) return { ...node, title: finalPromptPreviewTitle(source), position: { x: source.position.x + source.width + 72, y: source.position.y } };
        }
        return node;
    });
    return arrangeOverlappingCanvasNodes(withPreviews.map((node) => {
        const sourceId = node.metadata?.promptVariableTranslationOf;
        if (!sourceId) return node;
        const source = withPreviews.find((candidate) => candidate.id === sourceId);
        if (!source) return node;
        const siblings = translations.filter((translation) => translation.metadata?.promptVariableTranslationOf === sourceId);
        const index = siblings.findIndex((translation) => translation.id === node.id);
        return { ...node, position: { x: source.position.x + source.width + 72, y: source.position.y + index * (node.height + 72) } };
    }));
}

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
// Stable empty reference array prevents `... || []` from invalidating CanvasNode's React.memo on every render.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const PROMPT_DRAG_DATA_TYPE = "application/x-infinite-canvas-prompt";

function actualImageGenerationMetadata(image: { channel?: string; channelId?: string; model?: string; transport?: "direct" | "proxy"; upstreamSize?: string }) {
    return {
        ...(image.channel ? { channel: image.channel } : {}),
        ...(image.channelId ? { channelId: image.channelId } : {}),
        ...(image.model ? { model: image.model } : {}),
        ...(image.transport ? { transport: image.transport } : {}),
        upstreamSize: image.upstreamSize,
    } satisfies CanvasNodeMetadata;
}

const INHERITED_GENERATION_SETTINGS = ["model", "quality", "moderation", "size", "background", "count", "reasoningEffort", "seconds", "vquality", "generateAudio", "watermark", "videoMode", "audioVoice", "audioFormat", "audioSpeed", "audioInstructions", "generationAspectRatio", "generationPixelWidth", "generationPixelHeight", "generationImageType", "generationParamsDetected", "generationParamsSourceNodeId"] as const;

function generationSettingsFromNode(node: CanvasNodeData | undefined) {
    if (!node) return {};
    return Object.fromEntries(INHERITED_GENERATION_SETTINGS.flatMap((key) => {
        const value = node.metadata?.[key];
        return value === undefined || value === null || value === "" ? [] : [[key, value]];
    }));
}

function generationNodeWithConnectedSettings(node: CanvasNodeData | null | undefined, nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData | undefined {
    if (!node) return undefined;
    const upstream = connections
        .filter((connection) => connection.toNodeId === nodeId)
        .map((connection) => nodes.find((candidate) => candidate.id === connection.fromNodeId))
        .filter((candidate): candidate is CanvasNodeData => Boolean(candidate));
    if (!upstream.length) return node;
    const inherited = upstream.reduce<Record<string, unknown>>((result, candidate) => ({ ...result, ...generationSettingsFromNode(candidate) }), {});
    return Object.keys(inherited).length ? { ...node, metadata: { ...node.metadata, ...inherited } } : node;
}

// A generation-config card is a snapshot of its settings. Once it exists,
// executing or retrying it must not re-read settings from connected prompt
// cards; only prompt text/references remain connected inputs.
function generationNodeForExecution(node: CanvasNodeData | null | undefined, nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData | undefined {
    if (node?.type === CanvasNodeType.Config) return node;
    return generationNodeWithConnectedSettings(node, nodeId, nodes, connections);
}

function applyGeneratedVideo(item: CanvasNodeData, video: UploadedFile, extra: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    const videoSize = fitNodeSize(video.width || item.width, video.height || item.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
    return {
        ...item,
        width: videoSize.width,
        height: videoSize.height,
        position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
        metadata: { ...item.metadata, ...videoMetadata(video), ...extra },
    };
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function InfiniteCanvasPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    // Subscribe to the registry version so plugin registration changes rerender the canvas.
    const nodeRegistryVersion = useNodeRegistryVersion((state) => state.version);
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const projectId = params.id || "";
    const productTitle = searchParams.get("productTitle")?.trim() || "";
    const workbenchProductId = searchParams.get("workbenchProductId") || "";
    const localAgentConnected = useAgentStore((state) => state.connected);
    const localAgentActivity = useAgentStore((state) => state.activity);
    const localAgentEnabled = useAgentStore((state) => state.enabled);
    const fragmentBootstrap = useAgentStore((state) => state.fragmentBootstrap);
    const agentPanelOpen = useAgentStore((state) => state.panelOpen);
    const toggleAgentPanel = useAgentStore((state) => state.togglePanel);
    const openAgentPanel = useAgentStore((state) => state.openPanel);
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const contentInputRef = useRef<HTMLInputElement>(null);
    const contentImportBusyRef = useRef(false);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveReleaseRef = useRef<(() => void) | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        // Keyed by node id so drag frames look positions up in O(1) instead of scanning the array per node.
        initialSelectedNodes: Map<string, { x: number; y: number }>;
        movedIds: Set<string>;
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: new Map(),
        movedIds: new Set(),
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const existingProjectIdByTitle = useCanvasStore((state) => {
        if (!productTitle) return undefined;
        let bestId: string | undefined;
        let bestScore = -1;
        for (const project of state.projects) {
            if (project.title !== productTitle) continue;
            const score = project.nodes.length + project.connections.length;
            if (score > bestScore) {
                bestId = project.id;
                bestScore = score;
            }
        }
        return bestId;
    });
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    useEffect(() => {
        if (!currentProject || window.parent === window) return;
        window.parent.postMessage({ type: "guan-canvas-project-active", projectId: workbenchProductId || projectId, title: currentProject.title }, window.location.origin);
    }, [currentProject?.title, projectId, workbenchProductId]);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodeState] = useState<CanvasNodeData[]>([]);
    const nodesRef = useRef(nodes);
    const nodeTransactionRef = useRef(nodes);
    const setRawNodes = useCallback((next: CanvasNodeData[]) => {
        nodeTransactionRef.current = next;
        nodesRef.current = next;
        setNodeState(next);
    }, []);
    // All creation paths (including plugins and async generation) pass through
    // the same pure transaction. Existing cards and user drag positions stay untouched.
    const setNodes = useCallback((update: CanvasNodeData[] | ((previous: CanvasNodeData[]) => CanvasNodeData[])) => {
        const previous = nodeTransactionRef.current;
        setRawNodes(placeNewCanvasNodes(previous, typeof update === "function" ? update(previous) : update));
    }, [setRawNodes]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);

    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [canvasTool, setCanvasTool] = useState<"select" | "pan">("pan");
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(true);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [projectLoadFailed, setProjectLoadFailed] = useState(false);
    const restoredProjectIdRef = useRef<string | null>(null);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [previewImageId, setPreviewImageId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const saveStatus = useCanvasSaveStore((state) => state.status);
    const [expandedBatchNodeIds, setExpandedBatchNodeIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
    const [referencePickerNodeId, setReferencePickerNodeId] = useState<string | null>(null);

    const revealCreatedNodeRef = useRef<string | null>(null);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const focusAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, parent?: RootScope) => Promise<void>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const videoPollIdsRef = useRef(new Set<string>());

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const completeVideoNodeTask = useCallback(
        async (nodeId: string, config: Parameters<typeof buildGenerationConfig>[0], prompt: string, images: Parameters<typeof createVideoGenerationTask>[2], signal: AbortSignal, extra: CanvasNodeData["metadata"] = {}, videos: ReferenceVideo[] = [], audios: ReferenceAudio[] = []) => {
            return observeActivity("canvas", async () => {
            const task = await createVideoGenerationTask(config, prompt, images, { signal, videos, audios });
            if (task.provider !== "plugin") {
                setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, videoTaskId: task.id, videoTaskProvider: task.provider === "gemini" ? "gemini" : "openai", model: config.model } } : item)));
            }
            const video = await storeGeneratedVideo(await waitForVideoGenerationTask(config, task, { signal }));
            setNodes((prev) => prev.map((item) => (item.id === nodeId ? applyGeneratedVideo(item, video, { prompt, model: config.model, ...extra }) : item)));
        
            });
        },
        [addAsset],
    );

    const pollVideoNodeTask = useCallback(
        async (node: CanvasNodeData, silent = false) => {
            return observeActivity("canvas", async () => {
            const taskId = node.metadata?.videoTaskId;
            if (!taskId || node.metadata?.content || generationRequestsRef.current.has(node.id) || videoPollIdsRef.current.has(node.id)) return;
            videoPollIdsRef.current.add(node.id);
            let controller: AbortController | undefined;
            try {
                const generationConfig = buildGenerationConfig(effectiveConfig, node, "video");
                if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                    if (silent) {
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: t("workbench.configFirst") } } : item)));
                        return;
                    }
                    openConfigDialog(true);
                    return;
                }
                setRunningNodeId(node.id);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
                controller = startGenerationRequest(node.id, node.id, node.id);
                const video = await storeGeneratedVideo(await waitForVideoGenerationTask(generationConfig, { id: taskId, provider: node.metadata?.videoTaskProvider === "gemini" ? "gemini" : "openai", model: generationConfig.model }, { signal: controller.signal }));
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? applyGeneratedVideo(item, video, {
                                  prompt: item.metadata?.prompt,
                                  model: generationConfig.model,
                                  size: generationConfig.size,
                                  seconds: generationConfig.videoSeconds,
                                  vquality: generationConfig.vquality,
                                  generateAudio: generationConfig.videoGenerateAudio,
                                  watermark: generationConfig.videoWatermark,
                                  videoMode: generationConfig.videoMode,
                              })
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.content ? undefined : errorDetails,
                                      ...(isVideoTaskFailed(error) ? { videoTaskId: undefined } : {}),
                                  },
                              }
                            : item,
                    ),
                );
            } finally {
                videoPollIdsRef.current.delete(node.id);
                if (controller) {
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId((current) => (current === node.id ? null : current));
                }
            }
        
            });
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );

    const stopGenerationByRunningId = useCallback((runningId: string) => {
        const affectedNodeIds = new Set<string>();
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId !== runningId) return;
            request.controller.abort();
            generationRequestsRef.current.delete(request.targetNodeId);
            affectedNodeIds.add(request.targetNodeId);
            affectedNodeIds.add(request.originNodeId);
        });
        setRunningNodeId((current) => (current === runningId ? null : current));
        if (!affectedNodeIds.size) return;
        setNodes((prev) =>
            prev.map((node) =>
                affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING
                    ? {
                          ...node,
                          metadata: {
                              ...node.metadata,
                              status: NODE_STATUS_IDLE,
                              errorDetails: undefined,
                              images: node.metadata.images?.map((image) => (image.status === NODE_STATUS_LOADING ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : image)),
                              texts: node.metadata.texts?.map((text) => (text.status === NODE_STATUS_LOADING ? { ...text, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : text)),
                          },
                      }
                    : node,
            ),
        );
    }, [t]);

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: t("canvas.projectPage.stopTitle"),
                content: t("canvas.projectPage.stopDescription"),
                okText: t("canvas.projectPage.stop"),
                cancelText: t("canvas.projectPage.continue"),
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [modal, stopGenerationByRunningId, t],
    );

    useEffect(() => {
        if (!hydrated || isRecycledCanvas(projectId) || searchParams.get('productService') === '1') return;
        // Other cached canvases can change the shared title lookup while a
        // generation is running. A restored route must not hydrate again.
        if (restoredProjectIdRef.current === projectId) return;
        setProjectLoaded(false);
        setProjectLoadFailed(false);
        restoredProjectIdRef.current = null;
        const project = openProject(projectId);
        if (!project) {
            // The host shell uses a stable product id as the initial iframe
            // route, while the canvas store uses its own generated project id.
            // Reuse an already persisted project for this product instead of
            // creating a fresh empty canvas every time the workbook tab changes.
            const workbenchProductId = new URLSearchParams(window.location.search).get("workbenchProductId");
            const workbenchQuery = workbenchProductId ? `${productTitle ? `&` : `?`}workbenchProductId=${encodeURIComponent(workbenchProductId)}` : "";
            if (existingProjectIdByTitle) {
                navigate(`/canvas/${existingProjectIdByTitle}${productTitle ? `?productTitle=${encodeURIComponent(productTitle)}` : ""}${workbenchQuery}`, { replace: true });
                return;
            }
            // Deep links may be opened from another workstation before the
            // local project store has hydrated. Create a local canvas instead
            // of dropping the user back to the project list.
            // Seed only a new product canvas, never when restoring or revisiting it.
            const initialNodes = productTitle || workbenchProductId ? [
                createCanvasNode(PROMPT_VARIABLES_NODE_TYPE, { x: 360, y: 340 }, {
                    ...buildPromptVariablesMetadata(),
                    promptVariableProductName: productTitle || "未命名产品",
                }),
            ] : [];
            const nextId = createProject(productTitle || "未命名产品", initialNodes);
            navigate(`/canvas/${nextId}${productTitle ? `?productTitle=${encodeURIComponent(productTitle)}` : ""}${workbenchQuery}`, { replace: true });
            return;
        }

        let cancelled = false;
        const restore = async () => {
        const restoredNodes = (await hydrateCanvasImages(resetInterruptedGeneration(project.nodes))).filter((node): node is CanvasNodeData => Boolean(node?.id));
        const restoredNodeIds = new Set(restoredNodes.map((node) => node.id));
        const restoredConnections = (project.connections || []).filter((connection) => connection && connection.id && restoredNodeIds.has(connection.fromNodeId) && restoredNodeIds.has(connection.toNodeId));
        const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
        if (cancelled) return;
        // Loading saved canvases must never rearrange the customer's layout.
        setRawNodes(restoredNodes);
            setConnections(restoredConnections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo ?? true);
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: restoredConnections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo ?? true,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            restoredProjectIdRef.current = project.id;
            setProjectLoaded(true);
        };
        void restore().catch(() => {
            if (cancelled) return;
            setProjectLoadFailed(true);
            message.error("画布资源读取失败，已保留原数据。请刷新后重试。");
        });
        return () => { cancelled = true; };
    }, [createProject, existingProjectIdByTitle, hydrated, navigate, openProject, productTitle, projectId]);

    useEffect(() => {
        let customTitle = "";
        try { customTitle = localStorage.getItem(`guan-canvas-title:${workbenchProductId || projectId}`) || ""; } catch { /* Storage may be disabled. */ }
        const title = customTitle || productTitle;
        if (hydrated && currentProject && title && currentProject.title !== title) renameProject(projectId, title);
    }, [hydrated, currentProject, productTitle, projectId, workbenchProductId, renameProject]);

    useEffect(() => {
        if (!projectLoaded) return;
        nodesRef.current.filter(hasResumableVideoTask).forEach((node) => void pollVideoNodeTask(node, true));
        // Resume once after the current canvas is restored, not on later config identity changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectLoaded]);

    useEffect(() => {
        if (!projectLoaded || !["new", "recent", "choose"].includes(searchParams.get("mode") || "")) return;
        if (!searchParams.has("agentUrl") && !localAgentEnabled && !fragmentBootstrap) openAgentPanel();
    }, [fragmentBootstrap, localAgentEnabled, openAgentPanel, projectLoaded, searchParams]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded) return;
        const sync = () => {
            const next = syncExcelPromptNodes(nodesRef.current, readExcelPromptContext(), (node) => {
                const frame = window.frameElement;
                if (document.visibilityState === "hidden" || (frame && (frame as HTMLElement).style.display === "none")) return undefined;
                return window.confirm(`「${node.title || "提示词"}」已在画布中手动修改。是否使用新上传的 Excel 内容覆盖？取消将保留手动内容。`);
            });
            if (next !== nodesRef.current) { nodesRef.current = next; setNodes(next); }
        };
        sync();
        window.addEventListener("guan-excel-prompts-updated", sync);
        window.addEventListener("pointerdown", sync);
        window.addEventListener("focus", sync);
        return () => {
            window.removeEventListener("guan-excel-prompts-updated", sync);
            window.removeEventListener("pointerdown", sync);
            window.removeEventListener("focus", sync);
        };
    }, [projectLoaded]);

    // Repair persisted previews and keep every linked template reactive.
    useEffect(() => {
        if (!projectLoaded) return;
        setNodes((current) => {
            let changed = false;
            const next = current.map((preview) => {
                if (!preview.metadata?.promptVariablePreviewOf || !preview.metadata?.promptVariableSourceNodeId) return preview;
                const source = current.find((node) => node.id === preview.metadata?.promptVariableSourceNodeId);
                const parameters = current.find((node) => node.id === preview.metadata?.promptVariablePreviewOf);
                if (!source || !parameters) return preview;
                const text = resolvePromptVariables(source.metadata?.content ?? source.metadata?.excelPromptRaw ?? source.metadata?.prompt ?? "", parameters.metadata?.promptVariableValues);
                if (preview.metadata.content === text && preview.metadata.prompt === text) return preview;
                changed = true;
                return { ...preview, metadata: { ...preview.metadata, content: text, prompt: text } };
            });
            return changed ? next : current;
        });
    }, [nodes, projectLoaded]);

    // Publish a lightweight aggregate status for the host workspace capsule.
    // The host page is outside React, so localStorage plus a same-window event
    // keeps the indicator responsive without coupling the two applications.
    useEffect(() => {
        if (!projectLoaded || typeof window === "undefined" || !projectId) return;
        const summary = canvasTaskSummary(nodes, connections);
        const { status } = summary;
        // The embedded canvas may redirect from the stable workbook product id
        // to its own persisted canvas project id. Keep the status keyed by the
        // workbook product so the host capsule can always find it.
        const workbenchProductId = new URLSearchParams(window.location.search).get("workbenchProductId") || projectId;
        const key = `guan-canvas-status:${workbenchProductId}`;
        try {
            checkpointLocalStorageJsonWrite(key, { ...summary, updatedAt: Date.now() });
            const detail = { projectId: workbenchProductId, status };
            window.dispatchEvent(new CustomEvent("guan-canvas-status", { detail }));
            if (window.parent && window.parent !== window) window.parent.dispatchEvent(new CustomEvent("guan-canvas-status", { detail }));
        } catch {
            // Storage can be unavailable in private or embedded contexts.
        }
    }, [nodes, connections, projectId, projectLoaded]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current || isNodeDragging || isNodeResizing) return;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectId, projectLoaded, showImageInfo, updateProject, isNodeDragging, isNodeResizing]);

    const updateFlushSnapshot = useMemo(() => ({ projectId, nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, viewport }),
        [projectId, nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, viewport]);
    useCanvasUpdateFlush(updateFlushSnapshot,
        () => projectLoaded && restoredProjectIdRef.current === projectId && !historyPausedRef.current && nodes === nodeTransactionRef.current
            && !dragRef.current.isDraggingNode && !isNodeDragging && !isNodeResizing && focusAnimRef.current === null,
        async (snapshot) => {
            const { projectId: id, ...patch } = snapshot;
            if (restoredProjectIdRef.current !== id || snapshot.nodes !== nodeTransactionRef.current) throw new Error("Canvas commit invalidated");
            if (!useCanvasStore.getState().projects.some(project => project.id === id)) throw new Error("Canvas unavailable");
            updateProject(id, patch);
            await flushCanvasPersistence();
            // The committed snapshot includes the viewport. Cancel a queued
            // viewport write only after this full snapshot was actually saved.
            // Do not cancel a timer scheduled by a newer committed viewport.
            if (viewportRef.current === snapshot.viewport) {
                if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
                viewportSaveTimerRef.current = null;
                viewportSaveReleaseRef.current?.();
                viewportSaveReleaseRef.current = null;
            }
        });

    useEffect(() => {
        const flushForRecycle = (event: Event) => {
            if ((event as CustomEvent).detail?.projectId !== projectId || !projectLoaded) return;
            updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, viewport: viewportRef.current });
        };
        window.addEventListener('guan-product-before-recycle', flushForRecycle);
        return () => window.removeEventListener('guan-product-before-recycle', flushForRecycle);
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        const release = frontendActivity.acquire("storage");
        viewportSaveReleaseRef.current = release;
        viewportSaveTimerRef.current = setTimeout(() => {
            try {
                updateProject(projectId, { viewport: viewportRef.current });
                viewportSaveTimerRef.current = null;
            } finally {
                release();
                if (viewportSaveReleaseRef.current === release) viewportSaveReleaseRef.current = null;
            }
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
            release();
            if (viewportSaveReleaseRef.current === release) viewportSaveReleaseRef.current = null;
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        if (nodes === nodeTransactionRef.current) nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    // Keep persisted/rendered edges referentially valid when a node is removed
    // or replaced. This also removes duplicate edges left by interrupted
    // connection gestures, preventing stale SVG paths from accumulating.
    useEffect(() => {
        const validIds = new Set(nodes.map((node) => node.id));
        setConnections((current) => {
            const seen = new Set<string>();
            const next = current.filter((connection) => {
                if (!connection?.id || !validIds.has(connection.fromNodeId) || !validIds.has(connection.toNodeId)) return false;
                const pair = `${connection.fromNodeId}\u0000${connection.toNodeId}`;
                if (seen.has(pair)) return false;
                seen.add(pair);
                return true;
            });
            return next.length === current.length ? current : next;
        });
    }, [nodes]);

    useEffect(() => {
        if (!projectLoaded) return;
        const nodeIds = new Set(nodes.map((node) => node.id));
        const validConnections = connections.filter((connection) => connection && connection.id && nodeIds.has(connection.fromNodeId) && nodeIds.has(connection.toNodeId));
        if (validConnections.length !== connections.length) {
            setConnections(validConnections);
            return;
        }
        const missingPreviewConnections = nodes.flatMap((preview) => {
            const sourceId = preview.metadata?.promptVariableSourceNodeId;
            const adaptiveId = preview.metadata?.promptVariablePreviewOf;
            if (!sourceId || !adaptiveId || !nodeIds.has(sourceId) || !nodeIds.has(adaptiveId) || preview.type !== CanvasNodeType.Text) return [];
            if (connections.some((connection) => connection.fromNodeId === sourceId && connection.toNodeId === preview.id)) return [];
            return [{ id: `conn-${sourceId}-${preview.id}`, fromNodeId: sourceId, toNodeId: preview.id }];
        });
        if (!missingPreviewConnections.length) return;
        setConnections((current) => {
            const additions = missingPreviewConnections.filter((candidate) => !current.some((connection) => connection.fromNodeId === candidate.fromNodeId && connection.toNodeId === candidate.toNodeId));
            if (!additions.length) return current;
            return [...current, ...additions];
        });
    }, [connections, nodes, projectLoaded]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        if (!projectLoaded) return;
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                if (!nodeTransactionRef.current.length && viewportRef.current.x === 0 && viewportRef.current.y === 0) setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, [projectLoaded]);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                let nextNodes = nodesRef.current.filter((node): node is CanvasNodeData => Boolean(node?.id));
                const adaptiveNode = nextNodes.find((node) => node.id === fromNodeId && node.type === PROMPT_VARIABLES_NODE_TYPE) || nextNodes.find((node) => node.id === toNodeId && node.type === PROMPT_VARIABLES_NODE_TYPE);
                const promptNode = nextNodes.find((node) => node.id === fromNodeId && node.type === CanvasNodeType.Text) || nextNodes.find((node) => node.id === toNodeId && node.type === CanvasNodeType.Text);
                const configNode = nextNodes.find((node) => node.id === fromNodeId && node.type === CanvasNodeType.Config) || nextNodes.find((node) => node.id === toNodeId && node.type === CanvasNodeType.Config);
                if (promptNode && configNode) {
                    const rawPrompt = (promptNode.metadata?.content || promptNode.metadata?.prompt || "").trim();
                    const generationPatch = promptGenerationPatch(rawPrompt);
                    const mode = promptGenerationMode(promptNode, nextNodes, connectionsRef.current);
                    if (mode) {
                        generationPatch.generationMode = mode;
                        if (mode !== (configNode.metadata?.generationMode || "image")) {
                            generationPatch.model = mode === "video" ? effectiveConfig.videoModel : mode === "audio" ? effectiveConfig.audioModel : mode === "text" ? effectiveConfig.textModel : effectiveConfig.imageModel;
                        }
                    }
                    if (mode || generationPatch.generationParamsDetected) {
                        nextNodes = nextNodes.map((node) => node.id === configNode.id ? { ...node, metadata: { ...node.metadata, ...generationPatch, generationParamsSourceNodeId: promptNode.id } } : node);
                    }
                }
                if (adaptiveNode && promptNode) {
                    const rawPrompt = (promptNode.metadata?.content || promptNode.metadata?.prompt || "").trim();
                    const tokens = promptVariableTokens(rawPrompt);
                    const values = { ...adaptiveNode.metadata?.promptVariableValues, ...Object.fromEntries(tokens.map((token) => [token, adaptiveNode.metadata?.promptVariableValues?.[token] || ""])) };
                    const resolvedPrompt = resolvePromptVariables(rawPrompt, values);
                    const preview = nextNodes.find((node) => node.metadata?.promptVariablePreviewOf === adaptiveNode.id && node.metadata?.promptVariableSourceNodeId === promptNode.id);
                    const adaptiveMetadata: CanvasNodeMetadata = {
                        ...adaptiveNode.metadata,
                        status: "success",
                        promptVariableRawPrompt: rawPrompt,
                        promptVariableResolvedPrompt: resolvedPrompt,
                        promptVariableTokens: tokens,
                        promptVariableValues: values,
                        promptVariableSourceNodeId: promptNode.id,
                        promptVariablePreviewNodeId: preview?.id,
                    };
                    const promptMetadata: CanvasNodeMetadata = {
                        ...promptNode.metadata,
                        excelPromptRaw: promptNode.metadata?.excelPromptRaw || rawPrompt,
                        excelPromptResolved: resolvedPrompt,
                        excelPromptBindingNodeId: adaptiveNode.id,
                        excelPromptTokens: promptNode.metadata?.excelPromptTokens?.length ? promptNode.metadata.excelPromptTokens : tokens,
                    };
                    if (preview) {
                        nextNodes = nextNodes.map((node) => {
                            if (node.id === adaptiveNode.id) return { ...node, metadata: adaptiveMetadata };
                            if (node.id === promptNode.id) return { ...node, metadata: promptMetadata };
                            if (node.id === preview.id) return { ...node, title: finalPromptPreviewTitle(promptNode), metadata: { ...node.metadata, content: resolvedPrompt, prompt: resolvedPrompt, status: NODE_STATUS_SUCCESS } };
                            return node;
                        });
                    } else {
                        const previewNode = {
                            ...createCanvasNode(
                                CanvasNodeType.Text,
                                { x: promptNode.position.x + promptNode.width + 96 + getNodeSpec(CanvasNodeType.Text).width / 2, y: promptNode.position.y + getNodeSpec(CanvasNodeType.Text).height / 2 },
                                { content: resolvedPrompt, prompt: resolvedPrompt, status: NODE_STATUS_SUCCESS },
                            ),
                            title: finalPromptPreviewTitle(promptNode),
                            metadata: {
                                content: resolvedPrompt,
                                prompt: resolvedPrompt,
                                status: NODE_STATUS_SUCCESS,
                                promptVariablePreviewOf: adaptiveNode.id,
                                promptVariableSourceNodeId: promptNode.id,
                            },
                        };
                        nextNodes = [...nextNodes.map((node) => {
                            if (node.id === adaptiveNode.id) return { ...node, metadata: { ...adaptiveMetadata, promptVariablePreviewNodeId: previewNode.id } };
                            if (node.id === promptNode.id) return { ...node, metadata: promptMetadata };
                            return node;
                        }), previewNode];
                    }
                    nodesRef.current = nextNodes;
                    setNodes(nextNodes);
                }
                if (configNode && promptNode && !adaptiveNode) {
                    nodesRef.current = nextNodes;
                    setNodes(nextNodes);
                }
                setConnections((prev) => {
                    const safePrev = prev.filter((conn) => Boolean(conn?.id && conn.fromNodeId && conn.toNodeId));
                    const next = safePrev.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId) ? safePrev : [...safePrev, { id: nanoid(), fromNodeId, toNodeId }];
                    const preview = nodesRef.current.find((node) => node.metadata?.promptVariablePreviewOf === adaptiveNode?.id && node.metadata?.promptVariableSourceNodeId === promptNode?.id);
                    if (preview && promptNode && !next.some((conn) => conn.fromNodeId === promptNode.id && conn.toNodeId === preview.id)) {
                        return [...next, { id: nanoid(), fromNodeId: promptNode.id, toNodeId: preview.id }];
                    }
                    return next;
                });
            }
            setContextMenu(null);
        },
        [effectiveConfig.videoModel, effectiveConfig.audioModel, effectiveConfig.textModel, effectiveConfig.imageModel, message, t],
    );

    useEffect(() => {
        const arrangeImportedPrompts = (delay: number) => {
            window.setTimeout(() => {
                const current = nodesRef.current.filter((node): node is CanvasNodeData => Boolean(node?.id));
                const adaptive = current.find((node) => node.type === PROMPT_VARIABLES_NODE_TYPE);
                if (!adaptive) return;
                const promptNodes = current.filter(isExcelPromptNode);
                if (promptNodes.length > 1) {
                    const arranged = arrangeExcelPromptNodes(current);
                    nodesRef.current = arranged;
                    setNodes(arranged);
                    const nodeIds = new Set(arranged.map((node) => node.id));
                    const validConnections = connectionsRef.current.filter((connection) => nodeIds.has(connection.fromNodeId) && nodeIds.has(connection.toNodeId));
                    connectionsRef.current = validConnections;
                    setConnections(validConnections);
                }
                promptNodes.filter((node) => !node.metadata?.excelPromptBindingNodeId).forEach((prompt) => {
                    connectNodes({ nodeId: adaptive.id, handleType: "source" }, prompt.id);
                });
            }, delay);
        };
        const handleBatchImport = () => {
            // Excel state arrives in several React commits. Re-check a few frames
            // later so same-count updates and delayed preview cards are included.
            [80, 350, 800].forEach(arrangeImportedPrompts);
        };
        // The prompt library emits this event after Excel data has been parsed and
        // cards are inserted. A slightly longer delay lets React finish the card
        // insertion before we calculate the row layout.
        window.addEventListener("guan-excel-batch-imported", handleBatchImport);
        return () => {
            window.removeEventListener("guan-excel-batch-imported", handleBatchImport);
        };
    }, [connectNodes]);

    useEffect(() => {
        if (nodes.length < 2) return;
        // Do not re-layout on every node-count change: that used to overwrite
        // manually moved previews and undo the overlap organizer.
        const arranged = nodesRef.current.map((node) => {
            const sourceId = node.metadata?.promptVariableSourceNodeId;
            const source = sourceId && nodesRef.current.find((candidate) => candidate.id === sourceId);
            return node.metadata?.promptVariablePreviewOf && source && node.title !== finalPromptPreviewTitle(source) ? { ...node, title: finalPromptPreviewTitle(source) } : node;
        });
        const renamed = renameGeneratedImageNodes(arranged, connectionsRef.current);
        if (renamed !== nodesRef.current) {
            nodesRef.current = renamed;
            setNodes(renamed);
            const nodeIds = new Set(renamed.map((node) => node.id));
            const validConnections = connectionsRef.current.filter((connection) => nodeIds.has(connection.fromNodeId) && nodeIds.has(connection.toNodeId));
            connectionsRef.current = validConnections;
            setConnections(validConnections);
        }
    }, [nodes.length, connections.length]);

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count) } : undefined;
            const source = nodesRef.current.find(node => node.id === pending.connection.nodeId);
            const mode = type === CanvasNodeType.Config && source ? promptGenerationMode(source, nodesRef.current, connectionsRef.current) : undefined;
            const newNode = createCanvasNode(type, pending.position, { ...metadata, ...(mode ? { generationMode: mode, model: mode === "video" ? effectiveConfig.videoModel : mode === "audio" ? effectiveConfig.audioModel : mode === "text" ? effectiveConfig.textModel : effectiveConfig.imageModel } : {}) });
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.videoModel, effectiveConfig.audioModel, effectiveConfig.textModel, effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            [...nodesRef.current]
                .reverse()
                .forEach((node) => {
                    const anchor = getConnectionTargetAnchor(node, current);
                    const dx = world.x - anchor.x;
                    const dy = world.y - anchor.y;
                    const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                    const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                    const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                    if (!hitsHandle && !hitsInside && !hitsExpanded) return;
                    isNearNode = true;
                    if (node.id === current.nodeId || !normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)) return;

                    const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                    if (priority < bestPriority) {
                        bestNodeId = node.id;
                        bestPriority = priority;
                    }
                });

            return { nodeId: bestNodeId, isNearNode };
        },
        [screenToCanvas],
    );

    const viewBounds = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const left = -viewport.x / viewport.k - padding;
        const top = -viewport.y / viewport.k - padding;
        return { left, top, right: left + width / viewport.k + padding * 2, bottom: top + height / viewport.k + padding * 2 };
        // `nodes` keeps the container rect re-read on node changes, matching the previous behaviour when the container resizes without a size update.
    }, [nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const visibleNodes = useMemo(
        () => nodes.filter((node) => node.position.x + node.width > viewBounds.left && node.position.x < viewBounds.right && node.position.y + node.height > viewBounds.top && node.position.y < viewBounds.bottom),
        [nodes, viewBounds],
    );

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

    // Connections are culled like nodes; a cubic curve stays inside its control-point hull, so endpoint bounds widened by the curvature is a safe test.
    const visibleConnections = useMemo(
        () => {
            const seenPairs = new Set<string>();
            return connections.flatMap((connection) => {
                const from = nodeById.get(connection.fromNodeId);
                const to = nodeById.get(connection.toNodeId);
                if (!from || !to) return [];
                const pair = `${connection.fromNodeId}\u0000${connection.toNodeId}`;
                if (seenPairs.has(pair)) return [];
                seenPairs.add(pair);
                const startX = from.position.x + from.width;
                const startY = from.position.y + from.height / 2;
                const endX = to.position.x;
                const endY = to.position.y + to.height / 2;
                const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
                const inView =
                    Math.max(startX + curvature, endX) > viewBounds.left && Math.min(startX, endX - curvature) < viewBounds.right && Math.max(startY, endY) > viewBounds.top && Math.min(startY, endY) < viewBounds.bottom;
                return inView ? [{ connection, from, to }] : [];
            });
        },
        [connections, nodeById, viewBounds],
    );
    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const contextMenuNode = contextMenu?.type === "node" ? nodeById.get(contextMenu.nodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const previewImage = previewImageId ? previewNode?.metadata?.images?.find((image) => image.id === previewImageId) : null;
    const previewContent = previewImage?.content || previewNode?.metadata?.content;
    const previewMetadata = previewNode?.metadata;
    const previewOriginal = (previewImage || previewMetadata)?.originalImage;
    const previewDeliveryNote = (previewImage || previewMetadata)?.deliveryNote;
    const previewSource = previewMetadata?.generationType === "edit" ? t("canvas.projectPage.imageEdit") : previewMetadata?.generationType === "generation" ? t("canvas.projectPage.imageGeneration") : t("canvas.projectPage.canvasImageSource");
    const previewImageType = previewMetadata?.generationImageType || previewMetadata?.generationType || t("canvas.projectPage.none");
    const previewWidth = previewImage?.naturalWidth || previewMetadata?.naturalWidth;
    const previewHeight = previewImage?.naturalHeight || previewMetadata?.naturalHeight;
    const previewSize = previewWidth && previewHeight ? `${previewWidth} × ${previewHeight}` : t("canvas.projectPage.none");
    const previewBytes = previewImage
        ? previewImage.bytes || getDataUrlByteSize(previewImage.content)
        : previewMetadata?.bytes || (previewContent?.startsWith("data:") ? getDataUrlByteSize(previewContent) : 0);
    const previewBackground = previewMetadata?.background === "transparent" ? t("canvas.projectPage.transparent") : previewMetadata?.background ? previewMetadata.background : t("canvas.projectPage.none");
    const previewResponseSize = previewOriginal ? `${previewOriginal.width}x${previewOriginal.height}` : previewSize.replace(/\s*×\s*/g, "x");
    const previewRequestedSize = previewMetadata?.size || t("canvas.projectPage.none");
    const requestedAndActualSizeMatch = imageDimensionsMatch(previewMetadata?.size, previewResponseSize);
    const previewImageFormat = imageFormatLabel(previewImage?.mimeType || previewMetadata?.mimeType || previewOriginal?.mimeType, previewContent);
    const previewModeration = previewMetadata?.moderation || (/gpt-image/i.test(previewMetadata?.model || "") ? "auto" : "");
    const previewRows: Array<[string, ReactNode]> = [
        [t("canvas.projectPage.imageGenerationSource"), previewSource],
        [t("canvas.projectPage.imageChannel"), previewMetadata?.channel || t("canvas.projectPage.none")],
        [t("canvas.projectPage.imageModel"), previewMetadata?.model ? decodeChannelModel(previewMetadata.model)?.model || previewMetadata.model : t("canvas.projectPage.none")],
        [t("canvas.projectPage.imageType"), previewImageType],
        ["尺寸", <span className="guan-image-detail-size" style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 5 }}>
            {requestedAndActualSizeMatch ? <span>{previewResponseSize}</span> : <>
                <span title="请求尺寸：客户设置的目标图片尺寸">{previewRequestedSize}</span>
                <span aria-hidden="true" style={{ color: "#bfbfbf" }}>|</span>
                <Tooltip title={previewOriginal || previewMetadata?.generationType ? "API 实际响应值：上游返回原图的真实尺寸" : "实际图片尺寸"}>
                    <span style={{ background: "#fff3bf", color: "#925900", borderRadius: 4, padding: "1px 4px", fontWeight: 600 }}>{previewResponseSize}</span>
                </Tooltip>
            </>}
        </span>],
        ...(previewMetadata?.upstreamSize ? [["上游请求尺寸", previewMetadata.upstreamSize] as [string, ReactNode]] : []),
        ...(previewOriginal ? [["最终图片尺寸", previewSize] as [string, ReactNode]] : []),
        ...(previewDeliveryNote ? [["尺寸处理", previewDeliveryNote] as [string, ReactNode]] : []),
    ];
    const previewGridRows: Array<[string, ReactNode]> = [
        ["图片格式", previewImageFormat || t("canvas.projectPage.none")],
        ["文件大小", formatBytes(previewBytes) || t("canvas.projectPage.none")],
        ["审核", previewModeration || t("canvas.projectPage.none")],
        [t("canvas.projectPage.imageQuality"), previewMetadata?.quality || t("canvas.projectPage.none")],
        [t("canvas.projectPage.imageCount"), previewMetadata?.count != null ? String(previewMetadata.count) : t("canvas.projectPage.none")],
        [t("canvas.projectPage.imageBackground"), previewBackground],
    ];
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const selectedNodes = useMemo(() => nodes.filter((node) => selectedNodeIds.has(node.id)), [nodes, selectedNodeIds]);
    const canGroupSelection = canGroupSelectedNodes(selectedNodeIds, nodes);
    const canUngroupSelection = canUngroupSelectedNodes(selectedNodeIds, nodes);
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId) map.set(groupId, (map.get(groupId) || 0) + 1);
        });
        return map;
    }, [nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        const addNode = (nodeId: string) => {
            nodeIds.add(nodeId);
            if (nodeById.get(nodeId)?.type === CanvasNodeType.Group) nodes.forEach((node) => node.metadata?.groupId === nodeId && nodeIds.add(node.id));
        };
        addNode(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            addNode(connection.fromNodeId);
            addNode(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections, nodeById, nodes]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildNodeMentionReferences>>();
        nodes.forEach((node) => map.set(node.id, buildNodeMentionReferences(node, nodes, connections)));
        return map;
    }, [connections, nodes]);
    const connectedNodesByNodeId = useMemo(() => {
        const map = new Map<string, CanvasNodeData[]>();
        connections.forEach((connection) => {
            if (!connection?.id || !nodeById.has(connection.toNodeId)) return;
            const source = nodeById.get(connection.fromNodeId);
            if (!source) return;
            const connected = map.get(connection.toNodeId);
            if (connected) connected.push(source);
            else map.set(connection.toNodeId, [source]);
        });
        return map;
    }, [connections, nodeById]);
    const referenceConnectedNodeIds = useMemo(() => new Set([referencePickerNodeId, ...(referencePickerNodeId ? connectedNodesByNodeId.get(referencePickerNodeId)?.flatMap((node) => node.type === CanvasNodeType.Group ? [node.id, ...getGroupResourceNodes(node.id, nodes).map((child) => child.id)] : [node.id]) || [] : [])].filter((id): id is string => Boolean(id))), [connectedNodesByNodeId, nodes, referencePickerNodeId]);
    const { applyAgentOps } = useAgentBridge({
        projectId,
        title: currentProject?.title,
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
    });

    const { pluginHost, renderPluginPanel, buildNodeToolbarItems } = usePluginHost({
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        theme,
        nodesRef,
        connectionsRef,
        viewportRef,
        setNodes,
        setDialogNodeId,
        applyAgentOps,
    });
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : undefined;
            const promptVariablesMetadata = type === PROMPT_VARIABLES_NODE_TYPE ? buildPromptVariablesMetadata() : undefined;
            const currentViewport = viewportRef.current;
            const newNode = placeCanvasNode(createCanvasNode(type, targetPosition, { ...configMetadata, ...promptVariablesMetadata }), nodesRef.current, position ? undefined : {
                x: (24 - currentViewport.x) / currentViewport.k,
                y: (80 - currentViewport.y) / currentViewport.k,
                width: (size.width - 48) / currentViewport.k,
                height: (size.height - 190) / currentViewport.k,
            });
            revealCreatedNodeRef.current = newNode.id;

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // Display-only plugin nodes with hidePanel do not open a panel; custom Panels require autoOpenPanel on creation.
            // Plugin nodes declaring useBuiltinPanel open the built-in generation panel on creation, like image nodes.
            // Built-in image, video, and config nodes retain their existing open-on-create behavior.
            const wantsPanel = definition?.hidePanel
                ? false
                : definition?.Panel
                  ? Boolean(definition.autoOpenPanel)
                  : definition?.useBuiltinPanel
                    ? true
                    : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Group;
            if (wantsPanel) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter, size.width, size.height],
    );

    useLayoutEffect(() => {
        const id = revealCreatedNodeRef.current;
        if (!id) return;
        const node = nodes.find((candidate) => candidate.id === id);
        if (!node) return;
        revealCreatedNodeRef.current = null;
        const view = viewportRef.current;
        const left = node.position.x * view.k + view.x;
        const top = node.position.y * view.k + view.y;
        if (left < 24 || top < 64 || left + node.width * view.k > size.width - 32 || top + node.height * view.k > size.height - 100) {
            // Only explicit user creation reveals the card. Background tasks never pan.
            setViewport({ ...view, x: size.width / 2 - (node.position.x + node.width / 2) * view.k, y: size.height / 2 - (node.position.y + node.height / 2) * view.k });
        }
    }, [nodes, size.width, size.height]);

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            for (const node of nodesRef.current) {
                if (node.metadata?.promptVariablePreviewOf && node.metadata?.promptVariableSourceNodeId && allIds.has(node.metadata.promptVariableSourceNodeId)) allIds.add(node.id);
            }
            const deletedNodes = nodesRef.current.filter((node) => allIds.has(node.id));
            const deletedConnections = connectionsRef.current.filter((connection) => allIds.has(connection.fromNodeId) || allIds.has(connection.toNodeId));
            const relatedNodes = nodesRef.current.filter((node) => !allIds.has(node.id) && ((node.metadata?.promptVariableSourceNodeId && allIds.has(node.metadata.promptVariableSourceNodeId)) || (node.metadata?.groupId && allIds.has(node.metadata.groupId))));
            const storedProject = useCanvasStore.getState().projects.find((project) => project.id === projectId);
            if (storedProject && deletedNodes.length) {
                const deletedIds = new Set(deletedNodes.map((node) => node.id));
                const deletedNodeBatches = (storedProject.deletedNodeBatches || []).filter((batch) => !batch.nodes.some((node) => deletedIds.has(node.id)));
                updateProject(projectId, {
                    deletedNodeBatches: [...deletedNodeBatches, { id: nanoid(), nodes: deletedNodes, connections: deletedConnections, relatedNodes, deletedAt: new Date().toISOString() }],
                });
            }
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    if (node.metadata?.promptVariableSourceNodeId && allIds.has(node.metadata.promptVariableSourceNodeId)) return { ...node, metadata: { ...node.metadata, promptVariableSourceNodeId: undefined, promptVariablePreviewNodeId: undefined, promptVariableRawPrompt: "", promptVariableResolvedPrompt: "" } };
                    const groupId = node.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    return node;
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setReferencePickerNodeId((current) => (current && allIds.has(current) ? null : current));
            setExpandedBatchNodeIds((current) => new Set([...current].filter((nodeId) => !allIds.has(nodeId))));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId, updateProject],
    );

    const restoreDeletedNodeBatch = useCallback((batchId: string) => {
        const storedProject = useCanvasStore.getState().projects.find((project) => project.id === projectId);
        const batch = storedProject?.deletedNodeBatches?.find((item) => item.id === batchId);
        if (!storedProject || !batch) return;

        const currentNodeIds = new Set(nodesRef.current.map((node) => node.id));
        const restoredNodes = batch.nodes.filter((node) => !currentNodeIds.has(node.id));
        const availableNodeIds = new Set([...currentNodeIds, ...restoredNodes.map((node) => node.id)]);
        const currentConnectionIds = new Set(connectionsRef.current.map((connection) => connection.id));
        const restoredConnections = batch.connections.filter((connection) => availableNodeIds.has(connection.fromNodeId) && availableNodeIds.has(connection.toNodeId) && !currentConnectionIds.has(connection.id));
        const snapshots = new Map((batch.relatedNodes || []).map((node) => [node.id, node]));
        const relationKeys = ["groupId", "promptVariableSourceNodeId", "promptVariablePreviewNodeId", "promptVariableRawPrompt", "promptVariableResolvedPrompt"] as const;

        setNodes((previous) => {
            const existing = new Set(previous.map((node) => node.id));
            const next = previous.map((node) => {
                const snapshot = snapshots.get(node.id);
                if (!snapshot) return node;
                const metadata = { ...node.metadata };
                let changed = false;
                for (const key of relationKeys) {
                    const currentValue = metadata[key];
                    const snapshotValue = snapshot.metadata?.[key];
                    const isCleared = currentValue === undefined || ((key === "promptVariableRawPrompt" || key === "promptVariableResolvedPrompt") && currentValue === "");
                    if (isCleared && snapshotValue !== undefined && currentValue !== snapshotValue) {
                        metadata[key] = snapshotValue;
                        changed = true;
                    }
                }
                return changed ? { ...node, metadata } : node;
            });
            return [...next, ...restoredNodes.filter((node) => !existing.has(node.id))];
        });
        setConnections((previous) => {
            const existing = new Set(previous.map((connection) => connection.id));
            return [...previous, ...restoredConnections.filter((connection) => !existing.has(connection.id))];
        });
        updateProject(projectId, { deletedNodeBatches: (storedProject.deletedNodeBatches || []).filter((item) => item.id !== batchId) });
    }, [projectId, updateProject]);

    const permanentlyDeleteNodeBatch = useCallback((batchId: string) => {
        const storedProject = useCanvasStore.getState().projects.find((project) => project.id === projectId);
        const batch = storedProject?.deletedNodeBatches?.find((item) => item.id === batchId);
        if (!storedProject || !batch) return;

        const activeNodeIds = new Set(nodesRef.current.map((node) => node.id));
        const removedIds = new Set(batch.nodes.filter((node) => !activeNodeIds.has(node.id)).map((node) => node.id));
        const withoutRemovedNodes = (entry: CanvasHistoryEntry): CanvasHistoryEntry => ({
            ...entry,
            nodes: entry.nodes.filter((node) => !removedIds.has(node.id)),
            connections: entry.connections.filter((connection) => !removedIds.has(connection.fromNodeId) && !removedIds.has(connection.toNodeId)),
        });
        if (removedIds.size) {
            historyRef.current.past = historyRef.current.past.map(withoutRemovedNodes);
            historyRef.current.future = historyRef.current.future.map(withoutRemovedNodes);
            if (lastHistoryRef.current) lastHistoryRef.current = withoutRemovedNodes(lastHistoryRef.current);
        }
        const remainingBatches = (storedProject.deletedNodeBatches || []).filter((item) => item.id !== batchId);
        updateProject(projectId, { deletedNodeBatches: remainingBatches });
        cleanupCanvasFiles({ deletedNodeBatches: remainingBatches });
    }, [cleanupCanvasFiles, projectId, updateProject]);

    const groupSelection = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        const members = collectGroupMemberNodes(selectedIds, nodesRef.current);
        if (members.length < 2) return;
        const rect = getGroupWrapRect(members);
        const created = createCanvasNode(CanvasNodeType.Group, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        const result = applyGroupSelection(selectedIds, nodesRef.current, connectionsRef.current, { ...created, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height });
        if (!result) return;
        setNodes(result.nodes);
        setConnections(result.connections);
        setSelectedNodeIds(new Set(result.selectedIds));
        setSelectedConnectionId(null);
        setToolbarNodeId(result.selectedIds[0] || null);
        setDialogNodeId(null);
        setContextMenu(null);
    }, []);

    const ungroupSelection = useCallback((ids?: Set<string>) => {
        const result = applyUngroupSelection(ids || selectedNodeIdsRef.current, nodesRef.current, connectionsRef.current);
        if (!result) return;
        setNodes(result.nodes);
        setConnections(result.connections);
        setSelectedNodeIds(new Set(result.selectedIds));
        setSelectedConnectionId(null);
        setToolbarNodeId(result.selectedIds.length === 1 ? result.selectedIds[0] : null);
        setDialogNodeId(null);
        setContextMenu(null);
    }, []);

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    const disconnectNodeReference = useCallback((fromNodeId: string, toNodeId: string) => {
        setConnections((prev) => prev.filter((connection) => connection.fromNodeId !== fromNodeId || connection.toNodeId !== toNodeId));
    }, []);

    const startNodeReferenceSelection = useCallback((nodeId: string) => {
        setReferencePickerNodeId(nodeId);
        setSelectedNodeIds(new Set([nodeId]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    const exitNodeReferenceSelection = useCallback(() => {
        if (!referencePickerNodeId) return;
        setSelectedNodeIds(new Set([referencePickerNodeId]));
        setDialogNodeId(referencePickerNodeId);
        setReferencePickerNodeId(null);
    }, [referencePickerNodeId]);

    const selectNodeReference = useCallback((fromNodeId: string) => {
        if (!referencePickerNodeId || referenceConnectedNodeIds.has(fromNodeId)) return;
        const source = nodesRef.current.find((node) => node.id === fromNodeId);
        if (!source || !isCanvasReferenceNode(source, nodesRef.current)) return;
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId, toNodeId: referencePickerNodeId }]);
    }, [referenceConnectedNodeIds, referencePickerNodeId]);

    const useImageAsGlobalReference = useCallback((imageNode: CanvasNodeData) => {
        if (imageNode.type !== CanvasNodeType.Image || !imageNode.metadata?.content) return;
        const configIds = nodesRef.current.filter((node) => node.type === CanvasNodeType.Config).map((node) => node.id);
        if (!configIds.length) {
            message.info("画布上暂时没有生成配置卡片");
            return;
        }
        const existing = new Set(connectionsRef.current.filter((connection) => connection.fromNodeId === imageNode.id).map((connection) => connection.toNodeId));
        const additions = configIds.filter((configId) => !existing.has(configId)).map((configId) => ({ id: nanoid(), fromNodeId: imageNode.id, toNodeId: configId }));
        if (!additions.length) {
            message.info("该图片已经连接到所有生成配置卡片");
            return;
        }
        const nextConnections = [...connectionsRef.current, ...additions];
        connectionsRef.current = nextConnections;
        setConnections(nextConnections);
        message.success(`已将图片连接到 ${additions.length} 个生成配置卡片`);
    }, [message]);

    useEffect(() => {
        if (!referencePickerNodeId) return;
        const exit = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            exitNodeReferenceSelection();
        };
        window.addEventListener("keydown", exit, true);
        return () => window.removeEventListener("keydown", exit, true);
    }, [exitNodeReferenceSelection, referencePickerNodeId]);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        deleteNodes(new Set(nodesRef.current.map((node) => node.id)));
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
    }, [deleteNodes, deselectCanvas]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        if (!nodesRef.current.length) {
            setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
            setContextMenu(null);
            return;
        }
        const padding = 80;
        const left = Math.min(...nodesRef.current.map((node) => node.position.x));
        const top = Math.min(...nodesRef.current.map((node) => node.position.y));
        const right = Math.max(...nodesRef.current.map((node) => node.position.x + (node.width || 240)));
        const bottom = Math.max(...nodesRef.current.map((node) => node.position.y + (node.height || 160)));
        const k = Math.min(Math.max(Math.min((size.width - padding * 2) / Math.max(right - left, 1), (size.height - padding * 2) / Math.max(bottom - top, 1)), 0.05), 1);
        setViewport({ x: size.width / 2 - ((left + right) / 2) * k, y: size.height / 2 - ((top + bottom) / 2) * k, k });
        setContextMenu(null);
    }, [size.height, size.width]);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const worldX = node.position.x + node.width / 2;
            const worldY = node.position.y + node.height / 2;
            const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height), 0.05), 1);
            const target = { x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k };
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);

            if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
            const start = { ...viewportRef.current };
            const duration = 450;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const progress = Math.min((now - startTime) / duration, 1);
                const t = easeOutCubic(progress);
                setViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t });
                focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
            };
            focusAnimRef.current = requestAnimationFrame(step);
        },
        [size.height, size.width],
    );

    useEffect(() => () => void (focusAnimRef.current && cancelAnimationFrame(focusAnimRef.current)), []);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        // Undo/redo restores exact positions, even intentionally overlapping layouts.
        setRawNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const organizeOverlappingNodes = useCallback(() => {
        const before = createHistoryEntry();
        const arranged = arrangeOverlappingCanvasNodes(before.nodes);
        if (arranged === before.nodes) {
            message.info("没有需要整理的重叠卡片");
            return;
        }
        const moved = arranged.filter((node, index) => node.type !== CanvasNodeType.Group && node.position !== before.nodes[index].position).length;
        historyRef.current.past = [...historyRef.current.past.slice(-49), before];
        historyRef.current.future = [];
        applyHistory({ ...before, nodes: arranged });
        const visibleNodes = arranged.filter((node) => node.type !== CanvasNodeType.Group && Number.isFinite(node.position.x) && Number.isFinite(node.position.y) && Number.isFinite(node.width) && Number.isFinite(node.height));
        if (visibleNodes.length) {
            const bounds = nodeBounds(visibleNodes);
            const availableWidth = Math.max(100, size.width - 64);
            const availableHeight = Math.max(100, size.height - 180);
            const k = Math.max(0.05, Math.min(1, availableWidth / Math.max(1, bounds.right - bounds.left), availableHeight / Math.max(1, bounds.bottom - bounds.top)));
            setViewport({ x: 32 + availableWidth / 2 - (bounds.left + bounds.right) / 2 * k, y: 64 + availableHeight / 2 - (bounds.top + bounds.bottom) / 2 * k, k });
        }
        message.success(`已整理 ${moved} 张重叠卡片，可点击撤销恢复`);
    }, [applyHistory, createHistoryEntry, message, size.width, size.height]);

    const createAndOpenProject = useCallback(() => {
        const id = createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }));
        navigate(`/canvas/${id}`);
    }, [createProject, navigate, t]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        cleanupAssetImages();
        navigate("/canvas");
    }, [cleanupAssetImages, deleteProjects, navigate, projectId]);

    const exportCurrentProject = useCallback(async () => {
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return message.error(t("canvas.projectPage.notFound"));
        const hide = message.loading(t("canvas.projectPage.exporting"), 0);
        try {
            await exportCanvasProjects([project], project.title || t("canvas.title"));
            message.success(t("canvas.projectPage.exported"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
        }
    }, [message, projectId, t]);

    const importCurrentContents = useCallback(async (file?: File) => {
        if (!file || contentImportBusyRef.current) return;
        contentImportBusyRef.current = true;
        const hide = message.loading("正在导入画布内容…", 0);
        try {
            await runTaskActivity("storage", async () => {
                if (file.size > 256 * 1024 * 1024) throw Error("ZIP 文件不能超过 256 MB");
                const zip = await readZip(file);
                const manifest = zip.get("projects.json");
                if (!manifest) throw Error("请选择导出当前画布生成的 ZIP 文件");
                const prepared = prepareCanvasContentImport(JSON.parse(await manifest.text()), zip, nodesRef.current);
                await settleActivityGroup(prepared.media.map(async ({ key, blob }) => {
                    await (key.startsWith("image:") ? setImageBlob(key, blob) : setMediaBlob(key, blob));
                }));
                const importedNodes = await hydrateCanvasImages(prepared.nodes);
                if (restoredProjectIdRef.current !== projectId || isRecycledCanvas(projectId)) throw Error("当前画布已切换，导入已停止");
                const before = createHistoryEntry();
                historyRef.current.past = [...historyRef.current.past.slice(-49), before];
                historyRef.current.future = [];
                const merged = placeNewCanvasNodes(before.nodes, [...before.nodes, ...importedNodes]);
                applyHistory({ ...before, nodes: merged, connections: [...before.connections, ...prepared.connections] });
                setSelectedNodeIds(new Set(prepared.nodes.map(node => node.id)));
                message.success(`已导入 ${prepared.nodes.length} 张卡片、${prepared.connections.length} 条连线，可撤销；未新建产品或画布`);
            });
        } catch (error) {
            const reason = error instanceof Error && /^(请选择|画布|卡片|连线|ZIP|当前画布)/.test(error.message) ? error.message : "导入失败，当前画布内容未被替换";
            message.error(reason);
        } finally {
            contentImportBusyRef.current = false;
            if (contentInputRef.current) contentInputRef.current.value = "";
            hide();
        }
    }, [applyHistory, createHistoryEntry, message, projectId]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            setHoveredNodeId(null);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
        },
        [selectNodeByEvent],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
        const currentNodes = nodesRef.current;
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (!nextSelected.has(node.id)) return;
            if (node.type === CanvasNodeType.Group) {
                currentNodes.forEach((child) => {
                    if (child.metadata?.groupId === node.id) dragIds.add(child.id);
                });
            }
        });
        const initialSelectedNodes = new Map(currentNodes.filter((node) => dragIds.has(node.id)).map((node): [string, { x: number; y: number }] => [node.id, { x: node.position.x, y: node.position.y }]));
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes,
            movedIds: new Set(initialSelectedNodes.keys()),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.size === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes.keys().next().value;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;
        const movedIds = dragRef.current.movedIds;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDropTargetGroupId(null);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            setNodes((prev) => {
                const moved = prev.map((node) => {
                    const initial = initialPositions.get(node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                const targetGroup = findGroupDropTarget(movedIds, moved);
                if (targetGroup) return snapNodesIntoGroup(movedIds, moved, targetGroup);
                return moved.map((node) => {
                    if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                    const groupId = findContainingGroupId(node, moved);
                    if (node.metadata?.groupId === groupId) return node;
                    return { ...node, metadata: { ...node.metadata, groupId } };
                });
            });
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = new Map();
        dragRef.current.movedIds = new Set();
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
            if (clickedDefinition?.hidePanel) {
                // Clicking a display-only plugin node selects it without opening a lower panel.
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedNode?.type !== CanvasNodeType.Group) {
                setDialogNodeId(clickedNodeId);
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                const movedIds = dragRef.current.movedIds;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                // Drop-target detection and node updates both run once per frame; mousemove can fire far more often than the display refreshes.
                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    const previewNodes = nodesRef.current.map((node) => {
                        const initial = initialPositions.get(node.id);
                        return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                    });
                    setDropTargetGroupId(findGroupDropTarget(movedIds, previewNodes)?.id || null);
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.get(node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [finishNodeDrag, getConnectionDropTarget, screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                .forEach((node) => {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadImage(file);
        addAsset({
            kind: "image",
            title: file.name,
            coverUrl: image.url,
            tags: [],
            source: "上传",
            data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType },
            metadata: { source: "upload", projectId },
        });
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [addAsset, projectId]);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        addAsset({
            kind: "video",
            title: file.name,
            coverUrl: video.url,
            tags: [],
            source: "上传",
            data: { url: video.url, storageKey: video.storageKey, width: video.width || 1280, height: video.height || 720, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "upload", projectId },
        });
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [addAsset, projectId]);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            const nextNodes = [...nodesRef.current, node];
            nodesRef.current = nextNodes;
            setNodes(nextNodes);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            void createImageFileNode(file, getCanvasCenter());
            message.success(t("canvas.projectPage.clipboardImageAdded"));
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success(t("canvas.projectPage.clipboardTextAdded"));
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, t]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]")) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "g") {
                if (event.shiftKey) {
                    if (canUngroupSelectedNodes(selectedNodeIdsRef.current, nodesRef.current)) {
                        event.preventDefault();
                        ungroupSelection();
                    }
                    return;
                }
                if (canGroupSelectedNodes(selectedNodeIdsRef.current, nodesRef.current)) {
                    event.preventDefault();
                    groupSelection();
                }
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteConnection, deleteNodes, groupSelection, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, selectedConnectionId, setConnecting, undoCanvas, ungroupSelection]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);

    const handleNodeResizeStart = useCallback(() => {
        setIsNodeResizing(true);
    }, []);
    const handleNodeResizeEnd = useCallback(() => setIsNodeResizing(false), []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) =>
            prev.map((node) =>
                node.id === nodeId
                    ? { ...node, metadata: { ...node.metadata, content, texts: node.metadata?.texts?.map((text) => (text.id === node.metadata?.primaryTextId ? { ...text, content } : text)) } }
                    : node,
            ),
        );
    }, []);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        setExpandedBatchNodeIds((current) => {
            const next = new Set(current);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    }, []);

    const setBatchPrimary = useCallback((nodeId: string, itemId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                if (node.type === CanvasNodeType.Text) {
                    const text = node.metadata?.texts?.find((item) => item.id === itemId);
                    return text?.content ? { ...node, metadata: { ...node.metadata, content: text.content, primaryTextId: text.id } } : node;
                }
                const image = node.metadata?.images?.find((item) => item.id === itemId);
                if (!image?.content) return node;
                const edge = Math.max(node.width, node.height);
                const size = node.metadata?.freeResize ? { width: node.width, height: node.height } : fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
                return {
                    ...node,
                    position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...node.metadata,
                        content: image.content,
                        storageKey: image.storageKey,
                        originalImage: image.originalImage,
                        deliveryNote: image.deliveryNote,
                        naturalWidth: image.naturalWidth,
                        naturalHeight: image.naturalHeight,
                        bytes: image.bytes,
                        mimeType: image.mimeType,
                        primaryImageId: image.id,
                    },
                };
            }),
        );
    }, []);

    const duplicateBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        const id = nanoid();
        const edge = Math.max(node.width, node.height);
        const size = fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
        const copy: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: generatedImageName(node, imageId),
            position: { x: node.position.x + node.width * 2 + 96, y: node.position.y + node.height / 2 - size.height / 2 },
            ...size,
            metadata: {
                content: image.content,
                storageKey: image.storageKey,
                originalImage: image.originalImage,
                deliveryNote: image.deliveryNote,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                bytes: image.bytes,
                mimeType: image.mimeType,
                status: NODE_STATUS_SUCCESS,
                prompt: node.metadata?.prompt,
                generationType: node.metadata?.generationType,
                model: node.metadata?.model,
                size: node.metadata?.size,
                quality: node.metadata?.quality,
                background: node.metadata?.background,
                references: node.metadata?.references,
            },
        };
        setNodes((prev) => [...prev, copy]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

    const downloadNodeImage = useCallback(async (node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || (!node.metadata?.content && !node.metadata?.storageKey)) return;
        try {
            const blob = await readDownloadBlob({ kind: node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image", storageKey: node.metadata.storageKey, url: node.metadata.content });
            const name = node.type === CanvasNodeType.Image ? generatedImageName(node, node.metadata.primaryImageId) : node.title || `canvas-${node.type}-${node.id}`;
            saveAs(blob, `${name.replace(/[\\/:*?"<>|]/g, "_")}.${node.type === CanvasNodeType.Video ? (blob.type.includes("webm") ? "webm" : "mp4") : node.type === CanvasNodeType.Audio ? audioExtension(blob.type) : imageExtension(blob.type)}`);
        } catch (error) { message.error(error instanceof Error ? error.message : "下载失败"); }
    }, [message]);

    const downloadBatchImage = useCallback(async (node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content && !image?.storageKey) return;
        try {
            const blob = await readDownloadBlob({ kind: "image", storageKey: image.storageKey, url: image.content });
            saveAs(blob, `${generatedImageName(node, imageId).replace(/[\\/:*?"<>|]/g, "_")}.${imageExtension(blob.type)}`);
        } catch (error) { message.error(error instanceof Error ? error.message : "下载失败"); }
    }, [message]);

    const captureVideoNodeFrame = useCallback(
        async (nodeId: string, position: VideoFramePosition) => {
            setContextMenu(null);
            const node = nodesRef.current.find((item) => item.id === nodeId);
            const video = Array.from(containerRef.current!.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]")).find((item) => item.dataset.canvasVideo === nodeId);
            if (node?.type !== CanvasNodeType.Video || !node.metadata?.content || !video) return message.error(t("canvas.videoFrames.failed"));
            try {
                const image = await uploadImage(await captureVideoFrame(node.metadata.content, position, video.currentTime));
                const size = fitNodeSize(image.width, image.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const id = nanoid();
                const x = node.position.x + node.width + 96;
                let y = node.position.y + node.height / 2 - size.height / 2;
                while (nodesRef.current.some((item) => item.id !== node.id && item.position.x < x + size.width && item.position.x + item.width > x && item.position.y < y + size.height && item.position.y + item.height > y)) y += size.height + 24;
                const child: CanvasNodeData = {
                    id,
                    type: CanvasNodeType.Image,
                    title: t(`canvas.videoFrames.${position}Title`, { name: node.title || t("assets.kinds.video") }),
                    position: { x, y },
                    ...size,
                    metadata: imageMetadata(image),
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: id }]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                setDialogNodeId(id);
                message.success(t("canvas.videoFrames.captured"));
            } catch {
                message.error(t("canvas.videoFrames.failed"));
            }
        },
        [message, t],
    );

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error(t("canvas.projectPage.noTextToSave"));
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasText"), coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id, projectId } });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error(t("canvas.projectPage.noVideoToSave"));
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasVideo"),
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: {
                        source: node.metadata?.generationType ? "generation" : "canvas",
                        projectId,
                        nodeId: node.id,
                        prompt: node.metadata?.prompt,
                        generationType: node.metadata?.generationType,
                        model: node.metadata?.model,
                        channel: node.metadata?.channel || node.metadata?.provider,
                        size: node.metadata?.size,
                        quality: node.metadata?.quality,
                        count: node.metadata?.count,
                        background: node.metadata?.background,
                    },
                });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (!node.metadata?.content) return message.error(t("canvas.projectPage.noImageToSave"));
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasImage"),
                coverUrl: node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: {
                        source: node.metadata?.generationType ? "generation" : "canvas",
                        projectId,
                    nodeId: node.id,
                    prompt: node.metadata?.prompt,
                    generationType: node.metadata?.generationType,
                    model: node.metadata?.model,
                    channel: node.metadata?.channel || node.metadata?.provider,
                    size: node.metadata?.size,
                    quality: node.metadata?.quality,
                    count: node.metadata?.count,
                    background: node.metadata?.background,
                },
            });
            message.success(t("common.addedToAssets"));
        },
        [addAsset, message, projectId, t],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning(t("canvas.projectPage.emptyReverse"));
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: t("canvas.projectPage.reversePreset"), prompt: t("canvas.projectPage.reversePreset"), status: NODE_STATUS_SUCCESS, fontSize: 14 }),
                title: t("canvas.projectPage.reverseTitle"),
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: t("canvas.reverseComposer", { imageId: node.id, textId: textNode.id }),
                    },
                ),
                title: t("canvas.projectPage.reverseConfigTitle"),
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, t],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, []);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: t("canvas.projectPage.splitTitle", { name: node.title || t("assets.kinds.image"), row: piece.row + 1, column: piece.column + 1 }),
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(t("canvas.projectPage.splitSuccess", { count: childNodes.length }));
        },
        [message, t],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            return runTaskActivity("canvas", async () => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || "auto" };
            if (payload.generate && !isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = t("canvas.projectPage.maskPrompt", { source: imageReferenceLabel(0), mask: imageReferenceLabel(1), prompt: userPrompt });
            setMaskEditNodeId(null);
            const maskImage = await uploadImage(payload.maskDataUrl);
            const maskNodeId = nanoid();
            const childId = nanoid();
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const maskSource = { id: maskNodeId, name: "mask.png", type: maskImage.mimeType || "image/png", dataUrl: maskImage.url, storageKey: maskImage.storageKey };
            const references = [source, maskSource];
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, references);
            const childMetadata = payload.generate ? { prompt, status: NODE_STATUS_LOADING, ...generationMetadata } : { prompt };
            setNodes((prev) => [
                ...prev,
                {
                    id: maskNodeId,
                    type: CanvasNodeType.Image,
                    title: t("canvas.projectPage.maskNodeTitle"),
                    position: { x: node.position.x, y: node.position.y + node.height + 96 },
                    width: node.width,
                    height: node.height,
                    metadata: imageMetadata(maskImage),
                },
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || t("canvas.projectPage.maskResult"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: childMetadata,
                },
            ]);
            setConnections((prev) => [
                ...prev,
                { id: nanoid(), fromNodeId: node.id, toNodeId: childId },
                { id: nanoid(), fromNodeId: maskNodeId, toNodeId: childId },
            ]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            if (!payload.generate) return;
            setRunningNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(generationConfig, prompt, references, { signal: controller.signal }).then((items) => items[0]);
                const uploaded = await uploadGeneratedImage(image.dataUrl, { signal: controller.signal, targetSize: image.deliverySize });
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata, ...actualImageGenerationMetadata(image) } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.maskFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        
            });
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        return runTaskActivity("canvas", async () => {
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const upscaled = await upscaleDataUrl(node.metadata.content, params);
        const image = await uploadImage(upscaled);
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Upscaled Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
    
        });
    }, []);

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            return runTaskActivity("canvas", async () => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(
                    generationConfig,
                    prompt,
                    [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }],
                    { signal: controller.signal },
                ).then((items) => items[0]);
                const uploaded = await uploadGeneratedImage(image.dataUrl, { signal: controller.signal, targetSize: image.deliverySize });
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata, ...actualImageGenerationMetadata(image) } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        
            });
        },
        [effectiveConfig, finishGenerationRequest, openConfigDialog, startGenerationRequest, t],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []).filter(
                (f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f),
            );
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            const target = uploadTargetRef.current;
            const basePosition =
                target?.position ||
                screenToCanvas(
                    (containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2,
                    (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2,
                );
            const STAGGER = 40; // Offset between multiple imported files.

            // When replacing a target node, use the first file as the replacement and create the rest nearby.
            if (target?.nodeId) {
                const [first, ...rest] = files;

                // Replace the target node with the first file.
                if (isAudioFile(first)) {
                    const audio = await uploadMediaFile(first, "audio");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Audio,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                      width: spec.width,
                                      height: spec.height,
                                      metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else if (first.type.startsWith("video/")) {
                    const video = await uploadMediaFile(first, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else {
                    const image = await uploadGeneratedImage(first);
                    const s = fitNodeSize(image.width, image.height);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Image,
                                      title: first.name,
                                      width: s.width,
                                      height: s.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(image),
                                          errorDetails: undefined,
                                          freeResize: false,
                                          images: undefined,
                                          generationType: undefined,
                                          model: undefined,
                                          size: undefined,
                                          quality: undefined,
                                          count: undefined,
                                          references: undefined,
                                          primaryImageId: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                }

                // Create the remaining files near the target node.
                for (let i = 0; i < rest.length; i++) {
                    const offsetPos = { x: basePosition.x + (i + 1) * STAGGER, y: basePosition.y + (i + 1) * STAGGER };
                    const f = rest[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            } else {
                // Without a replacement target, create all files near the canvas center.
                for (let i = 0; i < files.length; i++) {
                    const offsetPos = { x: basePosition.x + i * STAGGER, y: basePosition.y + i * STAGGER };
                    const f = files[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();

            const promptData = event.dataTransfer.getData(PROMPT_DRAG_DATA_TYPE);
            if (promptData) {
                try {
                    const payload = JSON.parse(promptData) as { prompt?: unknown; title?: unknown; excelPrompt?: { templateId?: unknown; key?: unknown; label?: unknown; theme?: unknown; compositionLock?: unknown; purpose?: unknown; tokens?: unknown } };
                    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
                    if (prompt) {
                        const position = screenToCanvas(event.clientX, event.clientY);
                        const excelPrompt = payload.excelPrompt;
                        const node = {
                            ...createCanvasNode(CanvasNodeType.Text, position, {
                                content: prompt,
                                prompt,
                                status: NODE_STATUS_SUCCESS,
                                ...(excelPrompt ? {
                                    excelPromptTemplateId: typeof excelPrompt.templateId === "string" ? excelPrompt.templateId : "",
                                    excelPromptKey: typeof excelPrompt.key === "string" ? excelPrompt.key : "",
                                    excelPromptLabel: typeof excelPrompt.label === "string" ? excelPrompt.label : "",
                                    excelPromptTheme: typeof excelPrompt.theme === "string" ? excelPrompt.theme : "",
                                    excelPromptCompositionLock: typeof excelPrompt.compositionLock === "string" ? excelPrompt.compositionLock : "",
                                    excelPromptPurpose: typeof excelPrompt.purpose === "string" ? excelPrompt.purpose : "",
                                    excelPromptTokens: Array.isArray(excelPrompt.tokens) ? excelPrompt.tokens.filter((token): token is string => typeof token === "string") : [],
                                    excelPromptRaw: prompt,
                                } : {}),
                            }),
                            title: typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : prompt.slice(0, 32),
                        };
                        setNodes((prev) => [...prev, node]);
                        setSelectedNodeIds(new Set([node.id]));
                        setSelectedConnectionId(null);
                        setContextMenu(null);
                    }
                } catch {
                    // Ignore malformed custom drag payloads and continue handling file drops.
                }
                return;
            }

            const files = Array.from(event.dataTransfer.files).filter(
                (item) => item.type.startsWith("image/") || item.type.startsWith("video/") || isAudioFile(item),
            );
            if (!files.length) return;

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const STAGGER = 40;
            for (let i = 0; i < files.length; i++) {
                const pos = { x: basePos.x + i * STAGGER, y: basePos.y + i * STAGGER };
                const f = files[i];
                if (isAudioFile(f)) {
                    void createAudioFileNode(f, pos);
                } else if (f.type.startsWith("video/")) {
                    void createVideoFileNode(f, pos);
                } else {
                    void createImageFileNode(f, pos);
                }
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || t("canvas.projectPage.untitledCanvas"));
        setTitleEditing(true);
    }, [currentProject?.title, t]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) {
            try {
                checkpointLocalStorageWrite(`guan-canvas-title:${workbenchProductId || projectId}`, nextTitle);
                const detail = { projectId: workbenchProductId || projectId, title: nextTitle };
                window.dispatchEvent(new CustomEvent("guan-canvas-title", { detail }));
                if (window.parent !== window) window.parent.dispatchEvent(new CustomEvent("guan-canvas-title", { detail }));
            } catch { /* Renaming still works without browser storage. */ }
            renameProject(projectId, nextTitle);
        }
        setTitleEditing(false);
    }, [projectId, workbenchProductId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, parentScope?: RootScope) => {
            return runTaskActivity("canvas", async (scope) => {
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const configNode = sourceNode?.type === CanvasNodeType.Config ? sourceNode : findRetrySourceNode(nodeId, nodesRef.current, connectionsRef.current);
            const generationConfig = buildGenerationConfig(effectiveConfig, generationNodeForExecution(configNode || sourceNode, configNode?.id || nodeId, nodesRef.current, connectionsRef.current), mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const scene = prompt.trim();
                if (!scene) return;
                setRunningNodeId(nodeId);
                const controller = startGenerationRequest(nodeId, nodeId, nodeId);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    const context = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, fullPrompt));
                    const refs = context.referenceImages;
                    const image = refs.length
                        ? await requestEdit({ ...generationConfig, count: "1" }, context.prompt, refs, { signal: controller.signal }).then((items) => items[0])
                        : await requestGeneration({ ...generationConfig, count: "1" }, context.prompt, { signal: controller.signal }).then((items) => items[0]);
                const uploaded = await uploadGeneratedImage(image.dataUrl, { signal: controller.signal, targetSize: image.deliverySize });
                    setNodes((prev) =>
                        prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, ...actualImageGenerationMetadata(image), status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                    );
                    setDialogNodeId(null);
                } catch (error) {
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                        message.error(errorDetails);
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                } finally {
                    finishGenerationRequest(nodeId, controller);
                }
                return;
            }

            setRunningNodeId(nodeId);
            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            let generationContext;
            try {
                generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt }) : prompt),
                );
            } catch (error) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId((current) => current === nodeId ? null : current);
                setNodes((prev) => prev.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, generationStartedAt: Date.now(), status: NODE_STATUS_ERROR, errorDetails: error instanceof Error ? error.message : "读取生成参考资料失败" } } : node));
                throw error;
            }
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId((current) => current === nodeId ? null : current);
                return;
            }
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId((current) => current === nodeId ? null : current);
                return;
            }
            let pendingChildIds: string[] = [];
            const generationStartedAt = Date.now();
            if (markSourceStatus) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Config ? {} : { prompt }), generationStartedAt, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    const sourceReference =
                        isImageNode && sourceNode?.metadata?.content
                            ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata.mimeType || "image/png", dataUrl: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey }]
                            : [];
                    const referenceImages = [...new Map([...sourceReference, ...generationContext.referenceImages].map((image) => [image.id, image])).values()];
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const imageIds = Array.from({ length: count }, () => nanoid());
                    pendingChildIds = [rootId];
                    // Results created from a generation-config card belong to
                    // the connected prompt card. Use that prompt title for
                    // the generated image name instead of the config title.
                    const connectedPrompt = isConfigNode
                        ? connectionsRef.current
                              .filter((connection) => connection.toNodeId === nodeId)
                              .map((connection) => nodesRef.current.find((candidate) => candidate.id === connection.fromNodeId))
                              .find((candidate) => candidate?.type === CanvasNodeType.Text)
                        : undefined;
                    const generatedTitle = generatedImageCardTitle(connectedPrompt) || generatedImageCardTitle(sourceNode) || effectivePrompt.slice(0, 32) || "生成图片";
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: generatedTitle,
                        position: {
                            x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            images: imageIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })),
                            ...generationMetadata,
                            generationStartedAt,
                        },
                    };

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                    ]);
                    if (!isEmptyImageNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                    let hasSuccess = false;
                    let hasFailure = false;
                    let firstError = "";
                    const onAttempt = (attempt: { channel: string; model: string; error?: string }) => {
                        setNodes((prev) => prev.map((node) => node.id === rootId ? { ...node, metadata: { ...node.metadata, channel: attempt.channel, model: attempt.model, generationAttempts: [...(node.metadata?.generationAttempts || []), attempt] } } : node));
                    };
                    await settleActivityGroup(
                        imageIds.map(async (imageId) => {
                            try {
                                const image = referenceImages.length
                                    ? await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, { signal: controller.signal, onAttempt }).then((items) => items[0])
                                    : await requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt, { signal: controller.signal, onAttempt }).then((items) => items[0]);
                                const uploaded = await uploadGeneratedImage(image.dataUrl, { signal: controller.signal, targetSize: image.deliverySize });
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                const item: CanvasNodeImage = { id: imageId, status: NODE_STATUS_SUCCESS, content: uploaded.url, storageKey: uploaded.storageKey, naturalWidth: uploaded.width, naturalHeight: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType, originalImage: uploaded.originalImage, deliveryNote: uploaded.deliveryNote };
                                setNodes((prev) =>
                                    prev.map((node) => {
                                        if (node.id !== rootId) return node;
                                        const images = node.metadata?.images?.map((image) => (image.id === imageId ? { ...image, ...item } : image)) || [];
                                        if (node.metadata?.primaryImageId) return { ...node, metadata: { ...node.metadata, images } };
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        return {
                                            ...node,
                                            position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                            ...imageSize,
                                            metadata: {
                                                ...node.metadata,
                                                content: item.content,
                                                storageKey: item.storageKey,
                                                originalImage: item.originalImage,
                                                deliveryNote: item.deliveryNote,
                                                naturalWidth: item.naturalWidth,
                                                naturalHeight: item.naturalHeight,
                                                bytes: item.bytes,
                                                mimeType: item.mimeType,
                                                ...actualImageGenerationMetadata(image),
                                                images,
                                                primaryImageId: imageId,
                                            },
                                        };
                                    }),
                                );
                                hasSuccess = true;
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                                return true;
                            } catch (error) {
                                if (isGenerationCanceled(error)) return false;
                                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                                if (!firstError) firstError = errorDetails;
                                hasFailure = true;
                                setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : node)));
                            }
                            return false;
                        }),
                    );
                    if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                    if (controller.signal.aborted) {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                        return;
                    }
                    if (hasFailure) {
                        message.error(hasSuccess ? t("canvas.projectPage.partialFailed") : firstError || t("canvas.projectPage.generationFailed"));
                    }
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.generationFailed") } }
                                : node.id === rootId
                                  ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.allFailed") } }
                                    : node,
                        ),
                    );
                    return;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const videoId = isEmptyVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || "Generated Video",
                        position: isEmptyVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: isEmptyVideoNode ? sourceNode.width : spec.width,
                        height: isEmptyVideoNode ? sourceNode.height : spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            model: generationConfig.model,
                            generationStartedAt,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            videoMode: generationConfig.videoMode,
                            references: generationReferenceUrls(generationContext),
                        },
                    };
                    pendingChildIds = [videoId];
                    setNodes((prev) =>
                        isEmptyVideoNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!isEmptyVideoNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId }]);
                    const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
                    try {
                        await completeVideoNodeTask(videoId, generationConfig, effectivePrompt, generationContext.referenceImages, controller.signal, {
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            videoMode: generationConfig.videoMode,
                            references: generationReferenceUrls(generationContext),
                        }, generationContext.referenceVideos, generationContext.referenceAudios);
                    } finally {
                        finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isEmptyAudioNode = sourceNode?.type === CanvasNodeType.Audio && !sourceNode.metadata?.content;
                    const audioId = isEmptyAudioNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: effectivePrompt.slice(0, 32) || "Generated Audio",
                        position: isEmptyAudioNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                        width: isEmptyAudioNode ? sourceNode.width : spec.width,
                        height: isEmptyAudioNode ? sourceNode.height : spec.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) =>
                        isEmptyAudioNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
                    );
                    if (!isEmptyAudioNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }]);
                    const controller = startGenerationRequest(audioId, nodeId, nodeId, runController);
                    try {
                        const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, effectivePrompt, { signal: controller.signal }), generationConfig.audioFormat);
                        setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt: effectivePrompt, ...buildAudioGenerationMetadata(generationConfig) } } : node)));
                    } finally {
                        finishGenerationRequest(audioId, controller);
                    }
                    return;
                }

                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = getGenerationCount(String(sourceNode?.metadata?.textCount || 1));
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const isEmptyTextNode = sourceNode?.type === CanvasNodeType.Text && !sourceTextContent;
                const rootId = isEmptyTextNode ? nodeId : nanoid();
                const textIds = Array.from({ length: textCount }, () => nanoid());
                const rootNode: CanvasNodeData = {
                    id: rootId,
                    type: CanvasNodeType.Text,
                    title: sourceNode?.metadata?.promptVariableTranslationLanguage === "en" ? "英文最终生图提示词" : sourceNode?.metadata?.promptVariableTranslationLanguage === "zh" ? "中文最终生图提示词" : effectivePrompt.slice(0, 32) || "Generated Text",
                    position: isEmptyTextNode ? sourceNode.position : { x: parentPosition.x + parentConfig.width + 96, y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 },
                    width: isEmptyTextNode ? sourceNode.width : textConfig.width,
                    height: isEmptyTextNode ? sourceNode.height : textConfig.height,
                    metadata: {
                        prompt: effectivePrompt,
                        status: NODE_STATUS_LOADING,
                        fontSize: 14,
                        model: generationConfig.model,
                        reasoningEffort: generationConfig.reasoningEffort,
                        textCount,
                        texts: textIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "" })),
                        primaryTextId: textIds[0],
                        ...(sourceNode?.type === CanvasNodeType.Text ? { sourcePromptTitle: sourceNode.title || "提示词卡片" } : {}),
                        ...(sourceNode?.metadata?.promptVariableTranslationOf ? { promptVariableTranslationOf: sourceNode.metadata.promptVariableTranslationOf, promptVariableTranslationLanguage: sourceNode.metadata.promptVariableTranslationLanguage } : {}),
                    },
                };
                pendingChildIds = [rootId];
                setNodes((prev) =>
                    isEmptyTextNode
                        ? prev.map((node) => (node.id === nodeId ? { ...node, ...rootNode } : node))
                        : [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), rootNode],
                );
                if (!isEmptyTextNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
                setSelectedNodeIds(new Set([nodeId]));
                setSelectedConnectionId(null);
                setDialogNodeId(nodeId);

                const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                const results = await settleActivityGroup(
                    textIds.map(async (textId): Promise<CanvasNodeText | null> => {
                        let streamed = "";
                        try {
                            const answer = await requestImageQuestion(
                                generationConfig,
                                buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                                (text) => {
                                    streamed = text;
                                    setNodes((prev) =>
                                        prev.map((node) =>
                                            node.id === rootId
                                                ? {
                                                      ...node,
                                                      metadata: {
                                                          ...node.metadata,
                                                          ...(node.metadata?.primaryTextId === textId ? { content: text } : {}),
                                                          texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content: text } : item)),
                                                      },
                                                  }
                                                : node,
                                        ),
                                    );
                                },
                                { signal: controller.signal },
                            );
                            const content = answer || streamed;
                            setNodes((prev) =>
                                prev.map((node) =>
                                    node.id === rootId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  ...(node.metadata?.primaryTextId === textId ? { content } : {}),
                                                  texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content, status: NODE_STATUS_SUCCESS } : item)),
                                              },
                                          }
                                        : node,
                                ),
                            );
                            return { id: textId, status: NODE_STATUS_SUCCESS, content } satisfies CanvasNodeText;
                        } catch (error) {
                            if (isGenerationCanceled(error)) return null;
                            const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                            setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, status: NODE_STATUS_ERROR, errorDetails } : item)) } } : node)));
                            return { id: textId, status: NODE_STATUS_ERROR, content: "", errorDetails } satisfies CanvasNodeText;
                        }
                    }),
                );
                if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                if (controller.signal.aborted) return;
                const completedTexts = results.flatMap((item) => (item?.status === NODE_STATUS_SUCCESS ? [item] : []));
                const failedTexts = results.filter((item) => item?.status === NODE_STATUS_ERROR);
                const firstText = completedTexts[0];
                if (completedTexts.length <= 1) setExpandedBatchNodeIds((current) => new Set([...current].filter((id) => id !== rootId)));
                if (failedTexts.length) message.error(firstText ? t("canvas.projectPage.partialTextFailed") : failedTexts[0]?.errorDetails || t("canvas.projectPage.generationFailed"));
                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id === rootId) {
                            const primaryText = completedTexts.find((text) => text.id === node.metadata?.primaryTextId) || firstText;
                            return {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    content: primaryText?.content || "",
                                    texts: completedTexts,
                                    primaryTextId: primaryText?.id,
                                    status: primaryText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                    errorDetails: primaryText ? undefined : t("canvas.projectPage.generationFailed"),
                                },
                            };
                        }
                        return node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: firstText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: firstText ? undefined : t("canvas.projectPage.generationFailed") } } : node;
                    }),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === nodeId || pendingChildIds.includes(node.id)
                            ? node.id === nodeId && !markSourceStatus
                                ? node
                                : {
                                      ...node,
                                      metadata: {
                                          ...node.metadata,
                                          status: NODE_STATUS_ERROR,
                                          errorDetails,
                                          ...(isVideoTaskFailed(error) && node.type === CanvasNodeType.Video ? { videoTaskId: undefined } : {}),
                                      },
                                  }
                            : node,
                    ),
                );
            } finally {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId((current) => current === nodeId ? null : current);
            }
        
            }, parentScope);
        },
        [addAsset, completeVideoNodeTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData, imageId?: string) => {
            return runTaskActivity("canvas", async () => {
            if (hasResumableVideoTask(node)) {
                await pollVideoNodeTask(node);
                return;
            }
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? node.metadata : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, generationNodeForExecution(sourceNode?.type === CanvasNodeType.Config ? sourceNode : findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || sourceNode, sourceNode?.id || node.id, nodesRef.current, connectionsRef.current), node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.retryPromptMissing"));
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error(t("canvas.projectPage.referenceMissing"));
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: item.metadata?.content ? undefined : t("canvas.projectPage.referenceMissing"), images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("canvas.projectPage.referenceMissing") } : image)) } } : item)));
                return;
            }
            const retryImages = retryReferenceImages || [];

            setRunningNodeId(node.id);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, generationStartedAt: Date.now(), status: NODE_STATUS_LOADING, errorDetails: undefined, images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_LOADING, errorDetails: undefined } : image)) } } : item)));
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(
                        generationConfig,
                        buildNodeResponseMessages({ ...context, prompt }),
                        (text) => {
                            streamed = text;
                            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                        },
                        { signal: controller.signal },
                    );
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    await completeVideoNodeTask(node.id, generationConfig, prompt, retryImages, controller.signal, {
                        size: generationConfig.size,
                        seconds: generationConfig.videoSeconds,
                        vquality: generationConfig.vquality,
                        generateAudio: generationConfig.videoGenerateAudio,
                        watermark: generationConfig.videoWatermark,
                        videoMode: generationConfig.videoMode,
                    }, context?.referenceVideos || [], context?.referenceAudios || []);
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal }), generationConfig.audioFormat);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    return;
                }

                const image = useReferenceImages
                    ? await requestEdit(generationConfig, prompt, retryImages, { signal: controller.signal }).then((items) => items[0])
                    : await requestGeneration(generationConfig, prompt, { signal: controller.signal }).then((items) => items[0]);
                const uploadedImage = await uploadGeneratedImage(image.dataUrl, { signal: controller.signal, targetSize: image.deliverySize });
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const retryImage: CanvasNodeImage = {
                    id: imageId || node.metadata?.primaryImageId || nanoid(),
                    name: generatedImageName(node, imageId || node.metadata?.primaryImageId),
                    status: NODE_STATUS_SUCCESS,
                    content: uploadedImage.url,
                    storageKey: uploadedImage.storageKey,
                    originalImage: uploadedImage.originalImage,
                    deliveryNote: uploadedImage.deliveryNote,
                    naturalWidth: uploadedImage.width,
                    naturalHeight: uploadedImage.height,
                    bytes: uploadedImage.bytes,
                    mimeType: uploadedImage.mimeType,
                };
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          ...(generationConfig.background ? { background: generationConfig.background } : {}),
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) => {
                        if (item.id !== node.id) return item;
                        const makePrimary = !imageId || !item.metadata?.content;
                        const edge = imageId ? Math.max(item.width, item.height) : 0;
                        const imageSize = imageId && item.metadata?.freeResize ? { width: item.width, height: item.height } : imageId ? fitNodeSize(uploadedImage.width, uploadedImage.height, edge, edge) : fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                        return {
                            ...item,
                            type: CanvasNodeType.Image,
                            ...(makePrimary ? { width: imageSize.width, height: imageSize.height, ...(imageId ? { position: { x: item.position.x + item.width / 2 - imageSize.width / 2, y: item.position.y + item.height / 2 - imageSize.height / 2 } } : {}) } : {}),
                            metadata: {
                                ...item.metadata,
                                ...(makePrimary ? imageMetadata(uploadedImage) : { status: NODE_STATUS_SUCCESS }),
                                images: item.metadata?.images?.map((current) => (current.id === retryImage.id ? retryImage : current)),
                                primaryImageId: makePrimary ? retryImage.id : item.metadata?.primaryImageId,
                                prompt,
                                ...generationMetadata,
                                ...actualImageGenerationMetadata(image),
                            },
                        };
                    }),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.content ? undefined : errorDetails,
                                      images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)),
                                      ...(isVideoTaskFailed(error) && item.type === CanvasNodeType.Video ? { videoTaskId: undefined } : {}),
                                  },
                              }
                            : item,
                    ),
                );
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        
            });
        },
        [completeVideoNodeTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, pollVideoNodeTask, startGenerationRequest, t],
    );

    const deleteBatchImage = useCallback((nodeId: string, imageId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if ((node?.metadata?.images?.length || 0) <= 2) setExpandedBatchNodeIds((current) => new Set([...current].filter((id) => id !== nodeId)));
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const images = item.metadata?.images?.filter((image) => image.id !== imageId) || [];
                return { ...item, metadata: { ...item.metadata, images, count: images.length, primaryImageId: item.metadata?.primaryImageId === imageId ? images[0]?.id : item.metadata?.primaryImageId } };
            }),
        );
    }, []);

    const retryBatchImage = useCallback((node: CanvasNodeData, imageId: string) => void handleRetryNode(node, imageId), [handleRetryNode]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.emptyTextImage"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, t],
    );

    const addGenerationConfigsForPromptNodes = useCallback(() => {
        const promptNodes = nodesRef.current.filter((node) => node.type === CanvasNodeType.Text && Boolean((node.metadata?.content || node.metadata?.prompt || "").trim()));
        const connectedPromptIds = new Set(connectionsRef.current.map((connection) => connection.fromNodeId));
        const candidates = promptNodes.filter((node) => !connectedPromptIds.has(node.id));
        if (!candidates.length) {
            message.info("没有找到尚未连接生成配置的提示词卡片");
            return;
        }
        const configSpec = getNodeSpec(CanvasNodeType.Config);
        const occupied = [...nodesRef.current];
        const created: CanvasNodeData[] = [];
        const nextConnections = [...connectionsRef.current];
        candidates.forEach((sourceNode) => {
            const mode = promptGenerationMode(sourceNode, nodesRef.current, connectionsRef.current) || "image";
            const x = sourceNode.position.x + sourceNode.width + 96;
            const y = sourceNode.position.y;
            const configNode = placeCanvasNode(createCanvasNode(CanvasNodeType.Config, { x: x + configSpec.width / 2, y: y + configSpec.height / 2 }, {
                prompt: "",
                model: effectiveConfig.imageModel || effectiveConfig.model,
                size: effectiveConfig.size,
                count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                // Excel prompt cards can contain image parameters in their
                // text rather than explicit metadata. Parse the same prompt
                // contract used by normal generation so the new config card
                // is a complete snapshot and does not fall back to globals.
                ...promptGenerationPatch(String(sourceNode.metadata?.content || sourceNode.metadata?.prompt || "")),
                ...generationSettingsFromNode(sourceNode),
                generationMode: mode,
                ...(mode !== "image" ? { model: mode === "video" ? effectiveConfig.videoModel : mode === "audio" ? effectiveConfig.audioModel : effectiveConfig.textModel } : {}),
            }), occupied);
            created.push(configNode);
            occupied.push(configNode);
            nextConnections.push({ id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id });
        });
        const nextNodes = [...nodesRef.current, ...created];
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        setSelectedNodeIds(new Set(created.map((node) => node.id)));
        setSelectedConnectionId(null);
        message.success(`已补齐 ${created.length} 个生成配置`);
    }, [effectiveConfig.videoModel, effectiveConfig.audioModel, effectiveConfig.textModel, effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message]);

    const batchGenerationRunning = useRef(false);
    const generateAllConfigNodes = useCallback(async (parentScope?: RootScope) => {
        return runTaskActivity("canvas", async (scope) => {
        if (batchGenerationRunning.current) return;
        const configNodes = nodesRef.current.filter((node) => node.type === CanvasNodeType.Config && node.metadata?.status !== NODE_STATUS_LOADING);
        if (!configNodes.length) {
            message.info("画布上没有生成配置卡片");
            return;
        }
        batchGenerationRunning.current = true;
        message.info(`已加入 ${configNodes.length} 个生成任务，最多同时执行 3 个`);
        let cursor = 0;
        let failed = 0;
        const worker = async () => {
            while (cursor < configNodes.length) {
                const queued = configNodes[cursor++];
                const node = nodesRef.current.find((item) => item.id === queued.id);
                if (!node || node.metadata?.status === NODE_STATUS_LOADING) continue;
                try {
                    await handleGenerateNode(node.id, node.metadata?.generationMode || "image", node.metadata?.composerContent || node.metadata?.prompt || "", scope);
                } catch {
                    failed++;
                }
            }
        };
        try {
            await settleActivityGroup(Array.from({ length: Math.min(3, configNodes.length) }, worker));
            if (failed) message.warning(`${failed} 个任务提交失败，其余任务已继续执行`);
        } finally {
            batchGenerationRunning.current = false;
        }
    
        }, parentScope);
    }, [handleGenerateNode, message]);

    const completeAndGenerateRunning = useRef(false);
    const completeAndGenerateAll = useCallback(async () => {
        return runTaskActivity("canvas", async (scope) => {
        if (completeAndGenerateRunning.current) return;
        completeAndGenerateRunning.current = true;
        try {
            // Completion updates nodesRef/connectionsRef synchronously, so
            // generation includes the new cards without waiting on a render.
            addGenerationConfigsForPromptNodes();
            await generateAllConfigNodes(scope);
        } catch {
            message.error("批量生成未完成，请检查生成任务的错误信息后重试");
        } finally {
            completeAndGenerateRunning.current = false;
        }
    
        });
    }, [addGenerationConfigsForPromptNodes, generateAllConfigNodes, message]);

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadImage(image.dataUrl);
            await ensureImagePreview(storedImage.storageKey);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string, excelPrompt?: Extract<InsertAssetPayload, { kind: "text" }>['excelPrompt']) => {
            if (excelPrompt) {
                const existing = nodesRef.current.find((item) => item.type === CanvasNodeType.Text && (
                    (item.metadata?.excelPromptKey === excelPrompt.key && item.metadata?.excelPromptTemplateId === excelPrompt.templateId) ||
                    item.metadata?.excelPromptRaw === text ||
                    item.metadata?.content === text
                ));
                if (existing) {
                    const context = readExcelPromptContext();
                    const next = syncExcelPromptNodes(nodesRef.current, context, (node) => window.confirm(`「${node.title || "提示词"}」已手动修改，是否使用 Excel 新内容覆盖？`));
                    if (next !== nodesRef.current) { nodesRef.current = next; setNodes(next); }
                    setSelectedNodeIds(new Set([existing.id]));
                    setSelectedConnectionId(null);
                    return;
                }
            }
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, {
                    content: text,
                    status: NODE_STATUS_SUCCESS,
                    ...(excelPrompt ? {
                        excelPromptTemplateId: excelPrompt.templateId || "",
                        excelPromptKey: excelPrompt.key || "",
                        excelPromptLabel: excelPrompt.label || "",
                        excelPromptTheme: excelPrompt.theme || "",
                        excelPromptCompositionLock: excelPrompt.compositionLock || "",
                        excelPromptPurpose: excelPrompt.purpose || "",
                        excelPromptTokens: excelPrompt.tokens || [],
                        excelPromptRaw: text,
                    } : {}),
                }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            const nextNodes = [...nodesRef.current, node];
            nodesRef.current = nextNodes;
            setNodes(nextNodes);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        (payload: InsertAssetPayload) => {
            if (payload.kind === "text") {
                insertAssistantText(payload.content, payload.title, payload.excelPrompt);
            } else if (payload.kind === "video") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey });
            }
            setAssetPickerOpen(false);
        },
        [insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.
    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData, imageId?: string) => {
        setPreviewNodeId(node.id);
        setPreviewImageId(imageId || null);
    }, []);
    const translatePromptNode = useCallback((node: CanvasNodeData, language: "en" | "zh") => {
        const source = node.metadata?.content?.trim();
        if (!source) {
            message.warning("最终提示词为空，无法翻译");
            return;
        }
        const existing = nodesRef.current.find((item) => item.metadata?.promptVariableTranslationOf === node.id && item.metadata?.promptVariableTranslationLanguage === language);
        if (existing) {
            setSelectedNodeIds(new Set([existing.id]));
            return;
        }
        const englishNode = {
            ...createCanvasNode(
                CanvasNodeType.Text,
                { x: node.position.x, y: node.position.y + node.height + 96 },
                { status: NODE_STATUS_IDLE, promptVariableTranslationOf: node.id, promptVariableTranslationLanguage: language },
            ),
            title: language === "en" ? "英文最终生图提示词" : "中文最终生图提示词",
        };
        const nextNodes = [...nodesRef.current, englishNode];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        const nextConnections = [...connectionsRef.current, { id: nanoid(), fromNodeId: node.id, toNodeId: englishNode.id }];
        connectionsRef.current = nextConnections;
        setConnections(nextConnections);
        setSelectedNodeIds(new Set([englishNode.id]));
        window.setTimeout(() => {
            void generateNodeRef.current?.(
                englishNode.id,
                "text",
                `${language === "en" ? "Translate the following image-generation prompt into natural English" : "将下面的生图提示词翻译成自然、准确的简体中文"}. Preserve all product facts, structure, measurements, and placeholders. Output only the translated prompt, with no explanation.\n\n${source}`,
            );
        }, 0);
    }, [message]);
    const handleNodeRetry = useCallback(
        async (node: CanvasNodeData, imageId?: string) => {
            const current = nodesRef.current.find(item => item.id === node.id);
            if (!current || current.metadata?.status === NODE_STATUS_LOADING || generationRequestsRef.current.has(node.id)) return;
            if (imageId && current.metadata?.images?.find(image => image.id === imageId)?.status !== NODE_STATUS_ERROR) return;
            if (!imageId && node.metadata?.status === NODE_STATUS_ERROR && current.metadata?.status !== NODE_STATUS_ERROR) return;
            if (node.type === CanvasNodeType.Config) {
                await generateNodeRef.current?.(node.id, node.metadata?.generationMode || "image", node.metadata?.prompt || "");
                return;
            }
            if (node.type === CanvasNodeType.Text && (node.metadata?.textCount || 1) > 1) {
                await generateNodeRef.current?.(node.id, "text", node.metadata?.prompt || "");
                return;
            }
            await handleRetryNode(current, imageId);
        },
        [handleRetryNode],
    );
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setSelectedNodeIds((current) => (current.has(nodeId) ? current : new Set([nodeId])));
        setSelectedConnectionId(null);
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) =>
            getNodeDefinition(panelNode.type)?.Panel ? (
                renderPluginPanel(panelNode)
            ) : panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    nodeId={panelNode.id}
                    nodes={nodes}
                    value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    inputs={configInputsById.get(panelNode.id) || []}
                    connectedNodes={connectedNodesByNodeId.get(panelNode.id) || []}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                    onClose={() => setDialogNodeId(null)}
                    onDisconnectReference={disconnectNodeReference}
                    onStartReferenceSelection={startNodeReferenceSelection}
                />
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    nodes={nodes}
                    isRunning={runningNodeId === panelNode.id}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                    connectedNodes={connectedNodesByNodeId.get(panelNode.id) || []}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onStop={confirmStopGeneration}
                    onDisconnectReference={disconnectNodeReference}
                    onStartReferenceSelection={startNodeReferenceSelection}
                    modeOverride={getNodeDefinition(panelNode.type)?.useBuiltinPanel?.mode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            ),
        [configInputsById, confirmStopGeneration, connectedNodesByNodeId, disconnectNodeReference, handleConfigNodeChange, handleGenerateNode, handleNodePromptChange, mentionReferencesByNodeId, nodes, renderPluginPanel, runningNodeId, startNodeReferenceSelection],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) => (
            <CanvasConfigNodePanel
                node={contentNode}
                isRunning={runningNodeId === contentNode.id}
                inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                onConfigChange={handleConfigNodeChange}
                onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                onStop={confirmStopGeneration}
                onGenerate={(nodeId) => {
                    const target = nodesRef.current.find((item) => item.id === nodeId);
                    void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                }}
            />
        ),
        [configInputsById, confirmStopGeneration, handleConfigNodeChange, handleGenerateNode, runningNodeId],
    );

    const selectConnection = useCallback((id: string) => {
        setSelectedConnectionId(id);
        setSelectedNodeIds(new Set());
        setContextMenu(null);
    }, []);
    const openConnectionMenu = useCallback((event: ReactMouseEvent<SVGPathElement>, id: string) => {
        setSelectedConnectionId(id);
        setSelectedNodeIds(new Set());
        setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: id });
    }, []);

    if (projectLoadFailed) return <main role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-6" style={{ background: theme.canvas.background, color: theme.node.text }}>
        <p>画布资源读取失败，原数据已保留。</p>
        <Button onClick={() => window.location.reload()}>重新加载当前画布</Button>
    </main>;
    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasSidePanel projectId={projectId} nodes={nodes} connections={connections} deletedNodeBatches={currentProject?.deletedNodeBatches || []} selectedNodeIds={selectedNodeIds} onFocusNode={focusNode} onPreviewNode={setPreviewNodeId} onRetryNode={handleNodeRetry} onInsertAsset={handleAssetInsert} onRestoreDeletedNodeBatch={restoreDeletedNodeBatch} onPermanentlyDeleteNodeBatch={permanentlyDeleteNodeBatch} />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || productTitle || t("canvas.projectPage.untitledCanvas")}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onExportProject={exportCurrentProject}
                    onImportContents={() => {
                        try { assertTaskAdmission(); contentInputRef.current?.click(); }
                        catch { message.error("工作台正在进行安全维护，请稍后重试"); }
                    }}
                    onOrganizeOverlaps={organizeOverlappingNodes}
                    onOpenPlugins={() => setPluginManagerOpen(true)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    agentOpen={agentPanelOpen}
                    saveStatus={saveStatus}
                    onToggleAgent={toggleAgentPanel}
                />

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    tool={canvasTool}
                    backgroundMode={backgroundMode}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={(event) => {
                        if (!referencePickerNodeId) handleCanvasMouseDown(event);
                    }}
                    onCanvasDeselect={referencePickerNodeId ? undefined : deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        if (referencePickerNodeId) return;
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", zIndex: 0 }}>
                        {visibleConnections.map(({ connection, from, to }) => (
                            <ConnectionPath
                                // Keep the Chromium SVG repaint workaround for moved endpoints;
                                // memoized unchanged edges still avoid redundant rendering.
                                key={`${connection.id}:${from.position.x}:${from.position.y}:${to.position.x}:${to.position.y}`}
                                connection={connection}
                                from={from}
                                to={to}
                                active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                onSelect={selectConnection}
                                onContextMenu={openConnectionMenu}
                            />
                        ))}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            referenceSelectionState={!referencePickerNodeId ? undefined : node.id === referencePickerNodeId ? "target" : referenceConnectedNodeIds.has(node.id) || !isCanvasReferenceNode(node, nodes) ? "disabled" : "available"}
                            showPanel={!isNodeResizing && dialogNodeId === node.id && !selectionBox && !getNodeDefinition(node.type)?.hidePanel}
                            groupChildCount={groupChildCountById.get(node.id) || 0}
                            isGroupDropTarget={dropTargetGroupId === node.id}
                            batchExpanded={expandedBatchNodeIds.has(node.id)}
                            showImageInfo={showImageInfo}
                            mentionReferences={mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES}
                            pluginHost={pluginHost}
                            promptHighlightSource={node.metadata?.promptVariableSourceNodeId ? nodeById.get(node.metadata.promptVariableSourceNodeId) : undefined}
                            promptHighlightParameters={node.metadata?.promptVariablePreviewOf ? nodeById.get(node.metadata.promptVariablePreviewOf) : undefined}
                            registryVersion={nodeRegistryVersion}
                            renderPanel={renderNodePanel}
                            renderNodeContent={renderNodeContentPanel}
                            onMouseDown={handleNodeMouseDown}
                            onSelectCapture={handleNodeSelectCapture}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResizeStart={handleNodeResizeStart}
                            onResize={handleNodeResize}
                            onResizeEnd={handleNodeResizeEnd}
                            onContentChange={handleNodeContentChange}
                            onTitleChange={handleNodeTitleChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onDuplicateBatchImage={duplicateBatchImage}
                            onDownloadBatchImage={downloadBatchImage}
                            onRetryBatchImage={retryBatchImage}
                            onDeleteBatchImage={deleteBatchImage}
                            onRetry={handleNodeRetry}
                            onViewImage={handleNodeViewImage}
                            onSelectReference={selectNodeReference}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {referencePickerNodeId ? <button type="button" className="absolute left-1/2 top-4 z-[90] -translate-x-1/2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} onClick={exitNodeReferenceSelection}>{t("canvas.references.selectingHint")}</button> : null}

                    {selectionBox ? (
                        <svg
                            className="pointer-events-none absolute z-[100] overflow-visible"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                            }}
                        >
                            <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeOpacity={0.55} strokeWidth={1 / viewport.k} strokeDasharray={`${6 / viewport.k} ${4 / viewport.k}`} />
                        </svg>
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </InfiniteCanvas>

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen || expandedBatchNodeIds.has(toolbarNode?.id || "") ? null : toolbarNode}
                    viewport={viewport}
                    extraTools={toolbarNode ? buildNodeToolbarItems(toolbarNode) : undefined}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onUseAsGlobalReference={useImageAsGlobalReference}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onViewImage={handleNodeViewImage}
                    onReversePrompt={createImageReversePromptNodes}
                    onTranslatePrompt={translatePromptNode}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                    onUngroup={(node) => ungroupSelection(new Set([node.id]))}
                />

                {hasMultipleSelectedNodes && !selectionBox ? (
                    <CanvasSelectionToolbar
                        nodes={selectedNodes}
                        viewport={viewport}
                        showToolbar={!isNodeDragging && !isNodeResizing}
                        canGroup={canGroupSelection}
                        canUngroup={canUngroupSelection}
                        onGroup={groupSelection}
                        onUngroup={ungroupSelection}
                    />
                ) : null}

                <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    canvasTool={canvasTool}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddAudio={() => createNode(CanvasNodeType.Audio)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddConfig={() => createNode(CanvasNodeType.Config)}
                    onAddGenerationConfigs={addGenerationConfigsForPromptNodes}
                    onGenerateAllConfigs={() => void generateAllConfigNodes()}
                    onCompleteAndGenerateAll={() => void completeAndGenerateAll()}
                    onAddPromptVariables={() => createNode(PROMPT_VARIABLES_NODE_TYPE)}
                    onAddGroup={() => createNode(CanvasNodeType.Group)}
                    onAddExtensionNode={(type) => createNode(type)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={() => handleUploadRequest()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onClear={() => setClearConfirmOpen(true)}
                    onCanvasToolChange={setCanvasTool}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                />

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        canCaptureVideoFrame={contextMenuNode?.type === CanvasNodeType.Video && Boolean(contextMenuNode.metadata?.content)}
                        canGroup={contextMenu.type === "node" && canGroupSelection}
                        canUngroup={contextMenu.type === "node" && canUngroupSelection}
                        onClose={() => setContextMenu(null)}
                        onCaptureVideoFrame={(position) => {
                            if (contextMenu.type !== "node") return;
                            void captureVideoNodeFrame(contextMenu.nodeId, position);
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onGroup={groupSelection}
                        onUngroup={ungroupSelection}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />
                <input ref={contentInputRef} type="file" accept=".zip,application/zip" aria-label="导入画布内容 ZIP" className="hidden" onChange={(event) => void importCurrentContents(event.target.files?.[0])} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />
                <CanvasPluginManagerModal open={pluginManagerOpen} onClose={() => setPluginManagerOpen(false)} />

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => setMaskEditNodeId(null)} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} />
                ) : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                ) : null}

                <Modal title={t("canvas.projectPage.superResolve")} open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">{t("canvas.projectPage.notImplemented")}</div>
                </Modal>

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                <Modal
                    title={t("canvas.projectPage.imageDetails")}
                    open={Boolean(previewContent)}
                    centered
                    onCancel={() => setPreviewNodeId(null)}
                    footer={null}
                    width={previewMetadata ? 980 : "auto"}
                    styles={{ body: { padding: 0, maxHeight: "80vh", overflow: "hidden" } }}
                >
                    {previewContent ? (
                        <div style={{ display: "flex", gap: 20, padding: 20, alignItems: "center", maxHeight: "80vh", background: theme.node.panel, color: theme.node.text }}>
                            <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", justifyContent: "center", alignItems: "center" }}>
                                <img src={previewContent} alt={previewNode?.title || t("assets.kinds.image")} style={{ maxWidth: "100%", maxHeight: "76vh", objectFit: "contain" }} />
                            </div>
                            {previewMetadata ? (
                                <div style={{ width: 280, flex: "0 0 280px", alignSelf: "stretch", overflowY: "auto", borderLeft: `1px solid ${theme.node.stroke}`, paddingLeft: 20 }}>
                                    {previewRows.map(([label, value]) => (
                                        <div key={label} style={{ padding: "10px 0", borderBottom: `1px solid ${theme.node.stroke}` }}>
                                            <div style={{ color: theme.node.muted, fontSize: 12, marginBottom: 4 }}>{label}</div>
                                            <div style={{ color: theme.node.text, fontSize: 14, wordBreak: "break-word" }}>{value}</div>
                                        </div>
                                    ))}
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", borderTop: `1px solid ${theme.node.stroke}`, marginTop: 4 }}>
                                        {previewGridRows.map(([label, value]) => (
                                            <div key={label} style={{ minWidth: 0, padding: "10px 6px", borderBottom: `1px solid ${theme.node.stroke}` }}>
                                                <div style={{ color: theme.node.muted, fontSize: 12, marginBottom: 4, whiteSpace: "nowrap" }}>{label}</div>
                                                <div style={{ color: theme.node.text, fontSize: 14, wordBreak: "break-word" }}>{value}</div>
                                            </div>
                                        ))}
                                    </div>
                                    {previewOriginal ? <button type="button" className="mt-3 rounded border px-3 py-2 text-sm" onClick={async () => {
                                        try {
                                            const blob = await readDownloadBlob({ kind: "image", storageKey: previewOriginal.storageKey });
                                            saveAs(blob, `generated-original.${imageExtension(blob.type)}`);
                                        } catch (error) { message.error(error instanceof Error ? error.message : "原图下载失败"); }
                                    }} style={{ borderColor: theme.node.stroke, background: theme.toolbar.itemHover, color: theme.node.text }}>下载生成原图</button> : null}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </Modal>

                <Modal
                    title={t("canvas.projectPage.clearTitle")}
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>{t("common.cancel")}</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                {t("canvas.projectPage.clear")}
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">{t("canvas.projectPage.clearDescription")}</p>
                </Modal>

                <AssetPickerModal open={assetPickerOpen} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
            </section>
        </main>
    );
}
