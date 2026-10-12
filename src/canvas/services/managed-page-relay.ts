import { ManagedPageControl } from "@/lib/managed-page-control";
import { frontendActivity } from "@/lib/update-activity";
import { frontendTaskBarrier } from "@/services/task-admission";
import { APP_VERSION } from "@/constant/env";

const ORIGIN = "http://127.0.0.1:8888";
const HANDSHAKE = "guan-managed-page-v1";
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);

export function startManagedPageRelay() {
    // Production Origin stays fixed. Isolated tests exercise the controller
    // directly; a test query parameter never enables control on another host.
    if (window.location.origin !== ORIGIN) return () => {};
    let port: MessagePort | null = null, controller: ManagedPageControl | null = null, pending = 0, stopped = false;
    const close = () => {
        controller?.dispose(); port?.close(); port = null;
        // Retain controller ownership until document disposal. A replacement
        // handshake cannot bypass a failed/paused old epoch.
    };
    const connect = (event: MessageEvent) => {
        const value = event.data;
        if (!stopped && !controller && event.origin === ORIGIN && event.source === window && event.ports.length === 0
            && value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 3
            && value.type === "guan-managed-page-discover" && value.protocol === 1 && uuid(value.session)) {
            window.postMessage({ type: "guan-managed-page-available", protocol: 1, session: value.session }, ORIGIN);
            return;
        }
        if (stopped || controller || event.origin !== ORIGIN || event.source !== window || event.ports.length !== 1
            || !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3
            || value.type !== HANDSHAKE || value.protocol !== 1 || !uuid(value.session)) return;
        port = event.ports[0]; controller = new ManagedPageControl(value.session, frontendTaskBarrier, frontendActivity);
        const ownerPort = port, owner = controller;
        ownerPort.onmessageerror = close;
        ownerPort.onmessage = event => {
            if (stopped || ownerPort !== port || pending >= 8) { close(); return; }
            pending++;
            void owner.accept(event.data).then(reply => {
                if (!stopped && ownerPort === port) ownerPort.postMessage({ ...reply, version: APP_VERSION });
            }).catch(close).finally(() => { pending--; });
        };
        ownerPort.start();
        ownerPort.postMessage({ protocol: 1, op: "ready", session: value.session, version: APP_VERSION,
            fullRootCoverage: false, installAllowed: false });
    };
    const invalidate = () => controller?.invalidate();
    window.addEventListener("message", connect);
    window.addEventListener("pagehide", invalidate);
    window.addEventListener("pageshow", invalidate);
    return () => {
        stopped = true; close();
        window.removeEventListener("message", connect);
        window.removeEventListener("pagehide", invalidate);
        window.removeEventListener("pageshow", invalidate);
    };
}
