import { PageDrainBarrier, type DrainReceipt } from "./page-drain-barrier";
import { type FrontendActivityRegistry } from "./update-activity";

const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => v !== null && typeof v === "object"
    && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
type Request = { protocol: 1; session: string; sequence: number; op: "probe" | "pause" | "assert" | "resume"; epoch: string | null };

// This transports only the already implemented local task/flush barrier. It
// does NOT establish complete edit/plugin/Excel admission, global inventory or
// an install permit. A native coordinator must separately prove those facts.
export class ManagedPageControl {
    private sequence = -1;
    private epoch: string | null = null;
    private receipt: DrainReceipt | null = null;
    private draining = false;
    private blocked = false;
    private disposed = false;
    private abort: AbortController | null = null;
    constructor(private readonly session: string, private readonly barrier: PageDrainBarrier,
        private readonly activity: FrontendActivityRegistry) {
        if (!uuid(session)) throw Error("managed_page_session_invalid");
    }
    private snapshot(sequence: number, error: string | null = null) {
        const acknowledged = Boolean(this.receipt && this.barrier.isAcknowledged(this.receipt));
        return { protocol: 1, session: this.session, sequence, epoch: this.epoch,
            phase: this.disposed || this.blocked ? "blocked" : this.draining ? "draining" : this.epoch ? "paused" : "active",
            counts: this.activity.snapshot(), revision: this.activity.revision(), acknowledged,
            fullRootCoverage: false, installAllowed: false, error };
    }
    async accept(value: unknown) {
        if (this.disposed || !exact(value, ["protocol", "session", "sequence", "op", "epoch"])
            || value.protocol !== 1 || value.session !== this.session || !Number.isSafeInteger(value.sequence)
            || (value.sequence as number) !== this.sequence + 1 || (value.sequence as number) >= Number.MAX_SAFE_INTEGER
            || !["probe", "pause", "assert", "resume"].includes(value.op as string)
            || (value.op === "probe" ? value.epoch !== null : !uuid(value.epoch))) throw Error("managed_page_request_invalid");
        const request = value as Request;
        this.sequence = request.sequence;
        if (request.op === "probe") return this.snapshot(request.sequence);
        if (request.op === "pause") {
            if (this.epoch || this.draining) return this.snapshot(request.sequence, "managed_page_already_paused");
            this.epoch = request.epoch; this.receipt = null; this.draining = true; this.blocked = false;
            const abort = new AbortController(); this.abort = abort;
            try {
                const receipt = await this.barrier.drain(request.epoch!, abort.signal);
                // Resume/lifecycle invalidation can overtake this async flush.
                if (this.disposed || this.epoch !== request.epoch || abort.signal.aborted) throw Error();
                this.receipt = receipt;
                this.draining = false;
                return this.snapshot(request.sequence);
            } catch {
                if (this.epoch === request.epoch) this.blocked = true;
                return this.snapshot(request.sequence, "managed_page_flush_unconfirmed");
            } finally {
                this.draining = false;
                if (this.abort === abort) this.abort = null;
            }
        }
        if (request.epoch !== this.epoch) return this.snapshot(request.sequence, "managed_page_epoch_mismatch");
        if (request.op === "assert") return this.snapshot(request.sequence,
            this.receipt && this.barrier.isAcknowledged(this.receipt) ? null : "managed_page_checkpoint_invalid");
        // Explicit matching-owner resume is allowed while drain is waiting.
        // It aborts confirmation, not existing child requests or storage writes.
        this.barrier.resume(request.epoch!); this.abort?.abort(); this.epoch = null; this.receipt = null; this.blocked = false;
        return this.snapshot(request.sequence);
    }
    invalidate() {
        this.receipt = null; this.barrier.invalidateCheckpoint(); this.abort?.abort();
        if (this.epoch) this.blocked = true;
    }
    dispose() {
        this.disposed = true; this.invalidate();
        // Lost transport never silently resumes roots or releases remote tasks.
    }
}
