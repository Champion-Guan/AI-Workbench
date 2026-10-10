// Publish an explicitly built canvas as one deployment; keep the prior version.
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyCanvasBuild, copyVerifiedCanvasBuild } from './lib/canvas-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'src/canvas/dist');
const live = path.join(root, 'public/infinite-canvas');
if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Unknown canvas publish option');
await verifyCanvasBuild(root, source);
const html = await readFile(path.join(source, 'index.html'), 'utf8');
const entries = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
if (!entries.some(entry => entry.endsWith('.js'))) throw new Error('Build entry missing; run npm run build:canvas first.');
for (const entry of entries) {
  if (!(await stat(path.join(source, entry.slice(1)))).isFile()) throw new Error(`Missing build asset: ${entry}`);
}
await stat(path.join(source, 'excel-prompts-bridge.js'));
if (process.argv.includes('--check')) {
  console.log(`Build entries verified: ${entries.join(', ')}`);
  process.exit(0);
}
const now = new Date();
const pad = value => String(value).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const stage = path.join(root, `public/.canvas-publish-${process.pid}-${Date.now()}`);
const backupRoot = path.resolve(root, '../guan-ai-workbench-backups');
const backup = path.join(backupRoot, `guan-ai-workbench-${stamp}-canvas-deployment`);
await copyVerifiedCanvasBuild(root, source, stage);
await mkdir(backupRoot, { recursive: true });
await rename(live, backup);
try {
  await rename(stage, live);
} catch (error) {
  await rename(backup, live);
  throw error;
}
console.log(`Published canvas. Previous deployment preserved at ${backup}`);
