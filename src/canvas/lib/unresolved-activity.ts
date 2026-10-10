import { frontendActivity, type ActivityDomain, type FrontendActivityRegistry } from "./update-activity";

// Remote tasks outlive individual HTTP calls. Only a confirmed terminal response
// can release them; a timeout, abort, history deletion or lost UI is not proof.
export class UnresolvedActivityRegistry {
    private releases = new Map<string, () => void>();
    private unknownRelease: (() => void) | undefined;
    constructor(private registry: FrontendActivityRegistry, private domain: ActivityDomain, private maximum = 4096) {}
    markUnknown() {
        // A bounded, conservative blocker if attribution/capacity fails.
        this.unknownRelease ||= this.registry.acquire(this.domain);
    }
    remember(opaqueKey: string) {
        if (!/^[a-f0-9]{64}$/.test(opaqueKey)) { this.markUnknown(); return; }
        if (this.releases.has(opaqueKey)) return;
        if (this.releases.size >= this.maximum) { this.markUnknown(); return; }
        this.releases.set(opaqueKey, this.registry.acquire(this.domain));
    }
    terminal(opaqueKey: string) {
        this.releases.get(opaqueKey)?.();
        this.releases.delete(opaqueKey);
    }
}

export const unresolvedVideoActivity = new UnresolvedActivityRegistry(frontendActivity, "canvas");
export const unresolvedWebdavActivity = new UnresolvedActivityRegistry(frontendActivity, "webdav");
