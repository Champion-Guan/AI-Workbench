import { useRef, useState, type ReactNode } from "react";
import { ConfigProvider, Switch } from "antd";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { darkSwitchTokens } from "@/lib/app-theme";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, readMediaDimensions } from "@/lib/media-size";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { dimensionsFromAnchor } from "@/lib/ratio-dimensions.js";

const qualityOptions = [
    { value: "auto", labelKey: "auto" },
    { value: "max", labelKey: "max" },
    { value: "xhigh", labelKey: "xhigh" },
    { value: "high", labelKey: "high" },
    { value: "medium", labelKey: "medium" },
    { value: "low", labelKey: "low" },
];
const DIMENSION_STEP = 16;
const ADVANCED_QUALITY_VALUES = new Set(["xhigh", "max"]);

export function supportsAdvancedImageQuality(model: string) {
    const name = modelOptionName(model).trim().toLowerCase();
    return /^(?:gpt-image-2\.5-(?:sunburst|flare))(?:-\d{4}-\d{2}-\d{2})?$/.test(name);
}

export function imageQualityOptionsForModel(model: string) {
    const advanced = supportsAdvancedImageQuality(model);
    return qualityOptions.filter((item) => advanced || !ADVANCED_QUALITY_VALUES.has(item.value));
}

export function imageQualityForModel(quality: string, model: string) {
    return !supportsAdvancedImageQuality(model) && ADVANCED_QUALITY_VALUES.has(quality) ? "auto" : quality;
}

export const imageQualityOptions = imageQualityOptionsForModel("").map((item) => ({ value: item.value, get label() { return i18n.t(`settingsPanels.common.${item.labelKey}`); } }));
export function imageQualityOptionsForAgent(model: string) {
    return imageQualityOptionsForModel(model).map((item) => ({ value: item.value, get label() { return i18n.t(`settingsPanels.common.${item.labelKey}`); } }));
}
export const imageAspectOptions = mediaRatioOptions.map((item) => ({ value: item.value, label: item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value }));
export const imageScaleOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? i18n.t("settingsPanels.common.auto") : value }));

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "moderation" | "size" | "count" | "background", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    quickCount?: number;
    model?: string;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", maxCount = 15, quickCount = 10, model }: ImageSettingsPanelProps) {
    const { t } = useTranslation();
    const [snapDimensionToStep, setSnapDimensionToStep] = useState(false);
    const dimensionAnchor = useRef<{ key: "width" | "height"; value: number } | null>(null);
    const quality = config.quality || "auto";
    const imageModel = model || config.model || config.imageModel;
    const visibleQualityOptions = imageQualityOptionsForModel(imageModel);
    const selectedQuality = imageQualityForModel(quality, imageModel);
    const moderation = config.moderation === "low" ? "low" : "auto";
    const count = Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const transparentBackground = config.background === "transparent";
    const selectedScale = inferMediaScale(activeSize);
    const selectedRatio = inferMediaRatio(activeSize);
    const dimensions = readMediaDimensions(activeSize, selectedScale, selectedRatio);
    const applySize = (scale: string, ratio: string) => onConfigChange("size", computeMediaSize(scale, ratio));
    const selectScale = (scale: string) => {
        dimensionAnchor.current = null;
        applySize(scale, selectedRatio === "auto" ? "1:1" : selectedRatio);
    };
    const selectRatio = (ratio: string) => {
        const anchor = dimensionAnchor.current;
        const next = anchor ? dimensionsFromAnchor(anchor.key, anchor.value, ratio, snapDimensionToStep) : null;
        if (next) onConfigChange("size", `${next.width}x${next.height}`);
        else applySize(selectedScale, ratio);
    };
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        dimensionAnchor.current = { key, value: alignDimension(next, snapDimensionToStep) };
        const width = key === "width" ? next : dimensions.width;
        const height = key === "height" ? next : dimensions.height;
        onConfigChange("size", `${alignDimension(width, snapDimensionToStep)}x${alignDimension(height, snapDimensionToStep)}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className={className}
                style={{ color: theme.node.text }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    if (event.target instanceof HTMLInputElement) return;
                    if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
                }}
            >
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.image.title")}</div> : null}
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.quality")}</SettingTitle>
                    <div className={`grid gap-2.5 ${visibleQualityOptions.length > 4 ? "grid-cols-3" : "grid-cols-4"}`}>
                        {visibleQualityOptions.map((item) => (
                            <OptionPill key={item.value} selected={selectedQuality === item.value} theme={theme} onClick={() => onConfigChange("quality", item.value)}>
                                {t(`settingsPanels.common.${item.labelKey}`)}
                            </OptionPill>
                        ))}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.moderation")}</SettingTitle>
                    <div className="grid grid-cols-2 gap-2.5">
                        {(["auto", "low"] as const).map((value) => (
                            <OptionPill key={value} selected={moderation === value} theme={theme} onClick={() => onConfigChange("moderation", value)}>
                                {t(`settingsPanels.common.${value}`)}
                            </OptionPill>
                        ))}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.size")}</SettingTitle>
                        <span className="guan-size-align-toggle flex items-center gap-2 text-xs" style={{ color: theme.node.muted }} title="开启后，输入的宽高向上对齐到 16 的倍数；关闭时按填写尺寸交付，上游尺寸仍会自动适配" onMouseDown={(event) => event.stopPropagation()}>
                            <span>16 倍数对齐</span>
                            <Switch size="small" aria-label="16 倍数对齐" checked={snapDimensionToStep} onChange={(checked) => {
                                setSnapDimensionToStep(checked);
                                if (checked && selectedRatio !== "auto") onConfigChange("size", `${alignDimension(dimensions.width, true)}x${alignDimension(dimensions.height, true)}`);
                            }} />
                        </span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("height", value)} />
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.resolution")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {mediaScaleOptions.map((value) => (
                            <OptionPill key={value} selected={selectedScale === value} theme={theme} onClick={() => selectScale(value)}>
                                {value === "auto" ? t("settingsPanels.common.auto") : value}
                            </OptionPill>
                        ))}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.aspectRatio")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {mediaRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => selectRatio(item.value)}
                            >
                                <AspectIcon width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.transparent")}</SettingTitle>
                        <div className="text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                            {t("settingsPanels.image.transparentHint")}
                        </div>
                    </div>
                    <span onMouseDown={(event) => event.stopPropagation()}>
                        <Switch size="small" checked={transparentBackground} onChange={(checked) => onConfigChange("background", checked ? "transparent" : "")} />
                    </span>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.count")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {Array.from({ length: quickCount }, (_, index) => index + 1).map((value) => (
                            <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                {t("settingsPanels.image.images", { count: value })}
                            </OptionPill>
                        ))}
                        <CountInput value={count} max={maxCount} theme={theme} onChange={(value) => onConfigChange("count", String(value || 1))} />
                    </div>
                </div>
            </div>
        </ImageSettingsTheme>
    );
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    const isDark = theme.canvas.background === "#181715";
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: {
                    Switch: isDark ? darkSwitchTokens : {},
                    Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text },
                    Slider: { railBg: theme.node.stroke, railHoverBg: theme.node.stroke, trackBg: theme.node.activeStroke, handleColor: theme.node.text, handleActiveColor: theme.node.text },
                },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

export function imageQualityLabel(value: string) {
    return (["auto", "high", "medium", "low", "xhigh", "max"].includes(value) ? i18n.t(`settingsPanels.common.${value}`) : value);
}

export function imageSizeLabel(size: string) {
    const scale = inferMediaScale(size);
    const ratio = inferMediaRatio(size);
    if (ratio === "auto" || size === "auto") return i18n.t("settingsPanels.common.auto");
    if (scale === "auto") return ratio;
    return `${scale} · ${ratio}`;
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
        >
            {children}
        </button>
    );
}

function DimensionInput({ prefix, value, disabled, theme, alignToStep, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; alignToStep: boolean; onChange: (value: number | null) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = alignDimension(Math.max(1, Math.floor(Number(input.value) || value || 1024)), alignToStep);
        input.value = String(next);
        onChange(next);
    };

    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value || ""}
                key={`${prefix}-${value}`}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function CountInput({ value, max, theme, onChange }: { value: number; max: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="col-span-2 flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={1}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function AspectIcon({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const ratio = width / height;
    const boxWidth = ratio >= 1 ? 24 : Math.max(10, 24 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(10, 24 / ratio) : 24;
    return (
        <span className="grid h-7 w-9 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

function alignDimension(value: number, enabled: boolean) {
    return enabled ? Math.ceil(value / DIMENSION_STEP) * DIMENSION_STEP : value;
}
