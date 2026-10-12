import type { AiConfig, ModelChannel, WebdavSyncConfig } from "@/stores/use-config-store";

type CredentialKind = "openai" | "gemini" | "webdav" | "agent";
const referencePattern = /^guan-vault:[a-f0-9-]{36}$/;
const failure = () => new Error("安全凭据保存未完成，原配置已保留。请检查本机服务与 Keychain。");

async function request(operation: "save" | "binding", body: Record<string, string>) {
    const response = await fetch(`/local-app/credentials/${operation}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        cache: "no-store", signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok || data?.ok !== true) throw failure();
    return data as { credentialRef: string; baseUrl: string; endpoint?: string; kind?: CredentialKind; username?: string };
}

export async function secureCredential(kind: CredentialKind, endpoint: string, secret: string, username = "") {
    if (!secret) return { baseUrl: endpoint, credentialRef: "" };
    if (referencePattern.test(secret)) {
        const binding = await request("binding", { credentialRef: secret });
        // Only this same profile's historical local URL may be rebound after a port migration.
        const historical = endpoint.replace(/\/+$/, "") === `http://127.0.0.1:5174/local-secure-api/${secret.slice(11)}`;
        if (binding.credentialRef !== secret || binding.baseUrl !== `${location.origin}/local-secure-api/${secret.slice(11)}` ||
            binding.kind !== kind || binding.username !== username ||
            !historical && endpoint.replace(/\/+$/, "") !== binding.baseUrl && endpoint.replace(/\/+$/, "") !== binding.endpoint) throw failure();
        return binding;
    }
    if (secret.startsWith("guan-vault:") || /\/local-secure-api(?:\/|$)/.test(endpoint)) throw failure();
    const binding = await request("save", { kind, endpoint, secret, username });
    if (!referencePattern.test(binding.credentialRef) || binding.baseUrl !== `${location.origin}/local-secure-api/${binding.credentialRef.slice(11)}`) throw failure();
    return binding;
}

export async function credentialEndpoint(secret: string) {
    if (!referencePattern.test(secret)) return null;
    return (await request("binding", { credentialRef: secret })).endpoint || null;
}

export async function secureChannel(channel: ModelChannel): Promise<ModelChannel> {
    const binding = await secureCredential(channel.apiFormat, channel.baseUrl, channel.apiKey);
    return { ...channel, baseUrl: binding.baseUrl, apiKey: binding.credentialRef };
}

export async function secureWebdav(webdav: WebdavSyncConfig): Promise<WebdavSyncConfig> {
    const binding = await secureCredential("webdav", webdav.url, webdav.password, webdav.username);
    return { ...webdav, url: binding.baseUrl, password: binding.credentialRef };
}

export async function secureConfig(config: AiConfig, webdav: WebdavSyncConfig) {
    // Complete all Keychain writes before changing either browser store.
    const channels = [];
    for (const channel of config.channels) channels.push(await secureChannel(channel));
    const binding = await secureCredential(config.apiFormat || "openai", config.baseUrl || "", config.apiKey || "");
    return { config: { ...config, channels, baseUrl: binding.baseUrl, apiKey: binding.credentialRef }, webdav: await secureWebdav(webdav) };
}
