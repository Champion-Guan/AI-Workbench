import { lstat, mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { verifyStableManifest, verifyStableArchive } from '../../src/server/stable-manifest.mjs';
import { validateZipArchive, verifyReleaseFiles } from './release-validation.mjs';
import { machArchitecture } from './stable-runtime.mjs';

export async function verifySignedStable({ directory, repository, version, arch, trustedKeys, currentVersion }) {
  async function bounded(name, limit) {
    const file = path.join(directory, name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw Error('Unsafe signed artifact');
    const bytes = await readFile(file); if (bytes.length > limit) throw Error('Artifact grew during verification');
    return bytes;
  }
  const bytes = await bounded('guan-stable-manifest.json', 65536), signature = await bounded('guan-stable-manifest.sig', 64);
  const { manifest, selected } = verifyStableManifest(bytes, signature, { repository, releaseVersion: version, arch, platform: 'darwin', trustedKeys, currentVersion });
  const archive = await bounded(selected.name, selected.size); verifyStableArchive(archive, selected);
  const zip = validateZipArchive(archive, { trustedRuntime: selected });
  if (zip.root !== selected.name.slice(0, -4)) throw Error('Stable root mismatch');
  const temporary = await mkdtemp(path.join(tmpdir(), 'guan-signed-check-')); await chmod(temporary, 0o700);
  try {
    // Extract the already verified bytes, not a replaceable original input.
    const { writePrivateFile } = await import('../../src/server/runtime-paths.mjs');
    const local = path.join(temporary, 'verified.zip'); await writePrivateFile(local, archive, { exclusive: true });
    execFileSync('unzip', ['-tq', local], { stdio: 'pipe' });
    execFileSync('unzip', ['-q', local, '-d', temporary], { stdio: 'pipe' });
    const checked = await verifyReleaseFiles(path.join(temporary, zip.root), { trustedRuntime: selected });
    const m = checked.manifest;
    if (m.edition !== 'stable' || m.channel !== 'stable' || m.version !== manifest.version || m.commit !== manifest.commit || m.arch !== arch || m.platform !== 'darwin'
      || m.nativeHelper?.arch !== arch || !m.canvasBuild || m.runtime !== selected.nodeVersion || m.automaticInstallAllowed !== false
      || m.bundledRuntime?.runtimeSha256 !== selected.runtimeSha256 || m.bundledRuntime?.runtimeSize !== selected.runtimeSize
      || machArchitecture(await readFile(path.join(temporary, zip.root, 'runtime/node'))) !== arch) throw Error('Signed package identity mismatch');
    return { manifest, selected, files: checked.files, buildId: checked.buildId, signatureVerified: true, executed: false };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
