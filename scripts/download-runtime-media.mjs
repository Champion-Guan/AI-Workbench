import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const archive = join(root, "archive");
const chunks = join(archive, "assets/storage.pixpix.media/releases/_next/static/chunks");
const mediaRoot = join(archive, "assets/storage.pixpix.media/releases/_next/static/media");
const upstream = "https://storage.pixpix.media/releases/_next/static/media/";
const pattern = /static\/media\/([A-Za-z0-9._@-]+)/g;

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

async function download(name) {
  const output = join(mediaRoot, name);
  if (!output.startsWith(mediaRoot)) throw new Error("Unsafe file name: " + name);
  try { if ((await stat(output)).isFile()) return { name, state: "existing" }; } catch {}
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(upstream + name, { headers: { "user-agent": "local-static-archive/1.0" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = new Uint8Array(await response.arrayBuffer());
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, data);
      return { name, state: "downloaded", bytes: data.byteLength };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function pool(items, limit, task) {
  const queue = [...items];
  await Promise.all(Array.from({ length: limit }, async () => {
    while (queue.length) await task(queue.shift());
  }));
}

const names = new Set();
for (const file of await walk(chunks)) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(pattern)) names.add(match[1]);
}
const report = { generatedAt: new Date().toISOString(), assets: names.size, downloaded: [], existing: [], failed: [] };
console.log("Checking " + names.size + " runtime static media files...");
await pool([...names].sort(), 6, async (name) => {
  try {
    const result = await download(name);
    report[result.state].push(result);
    if (result.state === "downloaded") console.log("Downloaded " + name);
  } catch (error) {
    report.failed.push({ name, error: String(error && error.message ? error.message : error) });
    console.error("Failed " + name);
  }
});
await writeFile(join(archive, "runtime-media-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ assets: report.assets, downloaded: report.downloaded.length, existing: report.existing.length, failed: report.failed.length }, null, 2));
if (report.failed.length) process.exitCode = 1;
