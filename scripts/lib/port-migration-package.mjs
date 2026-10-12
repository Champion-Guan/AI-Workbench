import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { readPrivateFile } from '../../src/server/runtime-paths.mjs';
import { readGitHubStable } from '../../src/server/github-stable.mjs';
import { StableDownload } from '../../src/server/stable-download.mjs';
import { compareVersions } from '../../src/server/stable-version.mjs';
import { STABLE_REPOSITORY } from '../../src/server/workbench-identity.mjs';
import { verifySignedStable } from './signed-stable.mjs';

// A double-click needs no pre-downloaded release assets. Public downloads never
// use the owner's GitHub token. Recheck the signed archive before browser writes.
export async function migrationPackage({ directory, updates, currentVersion,
  readRelease = readGitHubStable, Downloader = StableDownload, verify = verifySignedStable } = {}) {
  let version, archiveName;
  if (directory) {
    const manifest = JSON.parse(await readPrivateFile(path.join(directory, 'guan-stable-manifest.json'), { maxBytes: 65536 }));
    version = manifest.version;
    try { await lstat(path.join(directory, 'package.zip')); archiveName = 'package.zip'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    const release = await readRelease({ repository: STABLE_REPOSITORY, signal: AbortSignal.timeout(30000) });
    if (!release) throw Error('migration_release_missing');
    version = release.version;
    if (compareVersions(version, '1.0.8') < 0 || compareVersions(version, currentVersion) <= 0) throw Error('migration_version_invalid');
    const downloader = new Downloader({ directory: path.join(updates, 'port-migration-packages') });
    await downloader.download({ repository: STABLE_REPOSITORY, release, currentVersion });
    if (downloader.status(STABLE_REPOSITORY).state !== 'verified' || !downloader.verified) throw Error('migration_download_failed');
    directory = downloader.verified.directory; archiveName = 'package.zip';
  }
  if (compareVersions(version, '1.0.8') < 0 || compareVersions(version, currentVersion) <= 0) throw Error('migration_version_invalid');
  const checked = await verify({ directory, repository: STABLE_REPOSITORY, version, currentVersion, arch: 'arm64', archiveName });
  if (checked.startupProtocol !== 1) throw Error('migration_startup_unsupported');
  return { directory, version };
}
