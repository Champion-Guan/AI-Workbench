import { APP_VERSION } from "@/constant/env";
import { frontendActivity, type ActivityDomain } from "@/lib/update-activity";
import { remoteAgentJournal, remoteVideoJournal } from "@/lib/remote-task-journal";

// v1.0.5+ closed-browser installer evidence, not an open-window pause permit.
// All exchanged fields are opaque identifiers, domains and a public version.
export function startUpdateTaskGuard() {
    const pageId = crypto.randomUUID();
    // Legacy deployments have no trusted task protocol and cannot install.
    // From the first compatible signed deployment onwards, a failed/missing
    // handshake blocks network dispatch instead of silently disabling evidence.
    const legacy = /^1\.0\.[0-4]$/.test(APP_VERSION);
    let stopped = false, instance: string | undefined;
    const request = async (op: "begin" | "complete", value: unknown) => {
        const response = await fetch(`/local-app/update-tasks/${op}`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(value), signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw Error("更新任务安全记录无法确认，请稍后重试。");
        const text = await response.text();
        if (text.length > 1024) throw Error("更新任务安全记录无效。");
        return JSON.parse(text) as { ok: boolean; id?: string; instance?: string };
    };
    const begin = async (id: string, domain: ActivityDomain) => {
        const value = await request("begin", { id, pageId, domain, version: APP_VERSION });
        if (value.ok !== true || value.id !== id || typeof value.instance !== "string"
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.instance)) throw Error("更新任务安全记录无效。");
        return { id, instance: value.instance };
    };
    const unregister: (() => void)[] = [];
    const ready = legacy ? Promise.resolve() : (async () => {
        const response = await fetch("/local-app/health", { cache: "no-store", signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw Error("无法核实本地任务安全协议。");
        const text = await response.text();
        if (text.length > 8192) throw Error("本地任务安全协议无效。");
        const value = JSON.parse(text) as { taskEvidenceProtocol?: number; version?: string; instanceId?: string };
        if (value.taskEvidenceProtocol !== 1 || value.version !== APP_VERSION || typeof value.instanceId !== "string"
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.instanceId)) throw Error("本地任务安全协议不兼容，请重新打开工作台。");
        if (stopped) throw Error("任务安全连接已经关闭。");
        instance = value.instanceId;
        const evidence = {
            async begin(id: string, domain: ActivityDomain) { await begin(id, domain); },
            async complete(id: string) {
                const reply = await request("complete", { id, instance });
                if (reply.ok !== true) throw Error("远端任务结束尚未确认。");
            },
        };
        unregister.push(remoteVideoJournal.setNativeEvidence(evidence), remoteAgentJournal.setNativeEvidence(evidence));
        try {
            await remoteVideoJournal.restoreNativeEvidence();
            await remoteAgentJournal.restoreNativeEvidence();
        } catch {
            // Damaged browser evidence must also veto a closed-browser native
            // installer. Keep an opaque permanent row, never send user content.
            await begin(crypto.randomUUID(), "canvas");
            throw Error("已有远端任务安全记录无法核实，自动安装保持禁止。");
        }
    })();
    const release = frontendActivity.setLifecycle({
        begin(domain: ActivityDomain) {
            if (legacy) return null;
            return (async () => {
                await ready;
                if (stopped) throw Error("任务安全连接已经关闭。");
                return begin(crypto.randomUUID(), domain);
            })();
        },
        async complete(value, successful) {
            if (!value || !successful) return; // Errors/lost responses never fabricate terminal evidence.
            try {
                const reply = await request("complete", value);
                if (reply.ok !== true) throw Error();
            } catch { /* Keep the backend's pending row; don't undo completed business writes. */ }
        },
    });
    void ready.catch(() => {}); // Stored rejection is still enforced on dispatch.
    return () => { stopped = true; release(); for (const remove of unregister) remove(); };
}
