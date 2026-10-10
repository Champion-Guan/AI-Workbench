import { useEffect, useMemo, useState } from "react";
import { Braces } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { localizePromptTheme } from "@/lib/canvas/prompt-theme-labels";
import { readCurrentParameterValues, saveCurrentParameterValues } from "@/lib/canvas/parameter-memory";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeContext, CanvasNodeResource } from "@/types/canvas-plugin";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export const PROMPT_VARIABLES_NODE_TYPE = "guan:prompt-variables";

export type ExcelPromptTemplate = {
    id: string;
    route: string;
    prompts: Record<string, string>;
};

export type ExcelPromptSpec = {
    key: string;
    label: string;
    kind: "main" | "detail" | "rich" | "video" | "other";
    theme: string;
    compositionLock: string;
    purpose: string;
    prompt: string;
    tokens: string[];
};

export type ExcelPromptContext = {
    fileName: string;
    activeProductName: string;
    templates: ExcelPromptTemplate[];
};

type WindowWithExcelPromptContext = Window & {
    __guanExcelPromptContext?: ExcelPromptContext;
};

const VARIABLE_PATTERN = /\[[^\]\r\n]{1,160}\]/g;
const OMITTED_VARIABLES = [/^\[\d+\s*[-–—]\s*\d+秒/i, /^\[FILL WITH VERIFIED PRODUCT DATA\]$/i, /^\[PRODUCT PHOTO\/CAD\]$/i, /^\[待填写\]$/, /^\[我的产品变量\]$/, /^\[补充自有产品/i, /^\[node:/i, /^\[\d+\]$/];

export function readExcelPromptContext(): ExcelPromptContext {
    if (typeof window === "undefined") return { fileName: "", activeProductName: "", templates: [] };
    const context = (window as WindowWithExcelPromptContext).__guanExcelPromptContext;
    if (!context || !Array.isArray(context.templates)) return { fileName: "", activeProductName: "", templates: [] };
    return {
        fileName: String(context.fileName || ""),
        activeProductName: String(context.activeProductName || ""),
        templates: context.templates
            .filter((template) => template && typeof template === "object")
            .map((template) => ({
                id: String(template.id || ""),
                route: String(template.route || ""),
                prompts: Object.fromEntries(Object.entries(template.prompts || {}).map(([key, value]) => [key, String(value || "")]).filter(([, value]) => value.trim())),
            }))
            .filter((template) => Object.keys(template.prompts).length > 0),
    };
}

export function promptVariableTokens(prompt: string) {
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const token of prompt.match(VARIABLE_PATTERN) || []) {
        const normalized = token.trim();
        if (!normalized || seen.has(normalized) || OMITTED_VARIABLES.some((pattern) => pattern.test(normalized))) continue;
        seen.add(normalized);
        tokens.push(normalized);
    }
    return tokens;
}

export function resolvePromptVariables(prompt: string, values: Record<string, string> = {}) {
    return prompt.replace(VARIABLE_PATTERN, (token) => {
        const value = String(values[token] ?? "").trim();
        return value || token;
    });
}

function productName(route: string) {
    return String(route || "").split(/[|｜]/, 1)[0].trim();
}

const VARIABLE_LABELS: Record<string, string> = {
    "PRODUCT PHOTO/CAD": "产品图片/CAD",
    "PRODUCT NAME": "产品名称",
    "MY BRAND": "我的品牌",
    "MY SKU": "我的 SKU",
    "BODY MATERIAL": "主体材质",
    DIMENSIONS: "尺寸",
    "CORE FEATURE 1": "核心卖点 1",
    "CORE FEATURE 2": "核心卖点 2",
    "CORE FEATURE 3": "核心卖点 3",
    "KIT CONTENTS AND QUANTITIES": "套件内容及数量",
    "NEEDLE / THREAD SPECIFICATION": "针线规格",
    "CASE OR STORAGE TYPE": "收纳盒/存储类型",
    "WARRANTY AND AFTER-SALES LIMITS": "质保及售后范围",
    "VERIFIED TEST EVIDENCE": "已验证的测试证据",
    "ACTUAL PARAMETERS": "实际参数",
    "SHORT RUSSIAN TITLE": "俄文短标题",
    "MATERIAL": "材质",
    "USE SCENARIO": "使用场景",
    "SURFACE FINISH": "表面处理",
    "COLOR": "颜色",
    "KIT USE CASE": "套件用途",
    "TOOL AND ACCESSORY LIST": "工具及配件清单",
    "KIT QUANTITY": "套件数量",
    "CASE SIZE": "收纳盒尺寸",
    "STORAGE FORMAT": "收纳方式",
    "ACCESSORIES AND QUANTITIES": "配件及数量",
    "RUSSIAN SHORT HEADLINE": "俄文短标题",
    "NEEDLE TYPE": "编织针类型",
    "NEEDLE SIZE / DIAMETER": "针号/直径",
    "NEEDLE SIZE RANGE": "针号范围",
    "CABLE OR NEEDLE LENGTH": "连接线或针身长度",
    "TIP MATERIAL": "针尖材质",
    "SET CONTENTS AND QUANTITIES": "套装内容及数量",
    "LENGTH": "长度",
    "CONNECTION / CABLE": "连接方式/连接线",
    "SET CONTENTS": "套装内容",
    "BRAND NAME": "品牌名称",
    "MODEL NUMBER": "型号",
    "PRODUCT CATEGORY": "产品类别",
    "PRODUCT DESCRIPTION": "产品描述",
    "TARGET AUDIENCE": "适用人群",
    "AGE RANGE": "适用年龄",
    "PACKAGE CONTENTS": "包装内容",
    "PACKAGE SIZE": "包装尺寸",
    "PACKAGE DIMENSIONS": "包装尺寸",
    "NET WEIGHT": "净重",
    "GROSS WEIGHT": "毛重",
    "LOAD CAPACITY": "承重能力",
    "MAX LOAD": "最大承重",
    "POWER SUPPLY": "供电方式",
    "POWER CONSUMPTION": "耗电量",
    "BATTERY CAPACITY": "电池容量",
    "BATTERY LIFE": "续航时间",
    "CHARGING TIME": "充电时间",
    "CABLE LENGTH": "线缆长度",
    "OPERATING TEMPERATURE": "工作温度",
    "TEMPERATURE RANGE": "温度范围",
    "WATERPROOF RATING": "防水等级",
    "IP RATING": "防护等级",
    "COMPATIBLE DEVICES": "兼容设备",
    "COMPATIBLE MODELS": "兼容型号",
    "MOUNTING TYPE": "安装方式",
    "INSTALLATION METHOD": "安装方式",
    "CARE INSTRUCTIONS": "保养说明",
    "WASHING INSTRUCTIONS": "洗涤说明",
    "SAFETY WARNINGS": "安全警告",
    "COUNTRY OF ORIGIN": "原产国",
    "SHELF LIFE": "保质期",
    "EXPIRATION DATE": "有效期",
    "FOOD GRADE": "食品级标准",
    "BPA FREE": "不含双酚A",
    "KEY BENEFITS": "主要优势",
    "SELLING POINTS": "卖点",
    "USE CASE": "用途",
    "USE CASES": "用途",
    "USAGE SCENARIO": "使用场景",
    "USAGE SCENARIOS": "使用场景",
    "CORE FEATURES": "核心卖点",
    "RUSSIAN TITLE": "俄文标题",
    "RUSSIAN HEADLINE": "俄文标题",
    "SHORT HEADLINE": "短标题",
    "CALL TO ACTION": "行动引导文案",
    "ASPECT RATIO": "宽高比",
    "BACKGROUND COLOR": "背景颜色",
    "TEXT COLOR": "文字颜色",
    "FONT SIZE": "字号",
    "THREAD SIZE": "螺纹规格",
    "THREAD COUNT": "织物纱线密度",
    "FABRIC COMPOSITION": "面料成分",
    "FIT TYPE": "版型",
    "HEEL HEIGHT": "鞋跟高度",
    "SOLE MATERIAL": "鞋底材质",
    "HANDLE MATERIAL": "手柄材质",
    "BLADE MATERIAL": "刀片材质",
    "NEEDLE SIZE": "针号",
    "NEEDLE DIAMETER": "针径",
    "NEEDLE LENGTH": "针身长度",
    "CONNECTION TYPE": "连接类型",
    "SET QUANTITY": "套装数量",
    "ACCESSORY LIST": "配件清单",
    "ACCESSORIES LIST": "配件清单",
};

function normalizeVariableKey(key: string) {
    return key.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()
        .replace(/\((MM|CM|M|G|KG|ML|L|W|V|A|MAH|HZ|RPM|PX)\)/g, " $1 ")
        .replace(/[_–—-]+/g, " ").replace(/\s*\/\s*/g, " / ")
        .replace(/\s*&\s*/g, " AND ").replace(/\s+/g, " ").trim();
}

const NORMALIZED_VARIABLE_LABELS = Object.fromEntries(Object.entries(VARIABLE_LABELS).map(([key, label]) => [normalizeVariableKey(key), label]));
// Conservative phrase composition: translate only when every part is known.
// Never alter stored variable keys or partially guess an unknown technical term.
const VARIABLE_WORDS: Record<string, string> = {
    "CORE FEATURE": "核心卖点", "KEY FEATURE": "主要功能", "SELLING POINT": "卖点",
    "USE SCENARIO": "使用场景", "USE CASE": "用途", "SURFACE FINISH": "表面处理",
    PRODUCT: "产品", BRAND: "品牌", MODEL: "型号", MODELS: "型号", SKU: "SKU", NAME: "名称",
    TYPE: "类型", CATEGORY: "类别", DESCRIPTION: "描述", MATERIAL: "材质", MATERIALS: "材质",
    COLOR: "颜色", COLOUR: "颜色", COLORS: "颜色", COLOURS: "颜色", SIZE: "尺寸", SIZES: "尺寸",
    DIMENSION: "尺寸", DIMENSIONS: "尺寸", LENGTH: "长度", WIDTH: "宽度", HEIGHT: "高度",
    DEPTH: "深度", THICKNESS: "厚度", DIAMETER: "直径", RADIUS: "半径", WEIGHT: "重量",
    CAPACITY: "容量", VOLUME: "容积", QUANTITY: "数量", QUANTITIES: "数量", COUNT: "数量",
    SET: "套装", KIT: "套件", PACKAGE: "包装", PACKAGING: "包装", CONTENTS: "内容",
    ACCESSORY: "配件", ACCESSORIES: "配件", TOOL: "工具", TOOLS: "工具", LIST: "清单",
    SPECIFICATION: "规格", SPECIFICATIONS: "规格", PARAMETER: "参数", PARAMETERS: "参数",
    FEATURE: "功能", FEATURES: "功能", FUNCTION: "功能", FUNCTIONS: "功能", BENEFIT: "优势", BENEFITS: "优势",
    COMPATIBLE: "兼容", COMPATIBILITY: "兼容性", DEVICE: "设备", DEVICES: "设备",
    POWER: "功率", VOLTAGE: "电压", CURRENT: "电流", FREQUENCY: "频率", SPEED: "速度",
    BATTERY: "电池", CHARGING: "充电", TIME: "时间", TEMPERATURE: "温度", RANGE: "范围",
    HANDLE: "手柄", TIP: "针尖", NEEDLE: "编织针", CABLE: "连接线", CONNECTION: "连接",
    CASE: "收纳盒", STORAGE: "收纳", FORMAT: "方式", WARRANTY: "质保", CERTIFICATION: "认证",
    CERTIFICATIONS: "认证", SAFETY: "安全", STANDARD: "标准", STANDARDS: "标准",
    FABRIC: "面料", PATTERN: "图案", STYLE: "风格", SCENT: "香型", INGREDIENTS: "成分",
    USAGE: "使用方法", INSTRUCTIONS: "说明", INSTALLATION: "安装", CLEANING: "清洁", CARE: "保养",
    PRICE: "价格", CURRENCY: "币种", ORIGIN: "产地", COUNTRY: "国家", BRANDING: "品牌标识",
    TITLE: "标题", HEADLINE: "标题", SUBTITLE: "副标题", TEXT: "文字", LANGUAGE: "语言",
    BACKGROUND: "背景", LIGHTING: "光照", ANGLE: "角度", RESOLUTION: "分辨率", DURATION: "时长",
    MY: "我的", ACTUAL: "实际", VERIFIED: "已验证", MAX: "最大", MAXIMUM: "最大", MIN: "最小", MINIMUM: "最小",
    AND: "及", OR: "或", "/": "/",
};

function variableLabel(token: string) {
    const key = token.replace(/^\[/, "").replace(/\]$/, "").trim();
    if (/[\u3400-\u9fff]/.test(key)) return key;
    const normalized = normalizeVariableKey(key);
    if (NORMALIZED_VARIABLE_LABELS[normalized]) return NORMALIZED_VARIABLE_LABELS[normalized];
    const parts = normalized.split(" ");
    const translated: string[] = [];
    for (let i = 0; i < parts.length;) {
        let matched = false;
        for (let length = Math.min(3, parts.length - i); length > 0; length--) {
            const phrase = parts.slice(i, i + length).join(" ");
            const label = NORMALIZED_VARIABLE_LABELS[phrase] || VARIABLE_WORDS[phrase];
            if (!label) continue;
            translated.push(label);
            i += length;
            matched = true;
            break;
        }
        if (matched) continue;
        // Retain numbered fields and common measurement units in the heading.
        if (/^\d+$/.test(parts[i]) || /^(MM|CM|M|G|KG|ML|L|W|V|A|MAH|HZ|RPM|PX)$/.test(parts[i])) {
            translated.push(` ${parts[i]}`);
            i++;
        } else {
            return `变量 ${token}`;
        }
    }
    return translated.some((part) => /[\u3400-\u9fff]/.test(part)) ? translated.join("") : `变量 ${token}`;
}

function promptEntries(template: ExcelPromptTemplate | undefined) {
    return Object.entries(template?.prompts || {}).filter(([, prompt]) => String(prompt || "").trim());
}

function promptKind(key: string): ExcelPromptSpec["kind"] {
    if (key === "Main Prompt") return "main";
    if (/^Detail Prompt \d+$/i.test(key)) return "detail";
    if (/^Rich Prompt \d+$/i.test(key)) return "rich";
    if (key === "Video Prompt") return "video";
    return "other";
}

function promptLabel(key: string) {
    if (key === "Main Prompt") return "主图提示词";
    if (key === "Video Prompt") return "视频提示词";
    const detail = key.match(/^Detail Prompt (\d+)$/i);
    if (detail) return `详情页提示词${detail[1]}`;
    const rich = key.match(/^Rich Prompt (\d+)$/i);
    if (rich) return `富内容提示词${rich[1]}`;
    return key;
}

export function parseExcelPromptSpec(key: string, prompt: string): ExcelPromptSpec {
    const text = String(prompt || "");
    const compositionLock = text.match(/COMPOSITION LOCK:\s*([^\.\n]+)/i)?.[1]?.trim() || "";
    const explicitTheme = text.match(/(?:主题(?:\/角度)?|Theme|核心视觉|Core visual|Visual focus|画面重点|重点)\s*[：:]\s*([^\.\n]+)/i)?.[1]?.trim() || compositionLock;
    const themeRules: Array<[string, RegExp]> = [
        ["收纳/折叠", /fold|storage|case|portable|compact|收纳|折叠|便携/i],
        ["角度/调节", /angle|degree|tilt|viewing angle|倾角|角度|调节|截止线/i],
        ["安装/兼容", /install|installation|fitment|compatib|adapter|安装|兼容|适配/i],
        ["尺寸/规格", /dimension|size|specification|measurement|尺寸|规格|参数/i],
        ["材质/结构", /material|structure|heat dissipation|散热|材质|结构/i],
        ["配件/数量", /accessor|contents|quantity|kit|included|配件|套装|数量|清单/i],
        ["使用场景", /scene|use case|scenario|workbench|桌面|场景|使用/i],
        ["核心功能/卖点", /core feature|key selling|selling point|功能|卖点|优势/i],
    ];
    const scored = themeRules.map(([label, pattern]) => [label, (text.match(new RegExp(pattern.source, `${pattern.flags}g`)) || []).length] as const).sort((a, b) => b[1] - a[1]);
    const kindFallback = /^Main/i.test(key) ? "主图｜产品全貌与核心卖点" : /^Rich/i.test(key) ? "富内容｜模块化信息与证据" : /^Video/i.test(key) ? "视频｜使用场景与功能演示" : `详情图${key.match(/(\d+)/)?.[1] || ""}｜单一卖点`;
    const theme = localizePromptTheme(explicitTheme || (scored[0]?.[1] > 0 ? scored[0][0] : kindFallback));
    const purpose = text.match(/(?:Module purpose|模块)\s*[：:]\s*([^\.\n]+)/i)?.[1]?.trim() || "";
    return { key, label: promptLabel(key), kind: promptKind(key), theme, compositionLock, purpose, prompt: text, tokens: promptVariableTokens(text) };
}

function promptSpecs(template: ExcelPromptTemplate | undefined) {
    return promptEntries(template).map(([key, prompt]) => parseExcelPromptSpec(key, prompt));
}

function defaultTemplate(context: ExcelPromptContext) {
    return context.templates.find((template) => promptEntries(template).some(([key]) => key === "Main Prompt")) || context.templates[0];
}

function defaultPromptKey(template: ExcelPromptTemplate | undefined) {
    const entries = promptEntries(template);
    return entries.find(([key]) => key === "Main Prompt")?.[0] || entries[0]?.[0] || "";
}

function productVariableTokens(context: ExcelPromptContext) {
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const template of context.templates) {
        for (const [, prompt] of promptEntries(template)) {
            for (const token of promptVariableTokens(prompt)) {
                if (!seen.has(token)) {
                    seen.add(token);
                    tokens.push(token);
                }
            }
        }
    }
    return tokens;
}

export function buildPromptVariablesMetadata(context = readExcelPromptContext(), template = defaultTemplate(context), promptKey = defaultPromptKey(template), previousValues: Record<string, string> = readCurrentParameterValues()): CanvasNodeMetadata {
    const prompt = String(template?.prompts?.[promptKey] || "");
    const spec = parseExcelPromptSpec(promptKey, prompt);
    const tokens = promptVariableTokens(prompt);
    const values = { ...previousValues, ...Object.fromEntries(tokens.map((token) => [token, String(previousValues[token] || "")])) };
    return {
        status: "success",
        promptVariableTemplateId: template?.id || "",
        promptVariablePromptKey: promptKey,
        promptVariablePromptTheme: spec.theme,
        promptVariableCompositionLock: spec.compositionLock,
        promptVariablePurpose: spec.purpose,
        promptVariableSource: "excel-marker",
        promptVariableProductName: productName(template?.route || "") || context.activeProductName,
        promptVariableFileName: context.fileName,
        promptVariableRawPrompt: prompt,
        promptVariableTokens: tokens,
        promptVariableValues: values,
        promptVariableResolvedPrompt: resolvePromptVariables(prompt, values),
    };
}

export function promptVariablesResource(node: CanvasNodeData): CanvasNodeResource | null {
    const text = resolvePromptVariables(node.metadata?.promptVariableRawPrompt || "", node.metadata?.promptVariableValues);
    return text.trim() ? { kind: "text", text } : null;
}

function pickCurrentTemplate(context: ExcelPromptContext, metadata: CanvasNodeMetadata) {
    return context.templates.find((template) => template.id === metadata.promptVariableTemplateId) || defaultTemplate(context);
}

export function PromptVariablesContent({ ctx }: { ctx: CanvasNodeContext }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [context, setContext] = useState(readExcelPromptContext);
    const metadata = ctx.node.metadata || {};
    const currentTemplate = useMemo(() => pickCurrentTemplate(context, metadata), [context, metadata.promptVariableTemplateId]);
    const linkedPromptNode = metadata.promptVariableSourceNodeId ? ctx.getNode(metadata.promptVariableSourceNodeId) : null;
    const linkedPrompt = linkedPromptNode ? String(linkedPromptNode.metadata?.content || linkedPromptNode.metadata?.prompt || "").trim() : "";
    const currentPrompt = linkedPrompt || metadata.promptVariableRawPrompt || "";
    const productTokens = useMemo(() => productVariableTokens(context), [context]);
    const linkedTokens = ctx.getNodes().filter((node) => node.metadata?.excelPromptBindingNodeId === ctx.node.id && !node.metadata?.promptVariablePreviewOf)
        .flatMap((node) => promptVariableTokens(node.metadata?.excelPromptRaw || node.metadata?.content || node.metadata?.prompt || ""));
    const tokens = Array.from(new Set([...(productTokens || []), ...(metadata.promptVariableTokens || []), ...linkedTokens, ...promptVariableTokens(currentPrompt)]));
    const values = metadata.promptVariableValues || {};

    useEffect(() => {
        // Migrate existing cards as well as restoring cards created after deletion.
        const current = ctx.getNode(ctx.node.id)?.metadata?.promptVariableValues || {};
        const restored = { ...current, ...readCurrentParameterValues() };
        saveCurrentParameterValues(restored);
        if (Object.keys(restored).some((token) => restored[token] !== current[token])) {
            ctx.updateMetadata({ promptVariableValues: restored });
        }
    }, [ctx.node.id]);

    useEffect(() => {
        const refresh = () => setContext(readExcelPromptContext());
        window.addEventListener("guan-excel-prompts-updated", refresh);
        return () => window.removeEventListener("guan-excel-prompts-updated", refresh);
    }, []);

    useEffect(() => {
        if (!tokens.length) return;
        const nextValues = { ...values, ...Object.fromEntries(tokens.map((token) => [token, String(values[token] || "")])) };
        if (tokens.some((token) => values[token] === undefined)) ctx.updateMetadata({ promptVariableTokens: tokens, promptVariableValues: nextValues });
    }, [ctx, tokens, values]);

    const updateValue = (token: string, value: string) => {
        const nextValues = { ...ctx.getNode(ctx.node.id)?.metadata?.promptVariableValues, [token]: value };
        // Synchronous per-keystroke backup survives immediate deletion before autosave.
        saveCurrentParameterValues({ [token]: value });
        const nextMetadata: CanvasNodeMetadata = {
            promptVariableValues: nextValues,
            promptVariableTokens: tokens,
        };
        const linkedRaw = linkedPrompt || metadata.promptVariableRawPrompt || "";
        const resolved = resolvePromptVariables(linkedRaw, nextValues);
        if (linkedRaw) nextMetadata.promptVariableResolvedPrompt = resolved;
        const ops = [{ type: "update_node" as const, id: ctx.node.id, metadata: nextMetadata }];
        const nodes = ctx.getNodes();
        const connections = ctx.getConnections();
        const sources = nodes.filter((node) => node.id !== ctx.node.id && !node.metadata?.promptVariablePreviewOf && (
            node.metadata?.excelPromptBindingNodeId === ctx.node.id ||
            connections.some((edge) => (edge.fromNodeId === ctx.node.id && edge.toNodeId === node.id) || (edge.toNodeId === ctx.node.id && edge.fromNodeId === node.id))
        ) && typeof node.metadata?.content === "string");
        for (const source of sources) {
            const raw = source.metadata?.content ?? source.metadata?.excelPromptRaw ?? source.metadata?.prompt ?? "";
            const text = resolvePromptVariables(raw, nextValues);
            ops.push({ type: "update_node", id: source.id, metadata: { excelPromptResolved: text, excelPromptBindingNodeId: ctx.node.id } });
            for (const preview of nodes.filter((node) => node.metadata?.promptVariablePreviewOf === ctx.node.id && node.metadata?.promptVariableSourceNodeId === source.id)) {
                ops.push({ type: "update_node", id: preview.id, metadata: { content: text, prompt: text, status: "success" } });
            }
        }
        if (ops.length > 1) {
            ctx.applyOps(ops);
        } else {
            ctx.updateMetadata(nextMetadata);
        }
    };

    return (
        <div
            data-canvas-no-zoom
            className="flex h-full w-full min-h-0 flex-col overflow-hidden rounded-[inherit] p-3 text-sm"
            style={{ color: theme.node.text }}
            onMouseDown={(event) => { if ((event.target as HTMLElement).closest("input, textarea, select, button")) event.stopPropagation(); }}
            onPointerDown={(event) => { if ((event.target as HTMLElement).closest("input, textarea, select, button")) event.stopPropagation(); }}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ background: theme.toolbar.itemHover, color: theme.toolbar.activeText }}><Braces className="size-4" /></span>
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">产品参数设置</div>
                        <div className="truncate text-[11px] opacity-60">{metadata.promptVariableProductName || context.activeProductName || "当前 Excel 产品"}</div>
                    </div>
                </div>
            </div>

            {!tokens.length ? (
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border px-4 text-center text-xs opacity-65" style={{ borderColor: theme.node.stroke }}>
                    {context.templates.length ? "当前提示词没有可填写的变量" : "请先上传 Excel 并识别提示词"}
                </div>
            ) : (
                <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                    {tokens.map((token) => (
                        <label key={token} className="block text-[11px] text-black dark:text-white">
                            <span className="mb-1 block truncate" title={token}>{variableLabel(token)}</span>
                            <input value={values[token] || ""} onChange={(event) => updateValue(token, event.target.value)} onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} className="h-8 w-full rounded-lg border bg-transparent px-2 text-xs outline-none transition focus:border-stone-700 focus:ring-2 focus:ring-stone-300/70 dark:focus:border-stone-200 dark:focus:ring-stone-500/50" style={{ borderColor: theme.node.stroke, color: theme.node.text }} placeholder={token} />
                        </label>
                    ))}
                </div>
            )}
            <div className="mt-2 truncate text-[10px] opacity-55">{context.fileName || "未识别 Excel"} · {tokens.length} 个变量 · 连接提示词卡片后生成最终提示词</div>
        </div>
    );
}
