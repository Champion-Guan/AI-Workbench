import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  resolve(root, "archive/assets/storage.pixpix.media/releases/_next/static/chunks/6517-f7cdd8691dde599f.js"),
  resolve(root, "archive/assets/storage.pixpix.media/releases/_next/static/chunks/app/%5Blocale%5D/layout-947fbac9d73eeec2.js"),
];
const remote = "https://storage.pixpix.media/pixpix/frontend/";
const local = "/_pixpix-media/";

for (const path of files) {
  const before = await readFile(path, "utf8");
  const after = before.split(remote).join(local);
  if (after === before) throw new Error("Frontend media helper not found: " + path);
  await writeFile(path, after);
  console.log("Rewrote " + path);
}
