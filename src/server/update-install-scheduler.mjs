import { readPrivateFile } from './runtime-paths.mjs';
import { workbenchPageCensus } from './workbench-page-census.mjs';
import { sameWorkbenchRepository } from './workbench-identity.mjs';

// Lives in the independent manager, so it continues after the browser and old
// Web service exit. There is no URL, path, command or unauthorised task clearing.
// Every attempt needs a per-version operator grant AND durable/census checks.
export class UpdateInstallScheduler {
  constructor({ manager, authority, preferencesFile, census = workbenchPageCensus, intervalMs = 5000, restoreCurrent }) {
    if (!manager?.install || !authority?.read || typeof preferencesFile !== 'string' || !Number.isSafeInteger(intervalMs) || intervalMs < 100)
      throw Error('install_scheduler_invalid');
    Object.assign(this, { manager, authority, preferencesFile, census, intervalMs, restoreCurrent });
    this.timer = null; this.running = null; this.closed = false; this.state = { state: 'confirmation-required', error: null };
  }
  async enabled() {
    const raw = await readPrivateFile(this.preferencesFile, { maxBytes: 4096 });
    if (raw === null) return false;
    const value = JSON.parse(raw);
    if (!value || Object.keys(value).sort().join(',') !== 'autoCheck,autoDownload,autoInstall,network,repository,version'
      || value.version !== 1 || !sameWorkbenchRepository(value.repository, this.manager.repository)
      || ['autoCheck', 'autoDownload', 'autoInstall'].some(key => typeof value[key] !== 'boolean')
      || !['auto', 'direct', 'proxy'].includes(value.network))
      throw Error('update_storage_invalid');
    return value.autoInstall;
  }
  tick() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.step().catch(error => {
      this.state = { state: 'blocked', error: /^(?:install|update|service)_[a-z_]{1,70}$/.test(error?.message || '')
        ? error.message : 'install_evidence_unconfirmed' };
    }).finally(() => { this.running = null; });
    return this.running;
  }
  async step() {
    if (this.restoreCurrent) await this.restoreCurrent();
    if (!await this.enabled()) { this.state = { state: 'deferred', error: null }; return; }
    const grant = await this.authority.read();
    if (!grant || !['approved', 'claimed'].includes(grant.state)) {
      this.state = { state: 'confirmation-required', error: null }; return;
    }
    const census = await this.census();
    if (census?.workbenchPagesClosed !== true || !Array.isArray(census.blockers) || census.blockers.length) {
      this.state = { state: 'awaiting-browser-exit', error: null }; return;
    }
    if (this.closed || this.manager.busy) return;
    const bootstrap = await this.manager.readBootstrap(), journal = await this.manager.readJournal();
    if (grant.state === 'claimed') {
      if (bootstrap && !['activated', 'aborted'].includes(bootstrap.phase)) {
        this.state = { state: 'recovering', error: null };
        await (bootstrap.phase === 'committed' ? this.manager.reconcileBootstrap() : this.manager.recoverBootstrap()); return;
      }
      if (journal) {
        this.state = { state: 'recovering', error: null };
        await (['committed', 'rolled-back'].includes(journal.phase) ? this.manager.reconcileActivation() : this.manager.recover()); return;
      }
      // Freeze/claim may have happened even without a transaction journal.
      // Never clear or retry this ambiguous state automatically.
      throw Error('update_recovery_required');
    }
    this.state = { state: 'installing', error: null };
    if (grant.previous === null) await this.manager.bootstrap(grant.next);
    else await this.manager.install(grant.next);
    this.state = { state: 'committed', error: null };
  }
  start() {
    if (this.timer) return;
    this.closed = false; void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs); this.timer.unref();
  }
  async stop() { this.closed = true; clearInterval(this.timer); this.timer = null; await this.running; }
}
