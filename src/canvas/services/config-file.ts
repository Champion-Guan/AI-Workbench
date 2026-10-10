import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";
import { runTaskActivity } from "@/services/task-admission";
import { assertPortableCredentialBindings } from "@/lib/config-portability";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config, webdav, promptSources: { sources, schedule } };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File) {
    return runTaskActivity("storage", async () => {
        let data: AppConfigFile;
        try {
            if (file.size > 4 * 1024 * 1024) throw new Error();
            const text = await file.text();
            if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new Error();
            data = JSON.parse(text) as AppConfigFile;
            const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
            if (!data || data.app !== "infinite-canvas" || data.version !== 1 || !object(data.config) || !object(data.webdav) || !object(data.promptSources)
                || !Array.isArray(data.config.channels) || !Array.isArray(data.promptSources.sources)
                || !data.promptSources.schedule || typeof data.promptSources.schedule !== "object" || Array.isArray(data.promptSources.schedule)) throw new Error();
            if (data.config.channels.some((channel) => !object(channel))) throw new Error();
        } catch {
            throw new Error(i18n.t("config.invalidFile"));
        }
        try {
            assertPortableCredentialBindings(data.config, data.webdav);
        } catch {
            throw new Error("配置包含仅限原电脑使用的安全凭据引用，请在此电脑重新授权；原配置未改变。");
        }
        useConfigStore.setState({ config: data.config, webdav: data.webdav });
        // A config file must not replace store actions with arbitrary JSON.
        usePromptSourceStore.setState({ sources: data.promptSources.sources, schedule: data.promptSources.schedule });
    });
}
