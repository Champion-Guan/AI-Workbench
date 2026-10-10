export function dimensionsFromAnchor(key, value, ratio, align = false) {
    const match = String(ratio).match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match || !Number(match[1]) || !Number(match[2])) return null;
    const snap = n => align ? Math.ceil(n / 16) * 16 : Math.max(1, Math.round(n));
    const anchor = snap(value);
    return key === "height"
        ? { width: snap(anchor * Number(match[1]) / Number(match[2])), height: anchor }
        : { width: anchor, height: snap(anchor * Number(match[2]) / Number(match[1])) };
}
