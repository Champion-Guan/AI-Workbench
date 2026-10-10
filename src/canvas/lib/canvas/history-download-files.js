import { generatedImageName } from './generated-image-names.js';

// Snapshot individual successful files, including successful slots in partial batches.
export function historyDownloadFiles(nodes) {
    return nodes.flatMap(node => {
        const metadata = node.metadata || {};
        if (metadata.images?.length) {
            return metadata.images.flatMap(image => image.content && image.status !== 'loading' && image.status !== 'error'
                ? [{ id: JSON.stringify([node.id, image.id]), imageId: image.id, node, content: image.content, storageKey: image.storageKey, name: generatedImageName(node, image.id) }]
                : []);
        }
        return metadata.content && metadata.status !== 'loading' && metadata.status !== 'error'
            ? [{ id: JSON.stringify([node.id]), node, content: metadata.content, storageKey: metadata.storageKey, name: node.title || '生成文件' }]
            : [];
    });
}
