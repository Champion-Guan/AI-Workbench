import { fetch, ProxyAgent } from 'undici';
import { validRepository } from './stable-version.mjs';
import { UpdateError } from './update-auth.mjs';
import { isPublicUpdateRepository } from './workbench-identity.mjs';

const assetHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export async function readReleaseAsset({ repository, asset, token, maxBytes, signal, proxyUrl, onChunk, fetchImpl = fetch }) {
  if (!validRepository(repository) || !Number.isSafeInteger(asset?.id) || asset.id < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !(isPublicUpdateRepository(repository) && !token) && !/^[A-Za-z0-9_]{20,255}$/.test(token || '')) throw new UpdateError('asset_request_invalid');
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  let url = `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`;
  try {
    for (let hop = 0; hop < 4; hop++) {
      // Authorization is ONLY attached to the original pinned API request.
      const response = await fetchImpl(url, { redirect: 'manual', signal, headers: { accept: 'application/octet-stream',
        'user-agent': 'GuanAIWorkbench-StableUpdater', ...(hop === 0 ? { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-github-api-version': '2022-11-28' } : {}) }, ...(dispatcher ? { dispatcher } : {}) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel().catch(() => {});
        let target; try { target = new URL(location, url); } catch { throw new UpdateError('asset_redirect_rejected'); }
        if (!location || target.protocol !== 'https:' || !assetHosts.has(target.hostname) || target.port || target.username || target.password || target.hash
          || token && target.href.includes(token)) throw new UpdateError('asset_redirect_rejected');
        url = target.href; continue;
      }
      if (!response.ok || response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new UpdateError(response.status === 401 ? 'authorization_expired' : response.status === 403 || response.status === 429 ? 'asset_access_denied' : 'asset_download_failed');
      }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel().catch(() => {}); throw new UpdateError('asset_size_invalid'); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new UpdateError('asset_size_invalid');
        if (onChunk) await onChunk(chunk, size); else chunks.push(chunk);
      }
      return onChunk ? size : Buffer.concat(chunks);
    }
    throw new UpdateError('asset_redirect_rejected');
  } catch (e) { throw e instanceof UpdateError ? e : new UpdateError('asset_download_failed'); }
  finally { await dispatcher?.destroy().catch(() => {}); }
}
