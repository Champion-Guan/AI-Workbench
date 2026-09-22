import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const archiveRoot = join(projectRoot, "archive");
const pageRoot = join(archiveRoot, "pages");
const assetRoot = join(archiveRoot, "assets");
const port = Number(process.env.PORT || 5174);

const allowedRoutes = new Set([
  "/zh-CN/tools/product-set",
  "/zh-CN/tools/detail-page",
  "/zh-CN/tools/hot-seller-replicate",
  "/zh-CN/tools/product-retouch",
  "/zh-CN/tools/product-recolor",
  "/zh-CN/tools/video-replicate",
  "/zh-CN/tools/seller-video",
  "/zh-CN/tools/video-background-removal",
  "/zh-CN/tools/flux-video-upscale",
  "/zh-CN/tools/video-upscale",
  "/zh-CN/tools/video-watermark-removal",
  "/zh-CN/tools/video-compression",
  "/zh-CN/tools/apparel-set",
  "/zh-CN/tools/model-try-on",
  "/zh-CN/tools/underwear-change",
  "/zh-CN/tools/shoe-try-on",
  "/zh-CN/tools/accessory-try-on",
]);

const contentTypes = {
  ".avif": "image/avif", ".css": "text/css; charset=utf-8", ".gif": "image/gif", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".mp4": "video/mp4", ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".webm": "video/webm", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
};

function safeFile(root, relative) {
  const target = join(root, normalize(relative.replace(/^\/+/, "")));
  return target.startsWith(root) ? target : null;
}

async function existingFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function send(response, path, method) {
  response.writeHead(200, {
    "content-type": contentTypes[extname(path).toLowerCase()] || "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "x-static-archive": "pixpix-tools-17-pages",
  });
  if (method === "HEAD") return response.end();
  createReadStream(path).pipe(response);
}

function notFound(response) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end("Not found. This static project serves only the archived 17 tool pages and their local assets.");
}

const server = createServer(async (request, response) => {
  const method = request.method || "GET";
  if (!["GET", "HEAD"].includes(method)) {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname.replace(/\/$/, "") || "/";
  if (pathname.startsWith("/_pixpix-assets/")) {
    const file = safeFile(assetRoot, pathname.slice("/_pixpix-assets/".length));
    if (file && await existingFile(file)) return send(response, file, method);
    return notFound(response);
  }

  if (!allowedRoutes.has(pathname)) return notFound(response);
  const page = safeFile(pageRoot, pathname + "/index.html");
  if (!page || !await existingFile(page)) return notFound(response);
  return send(response, page, method);
});

server.listen(port, "127.0.0.1", () => {
  console.log("PixPix 静态工具归档运行在 http://127.0.0.1:" + port);
});
