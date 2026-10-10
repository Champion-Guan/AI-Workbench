import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeCanvasBuildManifest, verifyCanvasBuild, copyVerifiedCanvasBuild } from '../scripts/lib/canvas-build.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guan-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, 'src/canvas/dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'scripts/lib'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.3' }));
  await writeFile(path.join(root, 'src/canvas/main.ts'), 'const fixture = true;');
  await writeFile(path.join(root, 'scripts/lib/canvas-build.mjs'), '// fixture builder');
  await writeFile(path.join(dist, 'index.html'), '<script src="/assets/app.js"></script><link href="/assets/app.css">');
  await writeFile(path.join(dist, 'assets/app.js'), '// fixture compiled');
  await writeFile(path.join(dist, 'assets/app.css'), 'body{}');
  await writeFile(path.join(dist, 'excel-prompts-bridge.js'), '// fixture bridge');
  await writeCanvasBuildManifest(root, dist);
  return { root, dist };
}

test('current source build exact inventory verifies and isolated copy preserves source', async t => {
  const { root, dist } = await fixture(t), before = await readFile(path.join(dist, 'CANVAS-BUILD.json'));
  const manifest = await verifyCanvasBuild(root, dist);
  assert.equal(manifest.version, '1.0.3');
  const target = path.join(root, 'stage/public/infinite-canvas');
  assert.deepEqual(await copyVerifiedCanvasBuild(root, dist, target), manifest);
  assert.deepEqual(await readFile(path.join(dist, 'CANVAS-BUILD.json')), before);
  await assert.rejects(copyVerifiedCanvasBuild(root, dist, target));
});

for (const mutation of ['source', 'version', 'builder', 'tamper', 'extra', 'missing', 'symlink', 'bridge']) {
  test(`build rejects ${mutation} without changing or publishing the live web root`, async t => {
    const { root, dist } = await fixture(t);
    await mkdir(path.join(root, 'public'), { recursive: true });
    await writeFile(path.join(root, 'public/kept.txt'), 'production-kept');
    if (mutation === 'source') await writeFile(path.join(root, 'src/canvas/main.ts'), '// changed');
    if (mutation === 'version') await writeFile(path.join(root, 'package.json'), '{"version":"1.0.4"}');
    if (mutation === 'builder') await writeFile(path.join(root, 'scripts/lib/canvas-build.mjs'), '// changed builder');
    if (mutation === 'tamper') await writeFile(path.join(dist, 'assets/app.js'), '// tampered');
    if (mutation === 'extra') await writeFile(path.join(dist, 'assets/old.js'), '// stale');
    if (mutation === 'missing') await rm(path.join(dist, 'assets/app.css'));
    if (mutation === 'symlink') await symlink(path.join(root, 'package.json'), path.join(dist, 'linked.json'));
    if (mutation === 'bridge') { await rm(path.join(dist, 'excel-prompts-bridge.js')); await writeCanvasBuildManifest(root, dist); }
    await assert.rejects(verifyCanvasBuild(root, dist));
    assert.equal(await readFile(path.join(root, 'public/kept.txt'), 'utf8'), 'production-kept');
  });
}

test('unidentified old production build cannot be used as a current source build', async t => {
  const { root, dist } = await fixture(t), old = path.join(root, 'old');
  await cp(dist, old, { recursive: true }); await rm(path.join(old, 'CANVAS-BUILD.json'));
  await assert.rejects(verifyCanvasBuild(root, old), /stale or unidentified/);
});
