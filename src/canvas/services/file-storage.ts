import localforage from "localforage";
import { observeActivity } from "@/lib/update-activity";
import { observeStorageWrites } from "@/lib/activity-storage";
import { settleActivityGroup } from "@/lib/settle-activity-group";
import { nanoid } from "nanoid";

import { withLocalProxy } from "@/stores/use-config-store";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = observeStorageWrites(localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" }));
const objectUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    return observeActivity("storage", () => uploadMediaFileImpl(input, prefix));
}

async function uploadMediaFileImpl(input: string | Blob, prefix: string): Promise<UploadedFile> {
    let blob: Blob;
    if (typeof input === "string") {
        const response = await fetch(withLocalProxy(input), { signal: AbortSignal.timeout(10 * 60_000) });
        if (!response.ok) throw new Error(`缓存媒体原文件失败（HTTP ${response.status}）`);
        blob = await response.blob();
    } else blob = input;
    if (!blob.size || /(?:text\/html|application\/json)/i.test(blob.type)) throw new Error("返回内容不是有效的媒体文件");
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    return observeActivity("storage", () => setMediaBlobImpl(storageKey, blob));
}

async function setMediaBlobImpl(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    return observeActivity("storage", () => deleteStoredMediaImpl(keys));
}

async function deleteStoredMediaImpl(keys: Iterable<string>) {
    await settleActivityGroup(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    return observeActivity("storage", () => cleanupUnusedMediaImpl(usedData));
}

async function cleanupUnusedMediaImpl(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    // Current assets/projects are not an authoritative reference inventory:
    // history, recycled products, cached frames and in-flight saves may own keys.
    // Never delete originals based on this partial automatic scan.
    return { status: "retained" as const, candidates: unused.length, reason: "reference_inventory_unverified" as const };
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => {
            window.clearTimeout(timer);
            video.onloadedmetadata = null;
            video.onerror = null;
            resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        };
        const timer = window.setTimeout(done, 10_000);
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => {
            window.clearTimeout(timer);
            audio.onloadedmetadata = null;
            audio.onerror = null;
            resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        };
        const timer = window.setTimeout(done, 10_000);
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
