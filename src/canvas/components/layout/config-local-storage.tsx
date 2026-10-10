import { Alert, Button, Progress } from "antd";
import type { TFunction } from "i18next";
import { Database, HardDrive, Layers3, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { readLocalStorageUsage, type LocalStorageUsage } from "@/services/local-storage-usage";

const storeLabelKeys: Record<string, string> = {
    app_state: "appState",
    image_files: "images",
    image_previews: "imagePreviews",
    media_files: "media",
    image_generation_logs: "imageLogs",
    video_generation_logs: "videoLogs",
    agent_chat_messages: "agentMessages",
    prompt_cache: "promptCache",
};

export function ConfigLocalStorage({ active }: { active: boolean }) {
    const { t } = useTranslation();
    const [usage, setUsage] = useState<LocalStorageUsage | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const reading = useRef(false);

    const refresh = useCallback(async () => {
        if (reading.current) return;
        reading.current = true;
        setLoading(true);
        setError("");
        try {
            setUsage(await readLocalStorageUsage());
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("config.localStorage.readFailed"));
        } finally {
            reading.current = false;
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        if (active && !usage) void refresh();
    }, [active, refresh, usage]);

    const indexedDbBytes = usage?.contentBytes ?? 0;
    const percent = usage ? Math.min(100, (usage.usage / usage.quota) * 100) : 0;
    const databases = usage?.databases ?? [{
        name: "infinite-canvas", version: 0, bytes: 0,
        stores: Object.keys(storeLabelKeys).map((name) => ({ name, records: 0, bytes: 0 })),
    }];

    return (
        <div className="space-y-3" data-guan-storage-layout aria-busy={loading}>
            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Database className="size-4" />
                            {t("config.localStorage.title")}
                        </div>
                        <div className="mt-1 text-xs text-stone-500">{t("config.localStorage.description")}</div>
                    </div>
                    <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>
                        {t("config.localStorage.refresh")}
                    </Button>
                </div>
                {error ? <Alert className="mt-4" type="error" showIcon message={t("config.localStorage.readFailed")} description={error} /> : null}
                    <>
                        <div className="mt-4 grid gap-3 sm:grid-cols-3">
                            <StorageMetric icon={<Database className="size-4" />} label={t("config.localStorage.indexedDbUsage")} value={usage ? formatStorageBytes(indexedDbBytes) : "—"} hint={t("config.localStorage.contentEstimate")} />
                            <StorageMetric icon={<HardDrive className="size-4" />} label={t("config.localStorage.siteUsage")} value={usage ? formatStorageBytes(usage.usage) : "—"} hint={t("config.localStorage.siteUsageHint")} />
                            <StorageMetric icon={<Layers3 className="size-4" />} label={t("config.localStorage.quota")} value={usage ? formatStorageBytes(usage.quota) : "—"} hint={t("config.localStorage.quotaHint")} />
                        </div>
                        <div className="mt-4">
                            <div className="mb-1 flex justify-between text-xs text-stone-500">
                                <span>{t("config.localStorage.quotaProgress")}</span>
                                <span className="tabular-nums">{usage ? `${percent.toFixed(2)}%` : "—"}</span>
                            </div>
                            <Progress percent={percent} showInfo={false} />
                        </div>
                    </>
            </section>
            {databases.map((database) => (
                <section key={database.name} className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                    <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{t("config.localStorage.mainDatabase")}</div>
                            <div className="mt-0.5 truncate font-mono text-[11px] text-stone-500">{database.name} · {usage ? `v${database.version}` : "—"}</div>
                        </div>
                        <div className="shrink-0 text-sm font-medium tabular-nums">{usage ? formatStorageBytes(database.bytes) : "—"}</div>
                    </div>
                    <div className="divide-y divide-stone-200 dark:divide-stone-800">
                        {database.stores.map((store) => (
                            <div key={store.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 px-4 py-3 text-sm">
                                <div className="min-w-0">
                                    <div className="truncate font-medium">{storeLabel(store.name, t)}</div>
                                    <div className="mt-0.5 truncate font-mono text-[11px] text-stone-500">{store.name}</div>
                                </div>
                                <div className="text-right text-xs text-stone-500 tabular-nums">{usage ? t("config.localStorage.records", { count: store.records }) : "—"}</div>
                                <div className="w-20 text-right font-medium tabular-nums">{usage ? formatStorageBytes(store.bytes) : "—"}</div>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

function StorageMetric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
    return (
        <div className="rounded-lg bg-stone-100/70 p-3 dark:bg-stone-900/70">
            <div className="flex items-center gap-2 text-xs text-stone-500">{icon}{label}</div>
            <div className="mt-2 text-xl font-semibold tabular-nums">{value}</div>
            <div className="mt-1 text-[11px] text-stone-500">{hint}</div>
        </div>
    );
}

function storeLabel(name: string, t: TFunction) {
    const key = storeLabelKeys[name];
    return key ? t(`config.localStorage.stores.${key}`) : name;
}

function formatStorageBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
