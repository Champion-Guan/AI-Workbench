import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePaths, writePrivateFile } from '../src/server/runtime-paths.mjs';
import { MacKeychainVault } from '../src/server/keychain-vault.mjs';
import { UpdateAuth } from '../src/server/update-auth.mjs';
import { readGitHubStable } from '../src/server/github-stable.mjs';
import { StableDownload } from '../src/server/stable-download.mjs';
import { verifySignedStable } from './lib/signed-stable.mjs';

try {
  const [version, commit] = process.argv.slice(2);
  if (process.argv.length !== 4 || !/^\d+\.\d+\.\d+$/.test(version || '') || !/^[a-f0-9]{40}$/.test(commit || '')) throw Error();
  const repository = 'Champion-Guan/infinite-canvas', proxyUrl = 'http://127.0.0.1:7890';
  const root = fileURLToPath(new URL('../', import.meta.url)), p = runtimePaths({ projectRoot: root });
  const auth = new UpdateAuth({ directory: p.updates, vault: new MacKeychainVault({ executable: path.join(p.runtime, 'guan-keychain') }) });
  const token = await auth.token(repository), release = await readGitHubStable({ repository, token, proxyUrl });
  if (release?.version !== version) throw Error();
  const download = new StableDownload({ directory: path.join(p.updates, 'packages') });
  await download.download({ repository, release, token, proxyUrl, currentVersion: '1.0.4' });
  if (download.status(repository).state !== 'verified') throw Error();
  const id = download.stageIdentity(repository).downloadId, directory = path.join(p.updates, 'packages', id);
  const verified = await verifySignedStable({ directory, repository, version, arch: 'arm64', archiveName: 'package.zip' });
  if (verified.manifest.commit !== commit || verified.startupProtocol !== 1) throw Error();
  const report = { ok: true, version, commit, releaseId: release.releaseId, downloadId: id,
    signatureVerified: verified.signatureVerified, files: verified.files, startupProtocol: verified.startupProtocol,
    packageSha256: verified.selected.sha256, executed: false, installed: false, tokenExposed: false };
  await writePrivateFile(path.join(p.updates, 'local-release-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch {
  console.error('Private Stable verification stopped safely; no credentials logged and production not restarted.');
  process.exitCode = 1;
}
