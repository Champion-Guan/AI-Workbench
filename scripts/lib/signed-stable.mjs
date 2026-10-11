import { open, mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { verifyStableManifest, verifyStableArchive, sha256 } from '../../src/server/stable-manifest.mjs';
import { validateZipArchive, verifyReleaseFiles } from './release-validation.mjs';
import { machArchitecture } from './stable-runtime.mjs';

export async function verifySignedStable({ directory, repository, version, arch, trustedKeys, currentVersion, archiveName, beforeExtract, onVerified }) {
  if (archiveName !== undefined && archiveName !== 'package.zip') throw Error('Unsupported archive alias');
  async function bounded(name, limit) {
    const file = path.join(directory, name);
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) throw Error();
      const chunks = []; let count = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(65536, limit - count + 1)), { bytesRead } = await handle.read(chunk);
        if (!bytesRead) break;
        count += bytesRead; if (count > limit) throw Error();
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks);
    } catch { throw Error('Unsafe signed artifact'); }
    finally { await handle?.close(); }
  }
  const bytes = await bounded('guan-stable-manifest.json', 65536), signature = await bounded('guan-stable-manifest.sig', 64);
  const { manifest, selected } = verifyStableManifest(bytes, signature, { repository, releaseVersion: version, arch, platform: 'darwin', trustedKeys, currentVersion });
  const archive = await bounded(archiveName || selected.name, selected.size); verifyStableArchive(archive, selected);
  const zip = validateZipArchive(archive, { trustedRuntime: selected });
  if (zip.root !== selected.name.slice(0, -4)) throw Error('Stable root mismatch');
  if (beforeExtract) await beforeExtract({ manifest, selected, expandedBytes: zip.bytes });
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
    const result = { manifest, selected, files: checked.files, buildId: checked.buildId, signatureVerified: true, executed: false,
      startupProtocol: m.startupProtocol === 1 ? 1 : null,
      releaseSha256: sha256(await readFile(path.join(temporary, zip.root, 'RELEASE.json'))) };
    // Trusted installer callback only: use this verified snapshot, never reopen
    // replaceable downloaded bytes between verification and extraction/copy.
    if (onVerified) await onVerified(path.join(temporary, zip.root), result, { archive, bytes, signature });
    return result;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
