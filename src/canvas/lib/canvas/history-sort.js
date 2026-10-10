function sortKey(title) {
    const text = String(title || "").trim();
    const main = text.match(/^主图(?:\s*[-－]\s*(\d+))?$/);
    if (main) return [0, 0, Number(main[1] || 1)];
    const detail = text.match(/^详情页\s*(\d+)(?:\s*[-－]\s*(\d+))?$/);
    if (detail) return [1, Number(detail[1]), Number(detail[2] || 1)];
    const rich = text.match(/^富内容\s*(\d+)(?:\s*[-－]\s*(\d+))?$/);
    if (rich) return [2, Number(rich[1]), Number(rich[2] || 1)];
    return [3, 0, 0];
}

export function sortGenerationHistory(nodes) {
    return nodes.map((node, index) => ({ node, index, key: sortKey(node.title) }))
        .sort((a, b) => {
            for (let index = 0; index < 3; index++) {
                const difference = a.key[index] - b.key[index];
                if (difference) return difference;
            }
            return a.index - b.index;
        }).map(item => item.node);
}
