import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const archive = join(root, "archive");
const chunks = join(archive, "assets/storage.pixpix.media/releases/_next/static/chunks");
const mediaRoot = join(archive, "assets/storage.pixpix.media/pixpix/frontend");
const origin = "https://storage.pixpix.media/pixpix/frontend/";
const pattern = /images\/tools\/[A-Za-z0-9][A-Za-z0-9._@/-]*/g;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && path.endsWith(".js")) files.push(path);
  }
  return files;
}

async function fetchOne(asset) {
  const destination = join(mediaRoot, asset);
  if (!destination.startsWith(mediaRoot)) throw new Error("Unsafe asset path: " + asset);
  try {
    if ((await stat(destination)).isFile()) return { asset, state: "existing" };
  } catch {}
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(origin + asset, { headers: { "user-agent": "local-static-archive/1.0" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = new Uint8Array(await response.arrayBuffer());
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data);
      return { asset, state: "downloaded", bytes: data.byteLength };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function pool(items, size, task) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await task(queue.shift());
  }));
}

const jsFiles = await walk(chunks);
const names = new Set();
for (const file of jsFiles) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(pattern)) names.add(match[0]);
}
const assets = [...names].sort();
const report = { generatedAt: new Date().toISOString(), assets: assets.length, downloaded: [], existing: [], failed: [] };
console.log("Checking " + assets.length + " tool preview files...");
await pool(assets, 6, async (asset) => {
  try {
    const result = await fetchOne(asset);
    report[result.state].push(result);
    if (result.state === "downloaded") console.log("Downloaded " + asset);
  } catch (error) {
    report.failed.push({ asset, error: String(error && error.message ? error.message : error) });
    console.error("Failed " + asset);
  }
});
await writeFile(join(archive, "tool-media-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ assets: report.assets, downloaded: report.downloaded.length, existing: report.existing.length, failed: report.failed.length }, null, 2));
if (report.failed.length) process.exitCode = 1;
