import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetch } from 'undici';
import { validRepository } from '../src/server/stable-version.mjs';
import { verifySignedStable } from './lib/signed-stable.mjs';
import { sha256, verifyStableArchive, verifyStableManifest } from '../src/server/stable-manifest.mjs';
import { verifyStableOwnerEnvironment } from './lib/stable-owner-approval.mjs';
import { stableReleaseNotes } from './lib/stable-release-notes.mjs';

async function main() {
  const approval = await verifyStableOwnerEnvironment();
  const [repository, directory] = process.argv.slice(2), token = process.env.GUAN_RELEASE_TOKEN;
  delete process.env.GUAN_RELEASE_TOKEN;
  if (process.argv.length !== 4 || !validRepository(repository) || repository !== approval.repository
    || process.env.GUAN_RELEASE_COMMIT !== approval.commit || !path.isAbsolute(directory) || !token
    || process.env.GUAN_CONFIRM_RELEASE !== 'RELEASE-STABLE') throw Error('Owner manual release authorization required');
  const root = fileURLToPath(new URL('../', import.meta.url)), version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  if (approval.tag !== 'v' + version) throw Error('Approved tag/version mismatch');
  const checked = await verifySignedStable({ directory, repository, version, arch: 'arm64' });
  await verifySignedStable({ directory, repository, version, arch: 'x64' });
  if (checked.manifest.commit !== process.env.GUAN_RELEASE_COMMIT) throw Error('Unexpected release commit');
  const request = async (url, method, body, contentType = 'application/json') => {
    const response = await fetch(url, { method, body: Buffer.isBuffer(body) ? body : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': contentType,
        'x-github-api-version': '2022-11-28', 'user-agent': 'GuanAIWorkbench-StablePublisher' } });
    if (!response.ok) { await response.body?.cancel(); throw Error('Publish API failed'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw Error('Publish response oversized'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const api = `https://api.github.com/repos/${repository}/releases`;
  const verifyRemoteTag = async () => {
    let object = (await request(`https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent('v' + version)}`, 'GET')).object;
    for (let depth = 0; depth < 5; depth++) {
      if (!object || !/^[a-f0-9]{40}$/.test(object.sha)) throw Error('Invalid remote tag');
      if (object.type === 'commit') {
        if (object.sha !== checked.manifest.commit) throw Error('Remote tag moved');
        return;
      }
      if (object.type !== 'tag') throw Error('Unexpected tag target');
      object = (await request(`https://api.github.com/repos/${repository}/git/tags/${object.sha}`, 'GET')).object;
    }
    throw Error('Tag nesting limit');
  };
  await verifyRemoteTag();
  const notes = await request(api + '/generate-notes', 'POST', { tag_name: 'v' + version, target_commitish: checked.manifest.commit });
  if (typeof notes.body !== 'string' || notes.body.includes(token)) throw Error('Unsafe release notes');
  const approvedNotes = stableReleaseNotes(await readFile(path.join(root, 'docs/RELEASE-NOTES.md'), 'utf8'), version);
  if (approvedNotes.includes(token)) throw Error('Unsafe release notes');
  const release = await request(api, 'POST', { tag_name: 'v' + version, target_commitish: checked.manifest.commit,
    name: 'Guan AI Workbench ' + version, body: approvedNotes + '\n\n---\n\n' + notes.body, draft: true, prerelease: false });
  if (!Number.isSafeInteger(release.id) || release.id < 1 || release.draft !== true) throw Error('Invalid draft identity');
  const assets = [...checked.manifest.packages.map(p => p.name), 'guan-stable-manifest.json', 'guan-stable-manifest.sig', 'SHA256SUMS.txt'];
  for (const name of assets) {
    const file = path.join(directory, name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024) throw Error('Unsafe upload input');
    const bytes = await readFile(file);
    const descriptor = checked.manifest.packages.find(p => p.name === name);
    if (descriptor) verifyStableArchive(bytes, descriptor);
    else if (name === 'guan-stable-manifest.json' && !bytes.equals(Buffer.from(JSON.stringify(checked.manifest, null, 2) + '\n'))) throw Error('Signed manifest changed');
    else if (name === 'guan-stable-manifest.sig') verifyStableManifest(Buffer.from(JSON.stringify(checked.manifest, null, 2) + '\n'), bytes,
      { repository, releaseVersion: version, arch: 'arm64', platform: 'darwin' });
    else if (name === 'SHA256SUMS.txt' && bytes.toString('utf8') !== checked.manifest.packages.map(p => `${p.sha256}  ${p.name}\n`).join('')) throw Error('Checksum file changed');
    const asset = await request(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, 'POST', bytes, 'application/octet-stream');
    if (asset.name !== name || asset.state !== 'uploaded' || asset.size !== bytes.length
      || asset.digest !== 'sha256:' + sha256(bytes)) throw Error('Uploaded asset integrity not confirmed; draft retained');
  }
  // Failed upload leaves a non-installable Draft, never a partial Stable release.
  await verifyRemoteTag();
  const published = await request(api + '/' + release.id, 'PATCH', { draft: false, prerelease: false, make_latest: 'true' });
  if (published.draft !== false || published.prerelease !== false || published.tag_name !== 'v' + version) throw Error('Publication not confirmed');
  console.log(JSON.stringify({ ok: true, version, releaseId: release.id, assets: assets.length }));
}
main().catch(() => { console.error('Stable publication failed safely; any incomplete release remains a Draft. Inspect GitHub before retrying; no credentials are logged.'); process.exitCode = 1; });
