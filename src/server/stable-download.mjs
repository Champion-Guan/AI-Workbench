import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { open, rename, unlink, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { privateDirectory, writePrivateFile } from './runtime-paths.mjs';
import { verifyStableManifest } from './stable-manifest.mjs';
import { STABLE_TRUSTED_KEYS } from './stable-trust.mjs';
import { readReleaseAsset } from './github-assets.mjs';
import { UpdateError } from './update-auth.mjs';

export class StableDownload {
  constructor({ directory, trustedKeys = STABLE_TRUSTED_KEYS, readAsset = readReleaseAsset, arch = process.arch, platform = process.platform, freeSpace } = {}) {
    this.directory = directory; this.keys = trustedKeys; this.readAsset = readAsset; this.arch = arch; this.platform = platform;
    this.freeSpace = freeSpace || (async () => { const s = await statfs(directory); return s.bavail * s.bsize; });
    this.state = { state: 'idle', progress: 0, error: null }; this.pending = null; this.controller = null;
  }
  status(repository) { return this.state.repository === repository ? { state: this.state.state, progress: this.state.progress, error: this.state.error, version: this.state.version } : { state: Object.keys(this.keys).length ? 'idle' : 'trust-not-configured', progress: 0, error: null }; }
  stageIdentity(repository) {
    if (this.state.state !== 'verified' || this.state.repository !== repository || !this.verified) throw new UpdateError('update_stage_unavailable');
    return { repository, version: this.verified.manifest.version, downloadId: path.basename(this.verified.directory) };
  }
  cancel() { this.controller?.abort(); }
  failure(repository, error) { if (!this.pending) this.state = { repository, state: 'error', progress: 0, error }; }
  download(options) {
    if (this.pending) {
      if (this.state.repository !== options.repository || this.state.version !== options.release?.version) throw new UpdateError('download_in_progress');
      return this.pending;
    }
    this.verified = null;
    this.controller = new AbortController();
    this.state = { repository: options.repository, version: options.release?.version, state: 'verifying-manifest', progress: 0, error: null };
    this.pending = this.run(options).catch(e => { this.state.state = 'error'; this.state.error = e instanceof UpdateError ? e.code : 'download_storage_failed'; })
      .finally(() => { this.pending = null; this.controller = null; });
    return this.pending;
  }
  async run({ repository, release, token, proxyUrl, currentVersion, downloadTimeoutMs = 10 * 60 * 1000 }) {
    if (!Number.isSafeInteger(downloadTimeoutMs) || downloadTimeoutMs < 1000 || downloadTimeoutMs > 10 * 60 * 1000) throw new UpdateError('asset_request_invalid');
    if (!Object.keys(this.keys).length) throw new UpdateError('signing_trust_not_configured');
    const signal = this.controller.signal;
    const asset = name => {
      const a = release.assets?.filter(x => x.name === name);
      if (a?.length !== 1 || !Number.isSafeInteger(a[0].id) || !Number.isSafeInteger(a[0].size) || a[0].size < 1) throw new UpdateError('release_assets_invalid');
      return a[0];
    };
    const timed = async (ms, operation) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, ms); timer.unref?.();
      try { return await operation(controller.signal); }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    };
    const read = (a, maxBytes) => timed(30000, downloadSignal => this.readAsset({ repository, asset: a, token, proxyUrl, maxBytes, signal: downloadSignal }));
    const bytes = await read(asset('guan-stable-manifest.json'), 65536);
    const signature = await read(asset('guan-stable-manifest.sig'), 64);
    const { manifest, selected } = verifyStableManifest(bytes, signature, { trustedKeys: this.keys, repository, releaseVersion: release.version, currentVersion, arch: this.arch, platform: this.platform });
    const packageAsset = asset(selected.name);
    if (packageAsset.size !== selected.size) throw new UpdateError('release_assets_invalid');
    await privateDirectory(this.directory);
    const space = await this.freeSpace();
    if (!Number.isFinite(space) || space < selected.size + 32 * 1024 * 1024) throw new UpdateError('disk_space_insufficient');
    const destination = path.join(this.directory, 'verified-' + randomUUID());
    await privateDirectory(destination);
    const part = path.join(destination, 'package.part'), final = path.join(destination, 'package.zip');
    let handle;
    try {
      handle = await open(part, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256'); let count = 0;
      this.state.state = 'downloading';
      const size = await timed(downloadTimeoutMs, downloadSignal => this.readAsset({ repository, asset: packageAsset, token, proxyUrl, maxBytes: selected.size,
        signal: downloadSignal,
        onChunk: async chunk => {
          signal.throwIfAborted(); count += chunk.length;
          if (count > selected.size) throw new UpdateError('package_integrity_failed');
          hash.update(chunk); await handle.writeFile(chunk); this.state.progress = Math.min(99, Math.floor(count * 100 / selected.size));
        } }));
      if (size !== selected.size || count !== selected.size || hash.digest('hex') !== selected.sha256) throw new UpdateError('package_integrity_failed');
      signal.throwIfAborted(); await handle.sync(); await handle.close(); handle = null;
      // Signed bytes, not an unsigned downloaded checksum, determine readiness.
      await writePrivateFile(path.join(destination, 'guan-stable-manifest.json'), bytes, { exclusive: true });
      await writePrivateFile(path.join(destination, 'guan-stable-manifest.sig'), signature, { exclusive: true });
      await rename(part, final);
      this.state.state = 'verified'; this.state.progress = 100;
      // No install permit or browser-visible filesystem path. Phase 5 must
      // reverify bytes and archive structure immediately before installation.
      this.verified = { directory: destination, manifest, selected };
    } finally { await handle?.close(); await unlink(part).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
}
