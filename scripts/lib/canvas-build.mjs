import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

async function filesUnder(root, excluded = new Set()) {
  const files = new Map();
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      if (excluded.has(name) || name.startsWith('.')) continue;
      const file = path.join(directory, name), info = await lstat(file);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw Error('Unsafe canvas build input');
      if (info.isDirectory()) await walk(file);
      else files.set(path.relative(root, file).split(path.sep).join('/'), await readFile(file));
    }
  }
  await walk(root); return files;
}
export async function canvasSourceFingerprint(projectRoot) {
  const hash = createHash('sha256');
  const files = await filesUnder(path.join(projectRoot, 'src/canvas'), new Set(['node_modules', 'dist']));
  files.set('../../package.json', await readFile(path.join(projectRoot, 'package.json')));
  files.set('../../scripts/lib/canvas-build.mjs', await readFile(path.join(projectRoot, 'scripts/lib/canvas-build.mjs')));
  for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name).update('\0').update(createHash('sha256').update(content).digest()).update('\0');
  }
  return hash.digest('hex');
}
export async function writeCanvasBuildManifest(projectRoot, distRoot) {
  const { version } = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const files = await filesUnder(distRoot);
  files.delete('CANVAS-BUILD.json');
  const manifest = { app: 'guan-ai-workbench', format: 1, version, sourceHash: await canvasSourceFingerprint(projectRoot),
    files: Object.fromEntries([...files].map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')])) };
  await writeFile(path.join(distRoot, 'CANVAS-BUILD.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export async function verifyCanvasBuild(projectRoot, distRoot) {
  const { version } = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const actual = await filesUnder(distRoot), manifest = JSON.parse(actual.get('CANVAS-BUILD.json')?.toString() || 'null');
  if (manifest?.app !== 'guan-ai-workbench' || manifest.format !== 1 || manifest.version !== version || manifest.sourceHash !== await canvasSourceFingerprint(projectRoot)
    || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw Error('Canvas build is stale or unidentified; build again');
  actual.delete('CANVAS-BUILD.json');
  if (actual.size !== Object.keys(manifest.files).length) throw Error('Canvas build inventory mismatch');
  for (const [name, content] of actual) if (manifest.files[name] !== createHash('sha256').update(content).digest('hex')) throw Error('Canvas build integrity mismatch');
  const html = actual.get('index.html')?.toString() || '';
  const entries = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1].slice(1));
  if (!entries.some(name => name.endsWith('.js')) || !actual.has('excel-prompts-bridge.js') || entries.some(name => !actual.has(name))) throw Error('Canvas runtime resources missing');
  return manifest;
}
export async function copyVerifiedCanvasBuild(projectRoot, distRoot, target) {
  const manifest = await verifyCanvasBuild(projectRoot, distRoot);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(distRoot, target, { recursive: true, force: false, errorOnExist: true });
  // Validate the copy as well; never touch the live production web root.
  await verifyCanvasBuild(projectRoot, target);
  return manifest;
}
