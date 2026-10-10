import localforage from "localforage";
import { frontendActivity, observeActivity } from "@/lib/update-activity";
import { observeStorageWrites } from "@/lib/activity-storage";
import { settleActivityGroup } from "@/lib/settle-activity-group";
import { createPersistenceCheckpoint } from "@/lib/persistence-checkpoint";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { withLocalProxy } from "@/stores/use-config-store";
import { createImageThumbnail } from "@/lib/image-thumbnail";
import { parseDeliverySize, deliveryAction, resizeDeliveryBlob } from "@/lib/image-delivery";

export type UploadedImage = {
    url: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    originalImage?: { storageKey: string; width: number; height: number; bytes: number; mimeType: string };
    deliveryNote?: string;
};

const store = observeStorageWrites(localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" }));
const previewStore = observeStorageWrites(localforage.createInstance({ name: "infinite-canvas", storeName: "image_previews" }));
const imageLogStore = observeStorageWrites(localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" }));
const videoLogStore = observeStorageWrites(localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" }));
const objectUrls = new Map<string, string>();
const previewUrls = new Map<string, string>();
const previewListeners = new Set<() => void>();
let previewRevision = 0;
let previewQueue: Promise<unknown> = Promise.resolve();
const IMAGE_PREVIEW_VERSION = 1;
const previewCheckpoint = createPersistenceCheckpoint();
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_REMOTE_LOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_DECODE_TIMEOUT_MS = 10_000;
const IMAGE_RESPONSE_ERROR = "ImageResponseError";
const IMAGE_TIMEOUT_ERROR = "ImageTimeoutError";

type StoredImagePreview = { version: number; blob?: Blob };

type ImageReadOptions = { signal?: AbortSignal; requireLocalCache?: boolean };

/** A generated result is only complete once its original bytes are persisted. */
export async function uploadGeneratedImage(input: string | Blob, options?: ImageReadOptions & { targetSize?: string }) {
    return observeActivity("storage", () => uploadGeneratedImageImpl(input, options));
}

async function uploadGeneratedImageImpl(input: string | Blob, options?: ImageReadOptions & { targetSize?: string }) {
    const target = parseDeliverySize(options?.targetSize);
    const original = await uploadImage(input, { ...options, requireLocalCache: true });
    const action = deliveryAction(original.width, original.height, target);
    if (action === "original") return original;
    if (action === "ratio-mismatch") return { ...original, deliveryNote: "上游图片比例与交付尺寸不同，已保留原图，未拉伸或裁切" };
    const blob = await getImageBlob(original.storageKey!);
    if (!blob) throw new Error("生成原图缓存丢失");
    const delivery = await uploadImage(await resizeDeliveryBlob(blob, target!), { ...options, requireLocalCache: true });
    return { ...delivery, originalImage: { storageKey: original.storageKey!, width: original.width, height: original.height, bytes: original.bytes, mimeType: original.mimeType }, deliveryNote: "已按交付尺寸等比例缩放，生成原图另行保留" };
}

export async function uploadImage(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    return observeActivity("storage", () => uploadImageImpl(input, options));
}

async function uploadImageImpl(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    if (typeof input !== "string") return storeImage(input, options);

    let blob: Blob;
    try {
        blob = await fetchImageBlob(input, options);
    } catch (error) {
        if (options?.requireLocalCache || options?.signal?.aborted || isNamedError(error, IMAGE_RESPONSE_ERROR) || isNamedError(error, IMAGE_TIMEOUT_ERROR) || !/^https?:\/\//i.test(input)) throw error;
        const meta = await loadImageMeta(input, options, IMAGE_REMOTE_LOAD_TIMEOUT_MS);
        if (!meta) throw error;
        return { url: input, width: meta.width, height: meta.height, bytes: 0, mimeType: "" };
    }
    return storeImage(blob, options);
}

async function storeImage(blob: Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    const storageKey = `image:${nanoid()}`;
    const url = URL.createObjectURL(blob);
    try {
        throwIfAborted(options?.signal);
        await store.setItem(storageKey, blob);
        const meta = await loadImageMeta(url, options);
        if (!meta) throw new Error(i18n.t("common.imageReadFailed"));
        throwIfAborted(options?.signal);
        objectUrls.set(storageKey, url);
        // The original is ready now; thumbnail work must not delay success/download.
        queueImagePreview(storageKey);
        return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type.startsWith("image/") ? blob.type : "" };
    } catch (error) {
        URL.revokeObjectURL(url);
        await store.removeItem(storageKey).catch(() => undefined);
        throw error;
    }
}

async function fetchImageBlob(url: string, options?: ImageReadOptions) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(withLocalProxy(url), { signal: controller.signal });
        if (!response.ok) throw namedError(IMAGE_RESPONSE_ERROR);
        return await response.blob();
    } catch (error) {
        if (timedOut) throw namedError(IMAGE_TIMEOUT_ERROR);
        if (options?.signal?.aborted) throw abortReason(options.signal);
        throw error;
    } finally {
        window.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

function loadImageMeta(url: string, options?: ImageReadOptions, timeoutMs = IMAGE_DECODE_TIMEOUT_MS) {
    return new Promise<{ width: number; height: number } | null>((resolve, reject) => {
        if (options?.signal?.aborted) return reject(abortReason(options.signal));
        const image = new Image();
        let settled = false;
        const finish = (value: { width: number; height: number } | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            options?.signal?.removeEventListener("abort", abort);
            image.onload = null;
            image.onerror = null;
            resolve(value);
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            reject(abortReason(options!.signal!));
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        options?.signal?.addEventListener("abort", abort, { once: true });
        image.onload = () => finish(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        image.onerror = () => finish(null);
        image.src = url;
    });
}

function namedError(name: string) {
    const error = new Error(i18n.t("common.imageReadFailed"));
    error.name = name;
    return error;
}

function isNamedError(error: unknown, name: string) {
    return error instanceof Error && error.name === name;
}

function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal);
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

// 缩略图按图片的 storageKey 另存一份 WebP，只放在本地 IndexedDB 里，不写进节点数据，也不参与导出和 WebDAV 同步。
export function previewUrlFor(storageKey?: string) {
    return storageKey ? previewUrls.get(storageKey) : undefined;
}

// 缩略图在后台补，生成完成后再让用到它的界面重渲染一次。
export function subscribeImagePreviews(listener: () => void) {
    previewListeners.add(listener);
    return () => {
        previewListeners.delete(listener);
    };
}

export function getImagePreviewRevision() {
    return previewRevision;
}

export async function ensureImagePreview(storageKey?: string) {
    if (!storageKey) return undefined;
    const cached = previewUrls.get(storageKey);
    if (cached) return cached;
    const stored = await previewCheckpoint.run(`lookup:${storageKey}`, () => previewStore.getItem<StoredImagePreview>(storageKey)).catch(() => null);
    if (stored?.version === IMAGE_PREVIEW_VERSION) return stored.blob ? cacheImagePreview(storageKey, stored.blob) : undefined;
    queueImagePreview(storageKey);
    return undefined;
}

// 缩略图生成排成一队，避免一次打开大量图片时同时解码。
function queueImagePreview(storageKey: string) {
    // Acquire when queued, not only when thumbnail decoding eventually starts.
    const release = frontendActivity.acquire("storage");
    previewQueue = previewQueue
        .then(async () => {
            await previewCheckpoint.run(`queue:${storageKey}`, async () => {
                const original = await getImageBlob(storageKey);
                if (original) await storeImagePreview(storageKey, original);
            });
        })
        .catch(() => undefined)
        .finally(release);
}

async function storeImagePreview(storageKey: string, original: Blob) {
    let preview: Blob | undefined;
    try { preview = await previewCheckpoint.run(`decode:${storageKey}`, () => createImageThumbnail(original)); }
    catch { return undefined; } // Failed decode is not a valid "preview unnecessary" cache record.
    await previewCheckpoint.run(`save:${storageKey}`, () => previewStore.setItem<StoredImagePreview>(storageKey, { version: IMAGE_PREVIEW_VERSION, blob: preview }));
    return preview ? cacheImagePreview(storageKey, preview) : undefined;
}

function cacheImagePreview(storageKey: string, preview: Blob) {
    const url = URL.createObjectURL(preview);
    previewUrls.set(storageKey, url);
    previewRevision += 1;
    previewListeners.forEach((listener) => listener());
    return url;
}

async function deleteImagePreview(storageKey: string) {
    const url = previewUrls.get(storageKey);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(storageKey);
    await previewStore.removeItem(storageKey).catch(() => undefined);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    return observeActivity("storage", () => setImageBlobImpl(storageKey, blob));
}

async function setImageBlobImpl(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    await deleteImagePreview(storageKey);
    await storeImagePreview(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, options?: ImageReadOptions) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await fetchImageBlob(url, options));
}

export async function deleteStoredImages(keys: Iterable<string>) {
    return observeActivity("storage", () => deleteStoredImagesImpl(keys));
}

async function deleteStoredImagesImpl(keys: Iterable<string>) {
    await settleActivityGroup(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await deleteImagePreview(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    return observeActivity("storage", () => cleanupUnusedImagesImpl(usedData));
}

async function cleanupUnusedImagesImpl(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    await settleActivityGroup([
        imageLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    const orphanPreviews: string[] = [];
    await previewStore.iterate((_value, key) => {
        if (!usedKeys.has(key)) orphanPreviews.push(key);
    });
    // History alone does not cover recycled snapshots, cached frames or pending
    // writes. Retain originals/previews until a trusted reference inventory exists.
    // Explicit user-requested deletion remains available through deleteStoredImages.
    return { status: "retained" as const, candidates: unused.length, previews: orphanPreviews.length, reason: "reference_inventory_unverified" as const };
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
