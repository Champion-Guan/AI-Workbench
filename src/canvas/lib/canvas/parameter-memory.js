// Product identity, not the editable canvas title or disposable card id.
export function parameterMemoryKey(href) {
    try {
        const url = new URL(href);
        const id = url.searchParams.get("workbenchProductId") || url.pathname.match(/\/canvas\/([^/]+)/)?.[1];
        return id ? `guan-canvas-parameter-values:${encodeURIComponent(id)}` : null;
    } catch { return null; }
}

function stringValues(values) {
    return values && typeof values === "object" && !Array.isArray(values)
        ? Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === "string")) : {};
}

export function readParameterMemory(storage, key) {
    if (!key) return {};
    try { return stringValues(JSON.parse(storage.getItem(key) || "{}")); }
    catch { return {}; }
}

export function saveParameterMemory(storage, key, values) {
    if (!key) return false;
    try {
        // Preserve other fields, including ones absent from a newly imported workbook.
        // Explicit empty strings are saved too, so clearing a value stays cleared.
        const next = { ...readParameterMemory(storage, key), ...stringValues(values) };
        storage.setItem(key, JSON.stringify(next));
        return true;
    } catch { return false; }
}

export function currentParameterMemory() {
    try {
        return { storage: window.localStorage, key: parameterMemoryKey(window.location.href) };
    } catch { return { storage: null, key: null }; }
}

export function readCurrentParameterValues() {
    const { storage, key } = currentParameterMemory();
    return readParameterMemory(storage, key);
}

export function saveCurrentParameterValues(values) {
    const { storage, key } = currentParameterMemory();
    return saveParameterMemory(storage, key, values);
}
