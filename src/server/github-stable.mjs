import { fetch, ProxyAgent } from 'undici';
import { compareVersions, parseVersion, validRepository } from './stable-version.mjs';
import { UpdateError } from './update-auth.mjs';

export const STABLE_ASSETS = ['guan-stable-manifest.json', 'guan-stable-manifest.sig'];
// This marker identifies the channel, NOT trust. Phase 4 must verify the
// Ed25519 signature before downloading/installing a package.
export function selectStableRelease(releases, token = '') {
  if (!Array.isArray(releases)) throw new UpdateError('invalid_release_response');
  let latest = null;
  const safe = value => String(value || '').split(token || '\0').join(token ? '[redacted]' : '\0').slice(0, 32768);
  for (const r of releases) {
    const v = parseVersion(r?.tag_name);
    if (!v || v.pre.length || token && r.tag_name.includes(token) || r.draft !== false || r.prerelease !== false || !Number.isSafeInteger(r.id) || r.id <= 0
      || !Array.isArray(r.assets) || !STABLE_ASSETS.every(name => r.assets.filter(a => a?.name === name && a.state === 'uploaded' && a.size > 0).length === 1)
      || !r.published_at || !Number.isFinite(Date.parse(r.published_at))) continue;
    if (!latest || compareVersions(v.version, latest.version) > 0) latest = {
      version: v.version, publishedAt: new Date(r.published_at).toISOString(), notes: safe(r.body), releaseId: r.id,
      verification: 'not-verified',
      assets: r.assets.filter(a => a?.state === 'uploaded' && typeof a.name === 'string' && /^[A-Za-z0-9_.+-]{1,160}$/.test(a.name)
        && (!token || !a.name.includes(token)) && Number.isSafeInteger(a.id) && a.id > 0 && Number.isSafeInteger(a.size) && a.size > 0)
        .map(({ name, id, size }) => ({ name, id, size })),
    };
  }
  return latest;
}
async function boundedJson(response) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new UpdateError('release_response_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new UpdateError('invalid_release_response'); }
}
export async function readGitHubStable({ repository, token, proxyUrl, signal, fetchImpl = fetch }) {
  if (!validRepository(repository)) throw new UpdateError('repository_required');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new UpdateError('authorization_required');
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  let latest = null;
  try {
    for (let page = 1; page <= 10; page++) {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
        method: 'GET', redirect: 'error', signal,
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'GuanAIWorkbench-StableUpdater' },
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401) throw new UpdateError('authorization_expired');
        if (response.status === 403 || response.status === 429) throw new UpdateError(response.headers.get('x-ratelimit-remaining') === '0' || response.status === 429 || response.headers.has('retry-after') ? 'rate_limited' : 'authorization_denied');
        if (response.status === 404) throw new UpdateError('repository_unavailable');
        throw new UpdateError('github_unavailable');
      }
      const rows = await boundedJson(response);
      if (!Array.isArray(rows) || rows.length > 100) throw new UpdateError('invalid_release_response');
      const found = selectStableRelease(rows, token);
      if (found && (!latest || compareVersions(found.version, latest.version) > 0)) latest = found;
      if (rows.length < 100) return latest;
    }
    throw new UpdateError('release_inventory_limit'); // Never claim complete after truncated pagination.
  } catch (error) { throw error instanceof UpdateError ? error : new UpdateError('github_network_failed'); }
  finally { await dispatcher?.destroy().catch(() => {}); }
}
