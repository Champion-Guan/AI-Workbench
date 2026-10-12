import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { useConfigStore, upsertChannelCredentials } from "@/stores/use-config-store";
import { secureChannel } from "@/services/secure-credentials";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    usePromptSourceScheduler();

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        openConfigDialog(false, "channels");
        void (async () => {
            const current = useConfigStore.getState().config;
            const result = upsertChannelCredentials(current, { baseUrl, apiKey });
            if (result.status === "missing-base-url") { message.error(t("config.importedChannelBaseUrlRequired")); return; }
            if (result.status === "invalid-base-url") { message.error(t("config.importedChannelBaseUrlInvalid")); return; }
            try {
                const channels = [];
                for (const channel of result.config.channels) channels.push(await secureChannel(channel));
                if (useConfigStore.getState().config !== current) throw new Error("配置已改变，请重新导入渠道。");
                useConfigStore.setState({ config: { ...result.config, channels } });
                message.success(t(result.status === "created" ? "config.importedChannelCreated" : "config.importedChannelUpdated", { name: result.channelName }));
            } catch (error) { message.error(error instanceof Error ? error.message : "安全凭据保存失败，原配置已保留。"); }
        })();
    }, [message, openConfigDialog, t]);

    return <>{children}</>;
}
