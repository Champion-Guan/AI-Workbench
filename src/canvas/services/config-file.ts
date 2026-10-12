import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";
import { runTaskActivity } from "@/services/task-admission";
import { assertPortableCredentialBindings } from "@/lib/config-portability";
import { secureConfig, credentialEndpoint } from "@/services/secure-credentials";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    credentialsOmitted?: true;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

function portableEndpoint(value: string) {
    if (!value) return value;
    try {
        const url = new URL(value, "http://config.invalid");
        if (/\/(?:local-secure-api)(?:\/|$)/i.test(decodeURIComponent(url.pathname))) return "";
        // Endpoint userinfo and query strings may themselves contain tokens.
        if (url.username || url.password || url.search || url.hash) return "";
    } catch {
        // An invalid endpoint is not a usable portable configuration value.
        return "";
    }
    return value;
}

export function createPortableAppConfig(config: AiConfig, webdav: WebdavSyncConfig, sources: PromptSource[], schedule: PromptSourceSchedule): AppConfigFile {
    return {
        app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), credentialsOmitted: true,
        config: {
            ...config,
            apiKey: "",
            baseUrl: portableEndpoint(config.baseUrl),
            channels: config.channels.map((channel) => ({
                ...channel, apiKey: "", baseUrl: portableEndpoint(channel.baseUrl),
                // Arbitrary request scripts can contain embedded credentials.
                models: channel.models.map((model) => ({ ...model, script: "" })),
            })),
        },
        webdav: { ...webdav, password: "", url: portableEndpoint(webdav.url) },
        promptSources: { sources, schedule },
    };
}

export async function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const channels = [];
    for (const channel of config.channels) channels.push({ ...channel, baseUrl: await credentialEndpoint(channel.apiKey) || channel.baseUrl });
    const data = createPortableAppConfig({ ...config, channels, baseUrl: await credentialEndpoint(config.apiKey) || config.baseUrl },
        { ...webdav, url: await credentialEndpoint(webdav.password) || webdav.url }, sources, schedule);
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "guan-workbench-config-no-credentials.json");
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
        const original = useConfigStore.getState();
        if (data.credentialsOmitted) {
            // A portable export must not erase credentials already configured
            // on this computer. Reuse only an exact endpoint/identity match.
            for (const channel of data.config.channels) {
                const old = original.config.channels.find(item => item.id === channel.id);
                if (old?.apiKey && channel.apiFormat === old.apiFormat && channel.baseUrl === (await credentialEndpoint(old.apiKey) || old.baseUrl)) {
                    channel.apiKey = old.apiKey; channel.baseUrl = old.baseUrl;
                }
            }
            if (original.config.apiKey && data.config.apiFormat === original.config.apiFormat && data.config.baseUrl === (await credentialEndpoint(original.config.apiKey) || original.config.baseUrl)) {
                data.config.apiKey = original.config.apiKey; data.config.baseUrl = original.config.baseUrl;
            }
            if (original.webdav.password && data.webdav.username === original.webdav.username && data.webdav.url === (await credentialEndpoint(original.webdav.password) || original.webdav.url)) {
                data.webdav.password = original.webdav.password; data.webdav.url = original.webdav.url;
            }
        }
        const secured = await secureConfig(data.config, data.webdav);
        if (useConfigStore.getState().config !== original.config || useConfigStore.getState().webdav !== original.webdav) throw new Error("配置已改变，请重新导入；原配置未覆盖。");
        useConfigStore.setState(secured);
        // A config file must not replace store actions with arbitrary JSON.
        usePromptSourceStore.setState({ sources: data.promptSources.sources, schedule: data.promptSources.schedule });
    });
}
