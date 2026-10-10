/** Explicit pixel sizes are delivery targets; ratios and auto are not. */
export function parseDeliverySize(value) {
    const match = String(value || "").trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!match) return undefined;
    const width = Number(match[1]), height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return undefined;
    // Bound canvas allocation independently of upstream API constraints.
    if (width > 16384 || height > 16384 || width * height > 40_000_000) throw new Error("交付尺寸过大，请使用不超过 4000 万像素、单边不超过 16384 的尺寸");
    return { width, height };
}

export function deliveryAction(width, height, target) {
    if (!target || (width === target.width && height === target.height)) return "original";
    // Allow only normal integer pixel rounding, never crop, pad, or stretch.
    const error = Math.abs(width * target.height - height * target.width);
    return error <= Math.max(width, height, target.width, target.height) / 2 ? "resize" : "ratio-mismatch";
}

export async function resizeDeliveryBlob(blob, target) {
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = target.width;
        canvas.height = target.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建交付图片画布");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, target.width, target.height);
        // Lossless PNG keeps transparency and avoids another JPEG generation.
        return await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("交付图片编码失败")), "image/png"));
    } finally { bitmap.close(); }
}
