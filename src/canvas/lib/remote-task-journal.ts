import { frontendActivity, type ActivityDomain, type FrontendActivityRegistry } from "./update-activity";

const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
type RecordValue = { format: 1; taskKey: string | null };

// Conservative durable evidence, not an authoritative remote task inventory.
// Each request owns a separate key, avoiding cross-page array read/modify/write
// loss. No endpoint, credential, prompt, task id or generated media is stored.
export class RemoteTaskJournal {
    private releases = new Map<string, () => void>();
    private unknownRelease: (() => void) | undefined;
    private prefix: string;
    constructor(private activity: FrontendActivityRegistry, private storage: () => Storage,
        private random: () => string, private maximum = 4096, private domain: ActivityDomain = "canvas", namespace: "video" | "agent" = "video") {
        this.prefix = `guan-update-remote-${namespace}-v1:`;
    }
    private unknown() { this.unknownRelease ||= this.activity.acquire(this.domain); }
    private rows(): Map<string, RecordValue> {
        const storage = this.storage(), rows = new Map<string, RecordValue>();
        // Reading is observational; damaged/unknown records are never removed.
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (!key?.startsWith(this.prefix)) continue;
            if (!digest(key.slice(this.prefix.length)) || rows.size >= this.maximum) throw Error("remote_task_journal_invalid");
            const raw = storage.getItem(key);
            if (raw === null || raw.length > 128) throw Error("remote_task_journal_invalid");
            const value = JSON.parse(raw) as RecordValue;
            if (!value || Object.keys(value).sort().join(",") !== "format,taskKey" || value.format !== 1
                || value.taskKey !== null && !digest(value.taskKey)) throw Error("remote_task_journal_invalid");
            rows.set(key.slice(this.prefix.length), value);
        }
        return rows;
    }
    restore() {
        try {
            const rows = this.rows();
            for (const id of rows.keys()) if (!this.releases.has(id)) this.releases.set(id, this.activity.acquire(this.domain));
            // A removed journal row may reflect another page's confirmed
            // terminal response. Never clear the permanent corruption blocker.
            for (const [id, release] of this.releases) if (!rows.has(id)) { release(); this.releases.delete(id); }
        } catch { this.unknown(); }
    }
    begin(): string {
        try {
            this.restore();
            const rows = this.rows(), id = this.random();
            if (this.unknownRelease || rows.size >= this.maximum || !digest(id) || rows.has(id)) throw Error();
            const value = JSON.stringify({ format: 1, taskKey: null });
            this.storage().setItem(this.prefix + id, value);
            if (this.storage().getItem(this.prefix + id) !== value) throw Error();
            this.releases.set(id, this.activity.acquire(this.domain));
            return id;
        } catch {
            this.unknown();
            // No upstream request is sent unless its intent is durable.
            throw Error("无法保存远端任务安全记录，请检查浏览器存储后再试。");
        }
    }
    bind(id: string, taskKey: string | null) {
        try {
            if (!digest(id) || !digest(taskKey)) throw Error();
            const row = this.rows().get(id);
            if (!row || row.taskKey !== null && row.taskKey !== taskKey) throw Error();
            const value = JSON.stringify({ format: 1, taskKey });
            this.storage().setItem(this.prefix + id, value);
            if (this.storage().getItem(this.prefix + id) !== value) throw Error();
        } catch { this.unknown(); } // A returned task remains usable; evidence is retained.
    }
    terminal(taskKey: string): boolean {
        try {
            if (!digest(taskKey)) throw Error();
            for (const [id, row] of this.rows()) if (row.taskKey === taskKey) {
                this.storage().removeItem(this.prefix + id);
                if (this.storage().getItem(this.prefix + id) !== null) throw Error();
                this.releases.get(id)?.(); this.releases.delete(id);
            }
            return true;
        } catch { this.unknown(); return false; }
    }
}

export const remoteVideoJournal = new RemoteTaskJournal(frontendActivity, () => window.localStorage,
    () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join(""));
export const remoteAgentJournal = new RemoteTaskJournal(frontendActivity, () => window.localStorage,
    () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join(""), 4096, "agent", "agent");
