export type UpdatePreferences = { version: 1; repository: string; autoCheck: boolean; autoDownload: boolean; autoInstall: false; network: "auto" | "direct" | "proxy" };
export type SoftwareUpdateStatus = {
    currentVersion: string; channel: string; preferences: UpdatePreferences; state: string; checking: boolean;
    authorization: string; hasNewVersion: boolean; lastCheckedAt: string | null; error: string | null;
    latest: { version: string; publishedAt: string; notes: string; verification: string } | null;
    history: { at: string; state: string; version: string | null; error: string | null }[];
    download: { state: string; progress: number; error?: string | null }; install: { allowed: false; state: string };
};
export const updateMessages: Record<string, string> = {
    unconfigured: "尚未配置仓库", unchecked: "尚未检查", available: "有新的稳定版本（签名结果见下载状态）", "up-to-date": "没有更高的稳定版本",
    "no-stable-release": "仓库暂无符合规范的稳定版", error: "检查未完成", repository_required: "请先填写私有仓库 OWNER/REPOSITORY",
    authorization_required: "请在本机终端独立授权 GitHub", authorization_expired: "GitHub 授权失效，请重新授权",
    authorization_denied: "GitHub 权限不足，需要指定仓库 Contents 只读权限", repository_unavailable: "仓库不存在或授权不可访问",
    rate_limited: "GitHub 限流，请稍后重试", github_network_failed: "GitHub 网络请求失败，请检查网络或代理",
    github_unavailable: "GitHub 暂时不可用", proxy_unavailable: "本地代理不可用，请启动代理或选择直连",
    keychain_unavailable: "Keychain 不可访问，请检查本机授权", invalid_update_preferences: "仓库或更新设置无效，自动安装尚未开放",
    update_storage_invalid: "更新配置读取失败，原文件保留", auth_storage_invalid: "更新授权记录读取失败，原文件保留",
    update_history_invalid: "更新检查记录读取或保存失败，原文件保留",
    "trust-not-configured": "尚未配置可信签名公钥", idle: "尚未下载", "verifying-manifest": "正在验证签名清单", downloading: "正在下载", verified: "签名和文件完整性已验证（未安装）",
    signing_trust_not_configured: "尚未配置内置可信公钥，已安全停止下载", signing_key_untrusted: "签名公钥不可信，已拒绝更新",
    signature_invalid: "数字签名验证失败", stable_manifest_invalid: "稳定版清单无效", release_identity_mismatch: "清单与仓库或版本不匹配",
    version_not_newer: "禁止降级或重复更新", architecture_unsupported: "没有适合本机架构的更新包",
    package_integrity_failed: "更新包损坏或不完整", disk_space_insufficient: "暂存更新的磁盘空间不足",
    release_assets_invalid: "稳定版文件缺失或尺寸不匹配", asset_download_failed: "更新下载失败，请稍后重试",
    asset_redirect_rejected: "下载重定向不受信任", asset_access_denied: "更新文件访问失败或受到限流",
    asset_size_invalid: "下载文件超出安全大小限制", download_storage_failed: "暂存失败，当前版本和用户数据保留",
    release_not_available: "请先检查并获得更高的稳定版本", download_in_progress: "另一项更新下载尚未结束，请稍后重试",
};
export async function updateRequest(operation: "status" | "check" | "download" | "preferences", input?: Partial<UpdatePreferences>): Promise<SoftwareUpdateStatus> {
    const response = await fetch(`/local-app/updates/${operation}`, {
        method: operation === "status" ? "GET" : "POST", cache: "no-store", signal: AbortSignal.timeout(40000),
        ...(operation === "status" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(input || {}) }),
    });
    const data = await response.json();
    if (!response.ok) throw Error(updateMessages[data.error] || "软件更新操作未完成，原配置保留");
    return data;
}
