import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { APP_VERSION } from "@/constant/env";
import type { ReleaseInfo } from "@/lib/release";
import { updateRequest, updateMessages, type SoftwareUpdateStatus } from "@/services/software-updates";

export function useVersionCheck() {
    const { message } = App.useApp();
    const localReleases = useMemo<ReleaseInfo[]>(() => __APP_RELEASES__ || [], []);
    const [status, setStatus] = useState<SoftwareUpdateStatus | null>(null);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const refresh = useCallback(async () => {
        try { setStatus(await updateRequest("status")); } catch { /* Keep workbench usable when backend is offline. */ }
    }, []);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                const next = await updateRequest("check");
                setStatus(next);
                if (showMessage) {
                    if (next.error) message.warning(updateMessages[next.error] || "更新检查未完成");
                    else message.success(updateMessages[next.state] || "检查完成");
                }
                await refresh();
                return !next.error;
            } catch {
                if (showMessage) message.error("本机更新服务不可用，工作台仍可继续使用");
                return false;
            } finally {
                setChecking(false);
            }
        },
        [message, refresh],
    );

    useEffect(() => {
        // Backend owns startup and six-hour polling; cached iframes cannot multiply GitHub requests.
        void refresh();
        const timer = setInterval(() => void refresh(), 30000);
        return () => clearInterval(timer);
    }, [refresh]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void refresh();
    }, [refresh]);

    const latest = status?.latest;
    const releases = latest ? [{ version: latest.version, date: latest.publishedAt.slice(0, 10), items: [{ type: "更新", content: latest.notes || "暂无更新说明" }] }, ...localReleases.filter(r => r.version !== latest.version)] : localReleases;

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion: latest?.version || status?.currentVersion || APP_VERSION,
        releases,
        checking,
        hasNewVersion: status?.hasNewVersion || false,
        checkLatestRelease,
        status,
        refresh,
    };
}
