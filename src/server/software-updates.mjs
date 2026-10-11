import path from 'node:path';
import { readPrivateFile, writePrivateJson } from './runtime-paths.mjs';
import { compareVersions, parseVersion, validRepository } from './stable-version.mjs';
import { readGitHubStable } from './github-stable.mjs';
import { UpdateError } from './update-auth.mjs';

export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const defaults = () => ({ version: 1, repository: '', autoCheck: true, autoDownload: true, autoInstall: false, network: 'auto' });
export class SoftwareUpdates {
  constructor({ directory, auth, currentVersion, downloader = null, manager = null, proxyUrl = () => null, readRelease = readGitHubStable, now = Date.now }) {
    this.downloader = downloader;
    this.manager = manager; this.staging = null; this.stageResult = null;
    this.stopped = false;
    this.file = path.join(directory, 'preferences.json'); this.auth = auth; this.currentVersion = currentVersion;
    this.historyFile = path.join(directory, 'check-history.json');
    this.proxyUrl = proxyUrl; this.readRelease = readRelease; this.now = now; this.tail = Promise.resolve();
    this.result = { state: 'unconfigured', latest: null, lastCheckedAt: null, error: null, history: [] }; this.inFlight = null; this.timer = null;
  }
  serial(fn) { const next = this.tail.catch(() => {}).then(fn); this.tail = next; return next; }
  async history(repository) {
    try {
      const raw = await readPrivateFile(this.historyFile, { maxBytes: 32768 });
      if (raw === null) return [];
      const h = JSON.parse(raw);
      if (h.version !== 1 || !validRepository(h.repository) || !Array.isArray(h.entries) || h.entries.length > 30
        || Object.keys(h).some(k => !['version', 'repository', 'entries'].includes(k))
        || h.entries.some(e => !e || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at))
          || !['available', 'up-to-date', 'no-stable-release', 'error'].includes(e.state)
          || e.version !== null && !parseVersion(e.version)
          || e.error !== null && (typeof e.error !== 'string' || !/^[a-z_]{1,80}$/.test(e.error))
          || Object.keys(e).some(k => !['at', 'state', 'version', 'error'].includes(k)))) throw Error();
      return h.repository === repository ? h.entries : [];
    } catch { throw new UpdateError('update_history_invalid'); }
  }
  async preferences() {
    try {
      const raw = await readPrivateFile(this.file, { maxBytes: 4096 });
      if (raw === null) return defaults();
      const p = JSON.parse(raw);
      if (p.version !== 1 || p.repository !== '' && !validRepository(p.repository) || ['autoCheck', 'autoDownload', 'autoInstall'].some(k => typeof p[k] !== 'boolean')
        || p.autoInstall !== false || !['auto', 'direct', 'proxy'].includes(p.network) || Object.keys(p).some(k => !Object.hasOwn(defaults(), k))) throw Error();
      return p;
    } catch { throw new UpdateError('update_storage_invalid'); }
  }
  async status() {
    try {
      const p = await this.preferences(), meta = await this.auth.metadata(), history = await this.history(p.repository);
      const bound = Boolean(meta && meta.repository.toLowerCase() === p.repository.toLowerCase());
      // Never show a previously checked repository's release after external config change.
      const result = this.result.repository === p.repository ? this.result : { state: p.repository ? 'unchecked' : 'unconfigured', latest: null, lastCheckedAt: null, error: null, history: [] };
      const download = this.downloader?.status(p.repository) || { state: 'not-implemented', progress: 0 };
      const latest = result.latest ? { version: result.latest.version, publishedAt: result.latest.publishedAt, notes: result.latest.notes,
        verification: download.state === 'verified' && download.version === result.latest.version ? 'verified' : result.latest.verification } : null;
      return { ...result, latest, history, lastCheckedAt: result.lastCheckedAt || history.at(-1)?.at || null, currentVersion: this.currentVersion, preferences: p, channel: 'GitHub Private / Stable',
        authorization: bound ? 'configured-not-verified' : 'required', checking: Boolean(this.inFlight),
        hasNewVersion: Boolean(result.latest && compareVersions(result.latest.version, this.currentVersion) > 0),
        download, install: this.manager ? { ...(await this.manager.status()),
          staging: Boolean(this.staging), stageError: this.stageResult?.repository === p.repository ? this.stageResult.error : null }
          : { allowed: false, state: 'disabled' } };
    } catch (e) { return { ...this.result, latest: null, currentVersion: this.currentVersion, preferences: defaults(), channel: 'GitHub Private / Stable', authorization: 'unavailable', checking: false, hasNewVersion: false, error: e.code || 'update_storage_invalid', state: 'error', download: { state: 'not-implemented', progress: 0 }, install: { allowed: false, state: 'disabled' } }; }
  }
  configure(input) {
    return this.serial(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['repository', 'autoCheck', 'autoDownload', 'autoInstall', 'network'].includes(k))
        || input.repository !== undefined && input.repository !== '' && !validRepository(input.repository)
        || ['autoCheck', 'autoDownload', 'autoInstall'].some(k => input[k] !== undefined && typeof input[k] !== 'boolean')
        || input.autoInstall === true || input.network !== undefined && !['auto', 'direct', 'proxy'].includes(input.network)) throw new UpdateError('invalid_update_preferences');
      const old = await this.preferences(), next = { ...old, ...input, autoInstall: false };
      await this.history(old.repository); // Bad history is preserved, not silently reset.
      await writePrivateJson(this.file, next);
      if (next.repository !== old.repository) {
        this.downloader?.cancel();
        this.result = { repository: next.repository, state: 'unchecked', latest: null, lastCheckedAt: null, error: null, history: [] };
      }
      return this.status();
    });
  }
  check({ automatic = false } = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.serial(async () => {
      let p;
      try {
        p = await this.preferences();
        if (automatic && !p.autoCheck) return this.status();
        if (!p.repository) throw new UpdateError('repository_required');
        this.result.history = await this.history(p.repository);
        if (this.result.repository === p.repository && this.result.lastCheckedAt && this.now() - Date.parse(this.result.lastCheckedAt) < 60_000) return this.status();
        const token = await this.auth.token(p.repository);
        const proxy = p.network === 'direct' ? null : this.proxyUrl();
        if (p.network === 'proxy' && !proxy) throw new UpdateError('proxy_unavailable');
        const latest = await this.readRelease({ repository: p.repository, token, proxyUrl: proxy, signal: AbortSignal.timeout(30000) });
        this.result = { ...this.result, repository: p.repository, latest,
          state: latest && compareVersions(latest.version, this.currentVersion) > 0 ? 'available' : latest ? 'up-to-date' : 'no-stable-release', error: null };
      } catch (e) {
        this.result = { ...this.result, repository: p?.repository || '', state: 'error', error: e instanceof UpdateError ? e.code : 'update_check_failed' };
      }
      const time = new Date(this.now()).toISOString();
      this.result.lastCheckedAt = time;
      this.result.history = [...this.result.history, { at: time, state: this.result.state, version: this.result.latest?.version || null, error: this.result.error }].slice(-30);
      if (p?.repository) {
        try {
          await this.history(p.repository);
          await writePrivateJson(this.historyFile, { version: 1, repository: p.repository, entries: this.result.history });
        } catch { this.result.error = 'update_history_invalid'; this.result.state = 'error'; }
      }
      if (!this.stopped && p?.autoDownload && this.result.state === 'available') void this.beginDownload(p).catch(e => {
        if (this.result.repository === p.repository) this.downloader?.failure(p.repository, e instanceof UpdateError ? e.code : 'asset_download_failed');
      });
      return this.status().then(status => ({ ...status, checking: false }));
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async beginDownload(p) {
    if (this.stopped) throw new UpdateError('update_service_stopped');
    if (!this.downloader) throw new UpdateError('download_unavailable');
    const release = this.result.latest;
    const current = await this.preferences();
    if (current.repository !== p.repository || this.result.repository !== p.repository || this.result.state !== 'available') throw new UpdateError('release_not_available');
    const cached = this.downloader.status(p.repository);
    if (cached.state === 'verified' && cached.version === this.result.latest.version) return;
    const token = await this.auth.token(p.repository);
    const proxy = current.network === 'direct' ? null : this.proxyUrl();
    if (current.network === 'proxy' && !proxy) throw new UpdateError('proxy_unavailable');
    if (this.stopped || (await this.preferences()).repository !== p.repository || this.result.repository !== p.repository || this.result.latest !== release) throw new UpdateError('release_not_available');
    void this.downloader.download({ repository: p.repository, release, token, proxyUrl: proxy, currentVersion: this.currentVersion });
  }
  async download() {
    // Start only: HTTP never waits for a potentially large package or accepts URLs.
    const p = await this.preferences();
    if (!this.downloader || this.result.repository !== p.repository || this.result.state !== 'available') throw new UpdateError('release_not_available');
    await this.beginDownload(p);
    return this.status();
  }
  async stage() {
    if (this.stopped || !this.manager || !this.downloader?.stageIdentity) throw new UpdateError('update_stage_unavailable');
    if (this.staging) return this.status();
    const p = await this.preferences(), identity = this.downloader.stageIdentity(p.repository);
    // Concurrent iframe requests can both pass the first check before the
    // preferences read resolves. Recheck immediately before acquiring the job.
    if (this.stopped) throw new UpdateError('update_stage_unavailable');
    if (this.staging) return this.status();
    // No caller-supplied identity is accepted. The downloader is the only
    // source, and the independent manager verifies all bytes again.
    if (compareVersions(identity.version, this.currentVersion) <= 0) throw new UpdateError('version_not_newer');
    this.stageResult = { repository: p.repository, error: null };
    this.staging = this.manager.stage(identity).catch(e => {
      this.stageResult = { repository: p.repository, error: e instanceof UpdateError ? e.code : 'update_stage_failed' };
    }).finally(() => { this.staging = null; });
    return this.status();
  }
  start({ setIntervalFn = setInterval } = {}) {
    if (this.timer) return;
    this.stopped = false;
    void this.check({ automatic: true });
    this.timer = setIntervalFn(() => { void this.check({ automatic: true }); }, UPDATE_INTERVAL_MS);
    this.timer.unref?.();
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; this.downloader?.cancel(); }
}
