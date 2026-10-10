import i18n from "@/i18n";
import { normalizeLocalProxyUrl } from "@/stores/use-config-store";

/** The proxy answers its root path with its own identity payload, which doubles as a reachability check. */
export async function testLocalProxy(proxyUrl: string) {
    const base = normalizeLocalProxyUrl(proxyUrl);
    if (!base) throw new Error(i18n.t("config.proxy.missingUrl"));
    const response = await fetch(`${base}/`, { cache: "no-store" });
    const data = response.ok ? ((await response.json().catch(() => null)) as { proxy?: string; version?: string } | null) : null;
    if (!data?.proxy) throw new Error(i18n.t("config.proxy.unreachable"));
    return `${data.proxy} v${data.version || "?"}`;
}

export type LocalProxyDiagnostics = {
    running?: boolean;
    proxyAvailable?: boolean;
    proxyServer?: string | null;
    latencyMs?: number;
    exitIp?: string | null;
    error?: string | null;
};

export async function diagnoseLocalProxy(): Promise<LocalProxyDiagnostics> {
    const response = await fetch("/local-proxy/diagnostics", { cache: "no-store" });
    const data = (await response.json().catch(() => null)) as LocalProxyDiagnostics | null;
    if (!data) throw new Error(response.ok ? i18n.t("config.proxy.unreachable") : `代理诊断失败（HTTP ${response.status}）`);
    return data;
}
