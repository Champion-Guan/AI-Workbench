// Match the displayed primary image. Never substitute requested or upstream-original dimensions.
export function historyMediaInfo(node) {
    const metadata = node.metadata || {};
    const images = metadata.images || [];
    const media = images.find(image => image.id === metadata.primaryImageId)
        || images.find(image => image.content && image.content === metadata.content)
        || images.find(image => image.content)
        || metadata;
    const width = media.naturalWidth;
    const height = media.naturalHeight;
    const mime = String(media.mimeType || "").split(";", 1)[0].toLowerCase();
    const format = ({ "image/jpeg": "JPG", "image/png": "PNG", "image/webp": "WEBP", "image/gif": "GIF", "image/avif": "AVIF", "video/mp4": "MP4", "video/webm": "WEBM", "video/quicktime": "MOV" })[mime]
        || (mime.includes("/") ? mime.split("/")[1].toUpperCase() : "格式未知");
    return {
        channel: metadata.channel || "渠道未知",
        model: metadata.model || "模型未知",
        dimensions: width > 0 && height > 0 ? `${width}x${height}` : "尺寸未知",
        bytes: media.bytes > 0 ? media.bytes : 0,
        format,
    };
}
