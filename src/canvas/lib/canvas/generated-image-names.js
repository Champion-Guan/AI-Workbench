export function generatedImageName(node, imageId) {
    const images = node.metadata?.images || [];
    const index = images.findIndex(image => image.id === imageId);
    if (index >= 0 && images[index].name) return images[index].name;
    const title = node.title || "生成图片";
    const numbered = title.match(/^(.*)-(\d+)$/);
    if (numbered && index > 0) return `${numbered[1]}-${Number(numbered[2]) + index}`;
    return index > 0 ? `${title}-${index + 1}` : title;
}

// Reserve a whole batch before requests complete; retries retain their original slots.
export function numberGeneratedImages(nodes, sourceBase) {
    const bases = new Map(nodes.filter(node => node.type === "image").map(node => [node.id, sourceBase(node)]));
    const next = new Map();
    for (const node of nodes) {
        const base = bases.get(node.id);
        if (base) for (const image of node.metadata?.images || []) {
            const sequence = image.name?.startsWith(`${base}-`) ? Number(image.name.slice(base.length + 1)) : NaN;
            if (Number.isSafeInteger(sequence) && sequence > 0) next.set(base, Math.max(next.get(base) || 1, sequence + 1));
        }
        if (!base || !node.title?.startsWith(`${base}-`)) continue;
        const start = Number(node.title.slice(base.length + 1));
        if (Number.isSafeInteger(start) && start > 0) next.set(base, Math.max(next.get(base) || 1, start + Math.max(1, node.metadata?.images?.length || 0)));
    }
    let changed = false;
    const result = nodes.map(node => {
        const base = bases.get(node.id);
        if (!base) return node;
        const existing = node.title?.startsWith(`${base}-`) ? Number(node.title.slice(base.length + 1)) : NaN;
        const start = Number.isSafeInteger(existing) && existing > 0 ? existing : next.get(base) || 1;
        next.set(base, Math.max(next.get(base) || 1, start + Math.max(1, node.metadata?.images?.length || 0)));
        const title = `${base}-${start}`;
        const images = node.metadata?.images?.map((image, index) => ({ ...image, name: image.name || `${base}-${start + index}` }));
        if (node.title === title && !images?.some((image, index) => image.name !== node.metadata.images[index].name)) return node;
        changed = true;
        return { ...node, title, metadata: { ...node.metadata, ...(images ? { images } : {}) } };
    });
    return changed ? result : nodes;
}
