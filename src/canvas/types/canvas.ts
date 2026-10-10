export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasNodeImage = {
    name?: string;
    originalImage?: { storageKey: string; width: number; height: number; bytes: number; mimeType: string };
    deliveryNote?: string;
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
};

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    generationStartedAt?: number;
    generationAttempts?: Array<{ channel: string; model: string; error?: string }>;
    // Parameters parsed from an image prompt and copied to generated config cards.
    generationAspectRatio?: string;
    generationPixelWidth?: number;
    generationPixelHeight?: number;
    generationImageType?: string;
    generationParamsDetected?: boolean;
    generationParamsSourceNodeId?: string;
    channel?: string;
    channelId?: string;
    transport?: "direct" | "proxy";
    provider?: string;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    moderation?: string;
    background?: string;
    count?: number;
    textCount?: number;
    texts?: CanvasNodeText[];
    primaryTextId?: string;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoMode?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    upstreamSize?: string;
    originalImage?: { storageKey: string; width: number; height: number; bytes: number; mimeType: string };
    deliveryNote?: string;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    videoTaskId?: string;
    videoTaskProvider?: "openai" | "gemini";
    groupId?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
    // Values and source prompt used by the adaptive Excel prompt-variable node.
    promptVariableTemplateId?: string;
    promptVariablePromptKey?: string;
    promptVariablePromptTheme?: string;
    promptVariableCompositionLock?: string;
    promptVariablePurpose?: string;
    promptVariableSource?: "excel-marker" | "manual" | "ai";
    promptVariableProductName?: string;
    promptVariableFileName?: string;
    promptVariableRawPrompt?: string;
    promptVariableResolvedPrompt?: string;
    promptVariableTokens?: string[];
    promptVariableValues?: Record<string, string>;
    promptVariablePreviewNodeId?: string;
    promptVariableSourceNodeId?: string;
    promptVariablePreviewOf?: string;
    promptVariableEnglishPreviewOf?: string;
    promptVariableTranslationOf?: string;
    promptVariableTranslationLanguage?: "en" | "zh";
    // Excel prompt-card metadata. The prompt card owns this schema; values
    // are supplied by a connected adaptive product-parameter node.
    excelPromptTemplateId?: string;
    excelPromptKey?: string;
    excelPromptLabel?: string;
    excelPromptTheme?: string;
    excelPromptCompositionLock?: string;
    excelPromptPurpose?: string;
    excelPromptTokens?: string[];
    excelPromptRaw?: string;
    excelPromptSkippedValue?: string;
    excelPromptResolved?: string;
    excelPromptBindingNodeId?: string;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
