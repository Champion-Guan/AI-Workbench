import { useLayoutEffect, useRef, useState } from "react";
import { frontendActivity } from "@/lib/update-activity";
import { RenderCommitCheckpoint } from "@/lib/render-commit-checkpoint";
import { canvasUpdateFlush } from "@/services/canvas-update-flush";

export function useCanvasUpdateFlush<T>(snapshot: T, isReady: () => boolean, persist: (snapshot: T) => Promise<void>) {
    const [ticket, requestRender] = useState(0);
    const checkpointRef = useRef<RenderCommitCheckpoint<T> | null>(null);
    if (!checkpointRef.current) checkpointRef.current = new RenderCommitCheckpoint(frontendActivity, requestRender);
    const checkpoint = checkpointRef.current;
    const persistRef = useRef(persist);
    useLayoutEffect(() => {
        checkpoint.mount();
        const unregister = canvasUpdateFlush.register(() => checkpoint.flush(value => persistRef.current(value)));
        return () => { unregister(); checkpoint.unmount(); };
    }, [checkpoint]);
    useLayoutEffect(() => {
        persistRef.current = persist;
        checkpoint.commit(ticket, snapshot, isReady());
    });
}
