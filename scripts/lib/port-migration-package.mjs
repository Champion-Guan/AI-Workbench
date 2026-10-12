import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { readPrivateFile } from '../../src/server/runtime-paths.mjs';
import { readGitHubStable } from '../../src/server/github-stable.mjs';
import { StableDownload } from '../../src/server/stable-download.mjs';
import { compareVersions } from '../../src/server/stable-version.mjs';
import { STABLE_REPOSITORY } from '../../src/server/workbench-identity.mjs';
import { verifySignedStable } from './signed-stable.mjs';
import { UpdateError } from '../../src/server/update-auth.mjs';

// A double-click needs no pre-downloaded release assets. Public downloads never
// use the owner's GitHub token. Recheck the signed archive before browser writes.
export async function migrationPackage({ directory, updates, currentVersion,
  readRelease = readGitHubStable, Downloader = StableDownload, verify = verifySignedStable,
  networks = [undefined], onProgress = () => {} } = {}) {
  let version, archiveName;
  if (directory) {
    const manifest = JSON.parse(await readPrivateFile(path.join(directory, 'guan-stable-manifest.json'), { maxBytes: 65536 }));
    version = manifest.version;
    try { await lstat(path.join(directory, 'package.zip')); archiveName = 'package.zip'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    let downloaded = false, lastError;
    for (const proxyUrl of networks) {
    onProgress({ phase: 'checking-release', network: proxyUrl ? 'proxy' : 'direct' });
    try {
    const release = await readRelease({ repository: STABLE_REPOSITORY, proxyUrl, signal: AbortSignal.timeout(30000) });
    if (!release) throw Error('migration_release_missing');
    version = release.version;
    if (compareVersions(version, '1.0.8') < 0 || compareVersions(version, currentVersion) <= 0) throw Error('migration_version_invalid');
    const downloader = new Downloader({ directory: path.join(updates, 'port-migration-packages') });
    const timer = setInterval(() => onProgress({ ...downloader.status(STABLE_REPOSITORY), network: proxyUrl ? 'proxy' : 'direct' }), 1500);
    try { await downloader.download({ repository: STABLE_REPOSITORY, release, currentVersion, proxyUrl,
      downloadTimeoutMs: proxyUrl ? 10 * 60 * 1000 : 2 * 60 * 1000 }); }
    finally { clearInterval(timer); }
    if (downloader.status(STABLE_REPOSITORY).state !== 'verified' || !downloader.verified)
      throw new UpdateError(downloader.status(STABLE_REPOSITORY).error || 'migration_download_failed');
    directory = downloader.verified.directory; archiveName = 'package.zip';
    downloaded = true; break;
    } catch (error) {
      lastError = error;
      // Retry only connectivity failures, never damaged or untrusted packages.
      if (!['github_network_failed', 'github_unavailable', 'asset_download_failed', 'asset_download_timeout', 'migration_download_failed'].includes(error.code || error.message)) throw error;
      onProgress({ phase: 'network-failed', error: error.code || error.message });
    }
    }
    if (!downloaded) throw lastError || Error('migration_download_failed');
  }
  if (compareVersions(version, '1.0.8') < 0 || compareVersions(version, currentVersion) <= 0) throw Error('migration_version_invalid');
  const checked = await verify({ directory, repository: STABLE_REPOSITORY, version, currentVersion, arch: 'arm64', archiveName });
  if (checked.startupProtocol !== 1) throw Error('migration_startup_unsupported');
  return { directory, version };
}
