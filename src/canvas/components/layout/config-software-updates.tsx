import { useEffect, useState } from "react";
import { Alert, App, Button, Input, Select, Switch } from "antd";
import { useVersionCheck } from "@/hooks/use-version-check";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { updateMessages, installationMessages, updateRequest, type UpdatePreferences } from "@/services/software-updates";

export function ConfigSoftwareUpdates() {
    const { message } = App.useApp();
    const { status, refresh, checking, checkLatestRelease } = useVersionCheck();
    const [repository, setRepository] = useState("");
    const [saving, setSaving] = useState(false);
    const savedRepository = status?.preferences.repository;
    useEffect(() => { if (savedRepository !== undefined) setRepository(savedRepository); }, [savedRepository]);
    const save = async (input: Partial<UpdatePreferences>) => {
        setSaving(true);
        try { await updateRequest("preferences", input); await refresh(); message.success("软件更新设置已保存"); }
        catch (e) { message.error(e instanceof Error ? e.message : "更新设置未保存"); }
        finally { setSaving(false); }
    };
    const prefs = status?.preferences;
    const downloading = ["verifying-manifest", "downloading"].includes(status?.download.state || "");
    const staging = Boolean(status?.install.staging);
    useEffect(() => {
        if (!downloading && !staging) return;
        const timer = setInterval(() => void refresh(), 2000);
        return () => clearInterval(timer);
    }, [downloading, staging, refresh]);
    const download = async () => {
        try { await updateRequest("download"); await refresh(); }
        catch (e) { message.error(e instanceof Error ? e.message : "下载未开始"); }
    };
    const stage = async () => {
        try { await updateRequest("stage"); await refresh(); }
        catch (e) { message.error(e instanceof Error ? e.message : "暂存未开始"); }
    };
    return (
        <section data-guan-updates-panel className="space-y-4 text-sm text-stone-700 dark:text-stone-200">
            <div className="grid grid-cols-2 gap-3">
                <div>当前版本：{status?.currentVersion || "读取中"}</div><div>最新稳定版本：{status?.latest?.version || "尚未获得"}</div>
                <div>更新渠道：GitHub Private / Stable</div><div>上次检查：{status?.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString() : "尚未检查"}</div>
            </div>
            <div className="space-y-2"><label htmlFor="guan-updates-repository">私有仓库（OWNER/REPOSITORY）</label>
                <div className="flex gap-2"><Input id="guan-updates-repository" aria-label="私有更新仓库" value={repository} maxLength={201} placeholder="OWNER/REPOSITORY" onChange={e => setRepository(e.target.value)} /><Button loading={saving} onClick={() => void save({ repository: repository.trim() })}>保存仓库</Button></div>
            </div>
            <Alert type="info" showIcon message="每台 Mac 独立授权，Token 不进入浏览器" description={<div>指定仓库的 Fine-grained Token 仅需 Contents 只读权限。在本机项目终端运行 <code>node scripts/authorize-updates.mjs OWNER/REPOSITORY</code>，使用隐藏输入保存到 macOS Keychain。授权后点击检查；请勿在聊天、URL 或配置文件粘贴 Token。</div>} />
            <div>授权状态：{status?.authorization === "configured-not-verified" ? "已有本机授权记录，检查时验证权限" : "需要本机授权"}</div>
            <div className="flex flex-wrap items-center gap-5">
                <label className="flex items-center gap-2"><Switch aria-label="自动检查更新" checked={prefs?.autoCheck ?? true} disabled={!prefs || saving} onChange={autoCheck => void save({ autoCheck })} />自动检查（启动及每 6 小时）</label>
                <label className="flex items-center gap-2"><Switch aria-label="自动下载更新" checked={prefs?.autoDownload ?? true} disabled={!prefs || saving} onChange={autoDownload => void save({ autoDownload })} />自动下载（仅可信签名包）</label>
                <label className="flex items-center gap-2"><Switch aria-label="自动安装更新" checked={false} disabled />自动安装（阶段 5 未完成，保持关闭）</label>
            </div>
            <div className="flex items-center gap-3"><span>更新网络</span><Select aria-label="更新网络" className="min-w-44" value={prefs?.network || "auto"} disabled={!prefs || saving} options={[{ value: "auto", label: "自动（有代理则使用代理）" }, { value: "direct", label: "直连" }, { value: "proxy", label: "本地代理" }]} onChange={network => void save({ network })} /></div>
            <div className="flex items-center gap-3"><Button loading={checking} onClick={() => void checkLatestRelease(true)}>检查更新</Button><Button disabled={!status?.hasNewVersion || status?.download.state === "trust-not-configured" || downloading} onClick={() => void download()}>下载更新</Button><VersionReleaseModal label="更新日志" /></div>
            <div className="flex items-center gap-3"><Button loading={staging} disabled={status?.download.state !== "verified" || status?.install.state === "unavailable" || status?.install.state === "disabled"} onClick={() => void stage()}>暂存更新</Button><span className="text-xs text-stone-500 dark:text-stone-400">仅解包复核，不启动新版本或修改个人数据</span></div>
            <div role="status">{status ? updateMessages[status.state] || status.state : "本机更新服务读取中"}{status?.error ? `：${updateMessages[status.error] || "检查未完成，原版本保留"}` : ""}</div>
            <div role="status" className="text-xs text-stone-500 dark:text-stone-400">下载：{updateMessages[status?.download.state || "idle"] || "下载未完成"} · {status?.download.progress || 0}%{status?.download.error ? ` · ${updateMessages[status.download.error] || "下载未完成"}` : ""}。安装保持禁用，已下载文件不执行。</div>
            <div role="status" className="text-xs text-stone-500 dark:text-stone-400">安装：{installationMessages[status?.install.state || "disabled"] || "状态尚未确认"}{status?.install.currentVersion ? ` · 受控版本 ${status.install.currentVersion}` : ""}{status?.install.targetVersion ? ` · 目标版本 ${status.install.targetVersion}` : ""}{status?.install.reason ? ` · ${updateMessages[status.install.reason] || "安装安全条件尚未满足"}` : ""}{status?.install.stageError ? ` · ${updateMessages[status.install.stageError] || "暂存未完成，原版本保留"}` : ""}</div>
            {status?.latest ? <div className="whitespace-pre-wrap break-words"><div>发布时间：{new Date(status.latest.publishedAt).toLocaleString()}</div>{status.latest.notes || "暂无更新说明"}</div> : null}
            <div><div className="mb-2 font-medium">更新检查记录（最近 30 次，非安装记录）</div>{status?.history.slice().reverse().map((entry, index) => <div key={`${entry.at}-${index}`} className="text-xs leading-6">{new Date(entry.at).toLocaleString()} · {entry.version || "—"} · {updateMessages[entry.error || entry.state] || "检查未完成"}</div>)}</div>
        </section>
    );
}
