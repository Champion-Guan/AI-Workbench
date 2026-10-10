import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { withLocalProxy } from "@/stores/use-config-store";

type DownloadMedia = { kind: "image" | "video" | "audio"; storageKey?: string; url?: string };
const pendingDownloads = new Map<string, Promise<Blob>>();

/** Downloads always use the persisted original, never the thumbnail or a stale blob URL. */
export async function readDownloadBlob(media: DownloadMedia): Promise<Blob> {
    const storageKey = media.storageKey || await downloadCacheKey(media);
    const stored = await (media.kind === "image" ? getImageBlob(storageKey) : getMediaBlob(storageKey));
    if (stored) return stored;
    const pending = pendingDownloads.get(storageKey);
    if (pending) return pending;
    const download = (async () => {
        if (!media.url) throw new Error("本地缓存不存在，且没有可用的原文件地址");
        const response = await fetch(withLocalProxy(media.url), { signal: AbortSignal.timeout(10 * 60_000) });
        if (!response.ok) throw new Error(`读取原文件失败（HTTP ${response.status}）`);
        const blob = await response.blob();
        if (!blob.size || /(?:text\/html|application\/json)/i.test(blob.type)) throw new Error("返回内容不是有效的媒体文件");
        // Legacy records are repaired once; subsequent downloads work offline too.
        await (media.kind === "image" ? setImageBlob(storageKey, blob) : setMediaBlob(storageKey, blob));
        return blob;
    })();
    pendingDownloads.set(storageKey, download);
    try { return await download; }
    finally { pendingDownloads.delete(storageKey); }
}

async function downloadCacheKey(media: DownloadMedia) {
    if (!media.url) throw new Error("没有可下载的媒体文件");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(media.url));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    return `${media.kind}:download:${hash}`;
}
