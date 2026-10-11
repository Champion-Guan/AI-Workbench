import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, unlink, cp, chmod, readdir, statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { privateDirectory, readPrivateFile, writePrivateFile } from './runtime-paths.mjs';
import { parseVersion, compareVersions, validRepository } from './stable-version.mjs';
import { sha256 } from './stable-manifest.mjs';
import { verifySignedStable } from '../../scripts/lib/signed-stable.mjs';
import { verifyReleaseFiles } from '../../scripts/lib/release-validation.mjs';

const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
function identity(v) {
  if (!exact(v, ['id', 'version', 'commit', 'buildId']) || !parseVersion(v.version) || parseVersion(v.version).pre.length
    || !/^[a-f0-9]{40}$/.test(v.commit) || !/^[a-f0-9]{24}$/.test(v.buildId)
    || typeof v.id !== 'string' || !/^[0-9A-Za-z.+-]{1,160}$/.test(v.id)
    || !v.id.startsWith(v.version + '-' + v.commit.slice(0, 12) + '-')) throw Error('update_identity_invalid');
  return v;
}
async function durableDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableTree(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name), info = await lstat(file);
    if (info.isSymbolicLink()) throw Error('update_path_invalid');
    if (info.isDirectory()) await durableTree(file);
    else if (info.isFile()) {
      const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await h.sync(); } finally { await h.close(); }
    } else throw Error('update_path_invalid');
  }
  await durableDirectory(directory);
}

// Independent installer core. No shell/URL/path supplied by a browser, no
// business-data migration, no default-config writes and no automatic pruning.
// A trusted coordinator and exact-owned-service adapter are mandatory to install.
export class UpdateManager {
  constructor({ root, dataRoot, projectRoot, repository, trustedKeys, coordinator, service,
    platform = process.platform, arch = process.arch, freeSpace, onStep = async () => {}, origin = 'http://127.0.0.1:5174' }) {
    if (!path.isAbsolute(root || '') || !path.isAbsolute(dataRoot || '') || !validRepository(repository)
      || platform !== 'darwin' || arch !== 'arm64') throw Error('update_platform_invalid');
    this.root = path.resolve(root); this.dataRoot = path.resolve(dataRoot); this.repository = repository;
    if (this.root === path.parse(this.root).root || this.root === homedir()
      || inside(this.root, this.dataRoot) || inside(this.dataRoot, this.root)
      || projectRoot && (inside(path.resolve(projectRoot), this.root) || inside(this.root, path.resolve(projectRoot)))) throw Error('update_path_invalid');
    this.keys = trustedKeys; this.coordinator = coordinator; this.service = service; this.onStep = onStep;
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== origin
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('update_origin_invalid');
    // Trusted constructor override is exclusively for isolated integration tests.
    // The daemon never accepts an origin from IPC or an HTTP request.
    this.origin = origin;
    this.freeSpace = freeSpace || (async () => { const s = await statfs(this.root); return s.bavail * s.bsize; });
    this.state = { state: 'idle', error: null }; this.busy = false;
  }
  status() { return { ...this.state, installAllowed: false }; }
  async initialize() {
    await privateDirectory(this.root);
    // Reject symlink ancestors, wrong owner or group/world-writable storage.
    if (await realpath(this.root) !== this.root) throw Error('update_path_invalid');
    const info = await lstat(this.root);
    if (info.uid !== process.getuid() || info.mode & 0o077) throw Error('update_path_invalid');
    for (const name of ['versions', 'records']) await privateDirectory(path.join(this.root, name));
  }
  async locked(operation) {
    if (this.busy) throw Error('update_in_progress');
    this.busy = true;
    let handle;
    const file = path.join(this.root, 'manager.lock');
    try {
      await this.initialize();
      try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const info = await lstat(file), old = JSON.parse(await readPrivateFile(file, { maxBytes: 1024 }));
        if (!info.isFile() || info.isSymbolicLink() || !exact(old, ['pid', 'nonce']) || !Number.isSafeInteger(old.pid) || old.pid < 1 || typeof old.nonce !== 'string') throw Error('update_lock_invalid');
        try { process.kill(old.pid, 0); throw Error('update_in_progress'); }
        catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
        const now = await lstat(file);
        if (now.ino !== info.ino || now.dev !== info.dev) throw Error('update_in_progress');
        await unlink(file);
        handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      }
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() })); await handle.sync();
      return await operation();
    } finally {
      if (handle) { await handle.close(); await unlink(file); await durableDirectory(this.root); }
      this.busy = false;
    }
  }
  async readCurrent() {
    const raw = await readPrivateFile(path.join(this.root, 'current.json'), { maxBytes: 2048 });
    return raw === null ? null : identity(JSON.parse(raw));
  }
  async readJournal() {
    const raw = await readPrivateFile(path.join(this.root, 'transaction.json'), { maxBytes: 8192 });
    if (raw === null) return null;
    const j = JSON.parse(raw);
    if (!exact(j, ['format', 'phase', 'previous', 'next']) || j.format !== 1
      || !['prepared', 'stopping', 'switching', 'starting', 'committed', 'rolling-back', 'rolled-back'].includes(j.phase)) throw Error('update_journal_invalid');
    identity(j.previous); identity(j.next);
    if (compareVersions(j.next.version, j.previous.version) <= 0 || j.previous.id === j.next.id) throw Error('update_journal_invalid');
    return j;
  }
  async journal(j, phase) {
    j.phase = phase;
    await writePrivateFile(path.join(this.root, 'transaction.json'), JSON.stringify(j));
    this.state = { state: phase, version: j.next.version, error: null };
    await this.onStep(phase);
  }
  async verifyInstalled(pointer) {
    identity(pointer);
    const record = path.join(this.root, 'records', pointer.id), directory = path.join(this.root, 'versions', pointer.id);
    for (const dir of [record, directory]) {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) throw Error('update_path_invalid');
    }
    const checked = await verifySignedStable({ directory: record, repository: this.repository, version: pointer.version, arch: 'arm64', trustedKeys: this.keys });
    const expected = `${checked.manifest.version}-${checked.manifest.commit.slice(0, 12)}-${checked.selected.sha256.slice(0, 12)}`;
    const releaseBytes = await readPrivateFile(path.join(directory, 'RELEASE.json'), { maxBytes: 32 * 1024 * 1024 });
    if (pointer.id !== expected || pointer.commit !== checked.manifest.commit || pointer.buildId !== checked.buildId
      || releaseBytes === null || sha256(Buffer.from(releaseBytes)) !== checked.releaseSha256) throw Error('update_identity_invalid');
    const installed = await verifyReleaseFiles(directory, { trustedRuntime: checked.selected });
    if (installed.buildId !== pointer.buildId) throw Error('update_identity_invalid');
    return { ...checked, directory };
  }
  async stage({ directory, version, archiveName = 'package.zip' }) {
    return this.locked(async () => {
      if (this.recoveryLease) throw Error('update_recovery_required');
      const journal = await this.readJournal();
      if (journal && !['committed', 'rolled-back'].includes(journal.phase)) throw Error('update_recovery_required');
      const current = await this.readCurrent();
      if (current) await this.verifyInstalled(current);
      let pointer;
      await verifySignedStable({ directory, repository: this.repository, version, arch: 'arm64', trustedKeys: this.keys,
        currentVersion: current?.version, archiveName,
        beforeExtract: async ({ selected, expandedBytes }) => {
          const available = await this.freeSpace(), temporary = await statfs(tmpdir());
          if (!Number.isFinite(available) || available < expandedBytes + selected.size + 64 * 1024 * 1024
            || temporary.bavail * temporary.bsize < expandedBytes + selected.size + 64 * 1024 * 1024) throw Error('disk_space_insufficient');
        },
        onVerified: async (verifiedRoot, checked, artifacts) => {
          pointer = { id: `${version}-${checked.manifest.commit.slice(0, 12)}-${checked.selected.sha256.slice(0, 12)}`,
            version, commit: checked.manifest.commit, buildId: checked.buildId };
          const destination = path.join(this.root, 'versions', pointer.id), record = path.join(this.root, 'records', pointer.id);
          // Never merge/overwrite an interrupted or existing version. Retain it
          // for inspection; explicit recovery/cleanup is a separate operation.
          await mkdir(destination, { mode: 0o700 }); await mkdir(record, { mode: 0o700 });
          for (const name of await readdir(verifiedRoot))
            await cp(path.join(verifiedRoot, name), path.join(destination, name), { recursive: true, force: false, errorOnExist: true });
          for (const [name, bytes] of [[checked.selected.name, artifacts.archive], ['guan-stable-manifest.json', artifacts.bytes], ['guan-stable-manifest.sig', artifacts.signature]])
            if (!await writePrivateFile(path.join(record, name), bytes, { exclusive: true })) throw Error('update_record_exists');
          await chmod(path.join(destination, 'runtime/node'), 0o700);
          await chmod(path.join(destination, 'bin/guan-keychain'), 0o700);
          await this.verifyInstalled(pointer);
          await durableTree(destination); await durableTree(record);
          await durableDirectory(path.join(this.root, 'versions')); await durableDirectory(path.join(this.root, 'records'));
        } });
      this.state = { state: 'staged', version, error: null };
      return pointer;
    });
  }
  async stop(j) {
    await this.service.stop({ allowed: [j.previous, j.next] });
    if (await this.service.isStopped() !== true) throw Error('service_not_stopped');
  }
  async healthy(pointer) {
    const report = await this.service.start({ ...pointer, directory: path.join(this.root, 'versions', pointer.id), dataRoot: this.dataRoot,
      origin: this.origin });
    if (!report || report.ready !== true || report.version !== pointer.version || report.buildId !== pointer.buildId
      || report.origin !== this.origin) throw Error('update_health_failed');
  }
  async rollback(j, lease) {
    await this.verifyInstalled(j.previous);
    await this.journal(j, 'rolling-back');
    await this.stop(j);
    await writePrivateFile(path.join(this.root, 'current.json'), JSON.stringify(j.previous));
    await this.healthy(j.previous);
    await this.journal(j, 'rolled-back');
    if (lease) await lease.assertValid();
    if (this.service.activate) await this.service.activate(j.previous);
  }
  async install(next) {
    // Do not retain a caller's mutable object across verification/await points.
    next = Object.freeze({ ...identity(next) });
    return this.locked(async () => {
      if (this.recoveryLease) throw Error('update_recovery_required');
      const unfinished = await this.readJournal();
      if (unfinished && !['committed', 'rolled-back'].includes(unfinished.phase)) throw Error('update_recovery_required');
      const previous = await this.readCurrent();
      if (!previous) throw Error('update_bootstrap_required');
      const previousChecked = await this.verifyInstalled(previous), nextChecked = await this.verifyInstalled(next);
      if (this.service?.requiredStartupProtocol === 1 && (previousChecked.startupProtocol !== 1 || nextChecked.startupProtocol !== 1))
        throw Error('service_startup_protocol_incompatible');
      if (compareVersions(next.version, previous.version) <= 0) throw Error('version_not_newer');
      if (!this.coordinator?.acquire || !this.service) throw Error('install_coordination_unavailable');
      const lease = await this.coordinator.acquire({ previous, next });
      if (!lease || typeof lease.assertValid !== 'function' || typeof lease.release !== 'function') throw Error('install_permit_invalid');
      const j = { format: 1, phase: 'prepared', previous, next };
      let begun = false, releaseSafe = true;
      try {
        // assertValid must prove authoritative inventory, epoch, paused roots,
        // completed persistence and backend freeze, not browser self-report.
        await lease.assertValid(); await this.journal(j, 'prepared');
        await lease.assertValid(); await this.journal(j, 'stopping'); begun = true;
        await this.stop(j); await lease.assertValid();
        await this.journal(j, 'switching');
        await writePrivateFile(path.join(this.root, 'current.json'), JSON.stringify(next));
        await this.journal(j, 'starting'); await this.healthy(next);
        await lease.assertValid();
        await this.journal(j, 'committed');
        await lease.assertValid();
        if (this.service.activate) await this.service.activate(next);
        return { state: 'committed', version: next.version };
      } catch {
        if (j.phase === 'committed') {
          // Activation can have succeeded even when its acknowledgement was
          // lost. Never downgrade a committed version that may accept work.
          releaseSafe = false; this.recoveryLease = lease;
          this.state = { state: 'activation-required', error: 'update_activation_unconfirmed' };
          throw Error('update_activation_unconfirmed');
        }
        if (begun) {
          try { await this.rollback(j, lease); }
          catch {
            releaseSafe = false; this.recoveryLease = lease;
            this.state = { state: 'recovery-required', error: 'update_rollback_failed' }; throw Error('update_rollback_failed');
          }
        }
        this.state = { state: begun ? 'rolled-back' : 'blocked', error: begun ? 'update_failed_rolled_back' : 'install_permit_invalid' };
        throw Error(this.state.error);
      } finally { if (releaseSafe) await lease.release(); }
    });
  }
  async recover() {
    return this.locked(async () => {
      const j = await this.readJournal();
      if (!j) return { state: 'no-recovery-needed' };
      // A durable terminal pointer does not prove activation acknowledged or
      // inventory survived a manager restart. No automatic unlock/downgrade.
      if (['committed', 'rolled-back'].includes(j.phase)) {
        this.state = { state: 'activation-required', error: 'update_activation_unconfirmed' };
        return { state: 'activation-required' };
      }
      // Crash recovery is not permission to stop an independently running app.
      if (!this.service || await this.service.recoverySafe?.() !== true) throw Error('update_recovery_blocked');
      const current = await this.readCurrent();
      if (!current || ![j.previous.id, j.next.id].includes(current.id)) throw Error('update_current_conflict');
      if (!this.recoveryLease && !this.coordinator?.acquireRecovery) throw Error('install_coordination_unavailable');
      const lease = this.recoveryLease || await this.coordinator.acquireRecovery({ journal: j, current });
      if (!lease || typeof lease.assertValid !== 'function' || typeof lease.release !== 'function') throw Error('install_permit_invalid');
      this.recoveryLease = lease;
      try {
        await lease.assertValid(); await this.rollback(j, lease);
        await lease.assertValid(); await lease.release(); this.recoveryLease = null;
        return { state: 'rolled-back', version: j.previous.version };
      } catch {
        this.state = { state: 'recovery-required', error: 'update_rollback_failed' };
        throw Error('update_rollback_failed');
      }
    });
  }
  async reconcileActivation() {
    return this.locked(async () => {
      const j = await this.readJournal();
      if (!j || !['committed', 'rolled-back'].includes(j.phase)) throw Error('update_recovery_required');
      const pointer = j.phase === 'committed' ? j.next : j.previous, current = await this.readCurrent();
      if (!current || ['id', 'version', 'commit', 'buildId'].some(k => current[k] !== pointer[k])) throw Error('update_current_conflict');
      await this.verifyInstalled(pointer);
      if (!this.service?.activate || !this.recoveryLease && !this.coordinator?.acquireRecovery) throw Error('install_coordination_unavailable');
      // Reuse a retained lease only after revalidation; after restart require a
      // fresh authoritative recovery permit, never infer one from the journal.
      const lease = this.recoveryLease || await this.coordinator.acquireRecovery({ journal: j, current });
      if (!lease || typeof lease.assertValid !== 'function' || typeof lease.release !== 'function') throw Error('install_permit_invalid');
      this.recoveryLease = lease;
      try {
        await lease.assertValid();
        if (await this.service.isStopped() === true) await this.healthy(pointer);
        await lease.assertValid(); await this.service.activate(pointer);
        await lease.assertValid(); await lease.release(); this.recoveryLease = null;
        this.state = { state: j.phase, version: pointer.version, error: null };
        return { state: j.phase, version: pointer.version };
      } catch {
        this.state = { state: 'activation-required', error: 'update_activation_unconfirmed' };
        throw Error('update_activation_unconfirmed');
      }
    });
  }
}
