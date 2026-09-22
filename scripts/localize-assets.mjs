import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const archive = join(root, "archive");
const assets = join(archive, "assets");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".mjs"]);
const pattern = /https:\/\/(?:storage|static)\.pixpix\.media\/[^\s"\'<>\\)]+/g;
const report = { generatedAt: new Date().toISOString(), downloaded: [], failed: [], skipped: [] };

function extension(path) {
  return path.slice(path.lastIndexOf(".")).toLowerCase();
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function clean(raw) {
  return raw.replace(/[.,;]+$/, "");
}

function assetPath(url) {
  const hostRoot = join(assets, url.host);
  const output = join(hostRoot, url.pathname.replace(/^\/+/, ""));
  if (!output.startsWith(hostRoot)) throw new Error("Unsafe path");
  return output;
}

function localPath(url) {
  return "/_pixpix-assets/" + url.host + url.pathname;
}

async function fetchAsset(url) {
  const output = assetPath(url);
  try {
    if ((await stat(output)).isFile()) return { output, downloaded: false };
  } catch {}
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "local-static-archive/1.0" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes);
      return { output, downloaded: true, bytes: bytes.byteLength };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function runPool(items, limit, worker) {
  const queue = [...items];
  await Promise.all(Array.from({ length: limit }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

for (let pass = 1; pass <= 4; pass += 1) {
  const files = (await walk(archive)).filter((path) => textExtensions.has(extension(path))
    && !path.endsWith("/source.html")
    && !path.endsWith("/manifest.json")
    && !path.endsWith("/localization.json"));
  const contents = new Map(await Promise.all(files.map(async (path) => [path, await readFile(path, "utf8")])));
  const candidates = new Map();
  for (const [path, text] of contents) {
    for (const match of text.matchAll(pattern)) {
      const raw = clean(match[0]);
      if (raw.includes("${")) {
        report.skipped.push({ file: relative(archive, path), source: raw, reason: "Dynamic template" });
        continue;
      }
      try { candidates.set(raw, new URL(raw)); }
      catch { report.skipped.push({ file: relative(archive, path), source: raw, reason: "Invalid URL" }); }
    }
  }
  if (!candidates.size) break;
  console.log("Pass " + pass + ": checking " + candidates.size + " local media files");
  const replacements = new Map();
  await runPool([...candidates.entries()], 8, async ([raw, url]) => {
    try {
      const item = await fetchAsset(url);
      replacements.set(raw, localPath(url));
      if (item.downloaded) {
        report.downloaded.push({ source: raw, file: relative(archive, item.output), bytes: item.bytes });
        console.log("Downloaded " + relative(assets, item.output));
      }
    } catch (error) {
      report.failed.push({ source: raw, error: String(error && error.message ? error.message : error) });
      console.error("Could not download " + raw);
    }
  });
  for (const [path, text] of contents) {
    let next = text;
    for (const [remote, local] of replacements) next = next.split(remote).join(local);
    if (next !== text) await writeFile(path, next);
  }
  if (!report.downloaded.length) break;
}

await writeFile(join(archive, "localization.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ downloaded: report.downloaded.length, failed: report.failed.length, skipped: report.skipped.length }, null, 2));
if (report.failed.length) process.exitCode = 1;
