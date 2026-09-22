import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const file = resolve(root, "archive/assets/storage.pixpix.media/releases/_next/static/chunks/webpack-7cc8afb9b860bb0c.js");
const remote = "https://storage.pixpix.media/releases/_next/";
const local = "/_pixpix-assets/storage.pixpix.media/releases/_next/";
const before = await readFile(file, "utf8");
const after = before.split(remote).join(local);
if (after === before) throw new Error("Webpack static asset root not found: " + file);
await writeFile(file, after);
console.log("Rewrote local asset root in " + file);
