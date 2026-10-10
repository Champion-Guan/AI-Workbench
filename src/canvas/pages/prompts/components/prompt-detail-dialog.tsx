import { Copy, FileText, FolderPlus } from "lucide-react";
import { Button, Modal, Space, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";

function promptDetails(prompt: Prompt) {
    const theme = prompt.excelPrompt?.theme || prompt.prompt.match(/COMPOSITION LOCK:\s*([^\.\n]+)/i)?.[1]?.trim() || "";
    const purpose = prompt.excelPrompt?.purpose || prompt.prompt.match(/(?:Module purpose|模块)\s*[：:]\s*([^\.\n]+)/i)?.[1]?.trim() || "";
    const size = prompt.prompt.match(/\b(\d{3,5})\s*[x×]\s*(\d{3,5})\s*px\b/i);
    const ratio = prompt.prompt.match(/\b(\d+\s*:\s*\d+)\s*(?:vertical|horizontal|portrait|landscape)?\b/i);
    const imageType = prompt.prompt.match(/\b(MAIN IMAGE|DETAIL IMAGE|RICH CONTENT IMAGE|VIDEO FRAME)\b/i)?.[1] || "";
    const generationTerms = [size?.[0], ratio?.[1], imageType].filter(Boolean);
    const generationParams = [
        size ? `${size[1]} × ${size[2]} px` : "",
        ratio ? ratio[1].replace(/\s+/g, "") : "",
        imageType === "MAIN IMAGE" ? "主图" : imageType === "DETAIL IMAGE" ? "详情图" : imageType === "RICH CONTENT IMAGE" ? "富内容图" : imageType === "VIDEO FRAME" ? "视频画面" : "",
    ].filter(Boolean).join(" · ");
    return { theme, purpose, generationParams, generationTerms, compositionLock: prompt.excelPrompt?.compositionLock || "" };
}

function highlightedPrompt(prompt: Prompt) {
    const { theme, purpose, generationParams, generationTerms, compositionLock } = promptDetails(prompt);
    const terms = [...new Set([theme, purpose, compositionLock, generationParams, ...generationTerms, ...(prompt.excelPrompt?.tokens || []), ...theme.split(/[\s,;/]+/).filter((word) => word.length >= 4)])].filter((term): term is string => Boolean(term)).sort((a, b) => b.length - a.length);
    if (!terms.length) return prompt.prompt;
    const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
    return prompt.prompt.split(pattern).map((part, index) => index % 2 ? <mark key={index} className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-500/30">{part}</mark> : part);
}

export function PromptDetailDialog({ prompt, onClose, onCopy, onSaveAsset }: { prompt: Prompt | null; onClose: () => void; onCopy: (prompt: string) => void; onSaveAsset?: (prompt: Prompt) => void }) {
    const { i18n, t } = useTranslation();
    const details = prompt ? promptDetails(prompt) : null;
    const title = prompt && details?.theme && !prompt.title.endsWith(` · ${details.theme}`) ? `${prompt.title} · ${details.theme}` : prompt?.title;
    const summary = details?.theme || details?.generationParams ? `${details.theme ? `主题/角度：${details.theme}` : ""}${details.purpose ? `\n画面任务：${details.purpose}` : ""}${details.generationParams ? `\n生成参数：${details.generationParams}` : ""}`.trim() : prompt?.preview;

    return (
        <Modal title={title} open={Boolean(prompt)} onCancel={onClose} footer={null} width={720} centered styles={{ body: { height: "calc(85vh - 55px)", overflow: "hidden" } }}>
            {prompt ? (
                <div className="flex h-full min-h-0 flex-col">
                    <div className="shrink-0 space-y-3 pb-4">
                        {prompt.coverUrl ? <img src={prompt.coverUrl} alt={prompt.title} className="h-48 w-full rounded-lg object-cover sm:h-56" /> : <div className="grid h-48 w-full place-items-center rounded-lg bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-600 sm:h-56"><FileText className="size-9" /></div>}
                        {prompt.referenceImageUrls.length > 1 ? <div className="grid grid-cols-6 gap-2">{prompt.referenceImageUrls.filter((url) => url !== prompt.coverUrl).slice(0, 6).map((url) => <img key={url} src={url} alt="" className="aspect-square w-full rounded-md object-cover" loading="lazy" />)}</div> : null}
                    </div>
                    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto border-y border-stone-200 py-4 pr-2 dark:border-stone-800">
                        <div className="flex flex-wrap gap-1.5">
                            {prompt.tags.map((tag) => (
                                <Tag key={tag} className="m-0">
                                    {tag}
                                </Tag>
                            ))}
                        </div>
                        {prompt.description ? <p className="mt-4 text-sm leading-6 text-stone-500 dark:text-stone-400">{prompt.description}</p> : null}
                        {summary ? <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-stone-100 p-3 text-xs leading-5 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{summary}</pre> : null}
                        <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-stone-800 dark:text-stone-300">{highlightedPrompt(prompt)}</p>
                        {prompt.createdAt || prompt.updatedAt ? <div className="mt-4 text-xs text-stone-500 dark:text-stone-400">{prompt.createdAt ? t("common.created", { date: formatPromptDate(prompt.createdAt, i18n.resolvedLanguage) }) : null}{prompt.createdAt && prompt.updatedAt ? " · " : null}{prompt.updatedAt ? t("common.updated", { date: formatPromptDate(prompt.updatedAt, i18n.resolvedLanguage) }) : null}</div> : null}
                    </div>
                    <div className="shrink-0 pt-4">
                        <Space wrap>
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(prompt.prompt)}>
                                {t("common.copyPrompt")}
                            </Button>
                            {onSaveAsset ? (
                                <Button icon={<FolderPlus className="size-4" />} onClick={() => onSaveAsset(prompt)}>
                                    {t("common.addToAssets")}
                                </Button>
                            ) : null}
                        </Space>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
