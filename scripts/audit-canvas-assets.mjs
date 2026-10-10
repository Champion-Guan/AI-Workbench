// Conservative deployment audit: follow filenames through HTML and bundle text.
// Cleanup moves unused files to the sibling backup directory, never deletes them.
import { readdir, readFile, stat, mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(root, 'public/infinite-canvas/assets');
const names = await readdir(assets);
const roots = [
  'public/infinite-canvas/index.html', 'src/server/index.mjs',
  'public/index.html', 'public/assets/local-canvas/canvas.js',
  'src/shared/data-contract/index.js',
];
const pending = await Promise.all(roots.map(file => readFile(path.join(root, file), 'utf8')));
const reachable = new Set();
while (pending.length) {
  const source = pending.pop();
  for (const name of names) {
    if (reachable.has(name) || !source.includes(name)) continue;
    reachable.add(name);
    const file = path.join(assets, name);
    if (!(await stat(file)).isFile()) throw new Error(`Unexpected asset directory: ${name}`);
    pending.push(await readFile(file, 'utf8'));
  }
}
if (!reachable.size) throw new Error('No entry assets found; refusing cleanup.');
const unused = names.filter(name => !reachable.has(name));
const bytes = (await Promise.all(unused.map(async name => (await stat(path.join(assets, name))).size)))
  .reduce((total, size) => total + size, 0);
console.log(JSON.stringify({ active: [...reachable].sort(), unusedCount: unused.length, unusedBytes: bytes }, null, 2));
if (process.argv.includes('--quarantine') && unused.length) {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const backup = path.resolve(root, '../guan-ai-workbench-backups', `guan-ai-workbench-${stamp}-unused-canvas-assets`);
  await mkdir(backup, { recursive: false });
  // Manifest is written before moving, so an interrupted run is recoverable.
  await writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ source: assets, files: unused }, null, 2));
  for (const name of unused) await rename(path.join(assets, name), path.join(backup, name));
  console.log(`Quarantined ${unused.length} files in ${backup}`);
}
