import type { CanvasNodeData, Position } from "@/types/canvas";

export const NODE_PLACEMENT_GAP = 48;
export type PlacementBounds = { x: number; y: number; width: number; height: number };

function valid(node: CanvasNodeData) {
    return Number.isFinite(node.position.x) && Number.isFinite(node.position.y) && Number.isFinite(node.width) && Number.isFinite(node.height) && node.width > 0 && node.height > 0;
}

export function nodesOverlap(a: CanvasNodeData, b: CanvasNodeData, gap = 0) {
    return valid(a) && valid(b) && a.position.x < b.position.x + b.width + gap && a.position.x + a.width + gap > b.position.x && a.position.y < b.position.y + b.height + gap && a.position.y + a.height + gap > b.position.y;
}

/** Positions here are top-left canvas coordinates, independent of browser zoom. */
export function placeCanvasNode(node: CanvasNodeData, occupied: CanvasNodeData[], bounds?: PlacementBounds): CanvasNodeData {
    if (node.type === "group" || !valid(node)) return node;
    // Group backgrounds are containers, not cards. Their children remain obstacles.
    const obstacles = occupied.filter((other) => other.id !== node.id && other.type !== "group" && valid(other));
    const free = (position: Position) => !obstacles.some((other) => nodesOverlap({ ...node, position }, other, NODE_PLACEMENT_GAP));
    const inside = (position: Position) => !bounds || (position.x >= bounds.x && position.y >= bounds.y && position.x + node.width <= bounds.x + bounds.width && position.y + node.height <= bounds.y + bounds.height);
    if (free(node.position) && inside(node.position)) return node;
    if (bounds) {
        // Try the closest visible grid slots first. Bound the search even on huge canvases.
        const candidates: Position[] = [];
        const stepX = node.width + NODE_PLACEMENT_GAP;
        const stepY = node.height + NODE_PLACEMENT_GAP;
        for (let row = -8; row <= 8; row++) for (let col = -8; col <= 8; col++) {
            candidates.push({ x: node.position.x + col * stepX, y: node.position.y + row * stepY });
        }
        candidates.push({ x: bounds.x, y: bounds.y });
        for (const other of obstacles) {
            candidates.push({ x: other.position.x + other.width + NODE_PLACEMENT_GAP, y: node.position.y });
            candidates.push({ x: node.position.x, y: other.position.y + other.height + NODE_PLACEMENT_GAP });
        }
        candidates.sort((a, b) => Math.hypot(a.x - node.position.x, a.y - node.position.y) - Math.hypot(b.x - node.position.x, b.y - node.position.y));
        const position = candidates.find((candidate) => inside(candidate) && free(candidate));
        if (position) return { ...node, position };
    }
    // Automatic results retain their source column and flow downward around occupied rows.
    let position = { ...node.position };
    for (let attempt = 0; attempt <= obstacles.length; attempt++) {
        const hits = obstacles.filter((other) => nodesOverlap({ ...node, position }, other, NODE_PLACEMENT_GAP));
        if (!hits.length) return position.x === node.position.x && position.y === node.position.y ? node : { ...node, position };
        position = { x: position.x, y: Math.max(...hits.map((other) => other.position.y + other.height + NODE_PLACEMENT_GAP)) };
    }
    return { ...node, position };
}

function expandChangedGroups(nodes: CanvasNodeData[], moved: Set<string>) {
    const groups = new Set(nodes.filter((node) => moved.has(node.id)).map((node) => node.metadata?.groupId).filter(Boolean));
    return nodes.map((group) => {
        if (group.type !== "group" || !groups.has(group.id)) return group;
        const children = nodes.filter((node) => node.metadata?.groupId === group.id && valid(node));
        if (!children.length) return group;
        const x = Math.min(group.position.x, ...children.map((node) => node.position.x - 24));
        const y = Math.min(group.position.y, ...children.map((node) => node.position.y - 48));
        const right = Math.max(group.position.x + group.width, ...children.map((node) => node.position.x + node.width + 24));
        const bottom = Math.max(group.position.y + group.height, ...children.map((node) => node.position.y + node.height + 24));
        return x === group.position.x && y === group.position.y && right === group.position.x + group.width && bottom === group.position.y + group.height ? group : { ...group, position: { x, y }, width: right - x, height: bottom - y };
    });
}

/** One state transaction reserves every new card, including concurrent/batch additions. */
export function placeNewCanvasNodes(previous: CanvasNodeData[], next: CanvasNodeData[]) {
    const previousById = new Map(previous.map((node) => [node.id, node]));
    const needsPlacement = (node: CanvasNodeData) => {
        const old = previousById.get(node.id);
        if (!old) return true;
        // Generated media can grow when the real dimensions arrive. Do not
        // treat manual resize/drag/config edits as an automatic layout request.
        return Boolean(node.metadata?.generationStartedAt && (node.width !== old.width || node.height !== old.height) && (node.metadata?.content !== old.metadata?.content || node.metadata?.status !== old.metadata?.status));
    };
    const candidates = new Set(next.filter(needsPlacement).map((node) => node.id));
    if (!candidates.size) return next;
    const occupied = next.filter((node) => !candidates.has(node.id));
    const moved = new Set<string>();
    const result = next.map((node) => {
        if (!candidates.has(node.id)) return node;
        const placed = placeCanvasNode(node, occupied);
        occupied.push(placed);
        if (placed !== node) moved.add(node.id);
        return placed;
    });
    return moved.size ? expandChangedGroups(result, moved) : next;
}

/** Keep non-overlapping cards fixed; only later cards in overlapping pairs move. */
export function arrangeOverlappingCanvasNodes(nodes: CanvasNodeData[]) {
    const kept: CanvasNodeData[] = [];
    const victims = new Set<string>();
    for (const node of nodes) {
        if (node.type === "group") continue;
        if (kept.some((other) => nodesOverlap(node, other))) victims.add(node.id);
        else kept.push(node);
    }
    if (!victims.size) return nodes;
    const result = nodes.map((node) => {
        if (!victims.has(node.id)) return node;
        const placed = placeCanvasNode(node, kept);
        kept.push(placed);
        return placed;
    });
    return expandChangedGroups(result, victims);
}
