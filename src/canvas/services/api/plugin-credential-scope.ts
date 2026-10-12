/** Keychain scripts receive only an opaque reference. All authenticated calls stay bound to that profile. */
export function scopedPluginUrl(baseUrl: string, path: string, origin: string): string {
    if (path.startsWith("//")) throw new Error("脚本不能将本机凭据用于其他地址或渠道");
    const base = new URL(baseUrl, origin);
    if (base.origin !== origin || !/^\/local-secure-api\/[a-f0-9-]{36}\/?$/.test(base.pathname)
        || base.search || base.hash || base.username || base.password) throw new Error("脚本凭据绑定无效");
    const prefix = base.pathname.replace(/\/$/, "");
    const target = /^https?:/i.test(path) ? new URL(path) : new URL(`${prefix}/${path.replace(/^\/+/, "")}`, origin);
    if (target.origin !== origin || !target.pathname.startsWith(prefix + "/") || target.username || target.password || target.hash
        || /(?:^|\/)(?:\.|%2e)(?:\.|%2e)?(?:\/|$)/i.test(path)
        || /%2f|%5c|\\/i.test(path)) throw new Error("脚本不能将本机凭据用于其他地址或渠道");
    return target.href;
}

export function scopedPluginHeaders(reference: string, headers: Record<string, unknown> = {}): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (/^(authorization|x-goog-api-key|api-key|x-api-key)$/i.test(key)) {
            if (String(value) !== reference && String(value) !== `Bearer ${reference}`) throw new Error("脚本鉴权与渠道凭据不一致");
        } else if (!/^(cookie|host|origin|proxy-authorization)$/i.test(key)) result[key] = String(value);
    }
    // Backend injects the provider-specific real authentication.
    result.Authorization = `Bearer ${reference}`;
    result["x-goog-api-key"] = reference;
    return result;
}
