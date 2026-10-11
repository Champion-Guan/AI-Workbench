import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, realpath, open, unlink, rename, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPrivateFile, writePrivateFile, privateDirectory } from './runtime-paths.mjs';
import { updateManagerLaunchAgent, updateSupervisorLaunchAgent } from './update-launchd.mjs';
import { compareVersions } from './stable-version.mjs';

const execute = promisify(execFile);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const inside = (a, b) => b === a || b.startsWith(a + path.sep);
const same = (a, b) => ['id', 'version', 'commit', 'buildId'].every(key => a?.[key] === b?.[key]);

// Fixed user-domain launchctl only. This adapter is not an HTTP/IPC command
// dispatcher. Any unrecognised lookup failure is UNKNOWN, not an absent job.
export class UserLaunchdJobs {
  constructor({ uid = process.getuid(), run = execute, platform = process.platform } = {}) {
    if (platform !== 'darwin' || !Number.isSafeInteger(uid) || uid < 1) throw Error('updater_deployment_platform_invalid');
    this.domain = 'gui/' + uid; this.uid = uid; this.run = run;
  }
  target(label) {
    if (!/^com\.guanaiworkbench\.(?:updater|supervisor)(?:\.qa\.[a-f0-9-]{36})?$/.test(label)) throw Error('updater_deployment_label_invalid');
    return this.domain + '/' + label;
  }
  async command(args) {
    return this.run('/bin/launchctl', args, { timeout: 10000, maxBuffer: 1024 * 1024,
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  }
  async inspect(label, expected) {
    const target = this.target(label);
    let stdout;
    try { ({ stdout } = await this.command(['print', target])); }
    catch (error) {
      const absent = `Bad request.\nCould not find service "${label}" in domain for user gui: ${this.uid}\n`;
      if (error.code === 113 && error.stderr === absent) return false;
      throw Error('updater_deployment_job_unknown');
    }
    if (typeof stdout !== 'string' || stdout.includes('\0')) throw Error('updater_deployment_job_unknown');
    const field = name => stdout.split('\n').filter(line => line.trim().startsWith(name + ' = '));
    for (const [name, value] of [['path', expected.plist], ['program', expected.node], ['working directory', expected.directory]]) {
      const rows = field(name);
      if (rows.length !== 1 || rows[0].trim() !== name + ' = ' + value) throw Error('updater_deployment_job_conflict');
    }
    const arguments_ = /^\s*arguments = \{\n([\s\S]*?)^\s*\}\s*$/m.exec(stdout);
    if (!arguments_ || JSON.stringify(arguments_[1].split('\n').map(line => line.trim()).filter(Boolean))
      !== JSON.stringify([expected.node, expected.entry])) throw Error('updater_deployment_job_conflict');
    return true;
  }
  async start(label, expected) {
    this.target(label);
    if (await this.inspect(label, expected)) throw Error('updater_deployment_job_exists');
    await this.command(['bootstrap', this.domain, expected.plist]);
    if (!await this.inspect(label, expected)) throw Error('updater_deployment_start_unconfirmed');
  }
  async stop(label, expected) {
    if (!await this.inspect(label, expected)) return;
    await this.command(['bootout', this.target(label)]);
    const deadline = Date.now() + 30000;
    while (await this.inspect(label, expected)) {
      if (Date.now() >= deadline) throw Error('updater_deployment_stop_unconfirmed');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

// Deployment runs from a separately launched trusted installer, not the job
// being replaced. The supervisor remains pinned and running during manager
// upgrades, retaining its exact app ChildProcess. Its own upgrade is a separate
// stopped-service maintenance operation, not a side effect of every app update.
export class UpdaterDeployment {
  constructor({ runtime, directory, agents, privateRoot, logs, jobs, health,
    suffix = '', onStep = async () => {} }) {
    if (!runtime?.verify || !runtime?.manager?.locked || !jobs?.inspect || !jobs?.start || !jobs?.stop
      || typeof health !== 'function' || ![directory, agents, privateRoot, logs].every(v => typeof v === 'string'
        && path.isAbsolute(v) && path.resolve(v) === v && !/[\x00-\x1f]/.test(v))
      || suffix !== '' && !/^\.qa\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(suffix)) throw Error('updater_deployment_invalid');
    const protectedRoots = [runtime.manager.root, runtime.manager.dataRoot, runtime.directory];
    if (protectedRoots.some(root => [directory, agents, logs].some(v => inside(root, v) || inside(v, root)))
      || [directory, agents, logs].some(v => v === path.parse(v).root)
      || [directory, agents, logs].some((v, i, all) => all.some((w, j) => i !== j && (inside(v, w) || inside(w, v)))))
      throw Error('updater_deployment_path_invalid');
    Object.assign(this, { runtime, directory, agents, privateRoot, logs, jobs, health, onStep });
    this.labels = { manager: 'com.guanaiworkbench.updater' + suffix, supervisor: 'com.guanaiworkbench.supervisor' + suffix };
    this.file = path.join(directory, 'deployment.json');
  }
  async initialize() {
    for (const directory of [this.directory, this.logs]) await privateDirectory(directory);
    const info = await lstat(this.agents);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.agents) !== this.agents
      || info.uid !== process.getuid() || info.mode & 0o022) throw Error('updater_deployment_path_invalid');
  }
  async descriptors(pointer) {
    const runtime = await this.runtime.verify(pointer, path.join(this.runtime.directory, pointer.id));
    const result = {};
    for (const role of ['manager', 'supervisor']) {
      const label = this.labels[role], plist = path.join(this.agents, label + '.plist');
      const options = { ...runtime, entry: role === 'manager' ? runtime.entry : runtime.supervisorEntry,
        dataRoot: this.privateRoot, logs: this.logs, label };
      result[role] = { node: runtime.node, entry: options.entry, directory: runtime.directory, plist,
        bytes: role === 'manager' ? updateManagerLaunchAgent(options) : updateSupervisorLaunchAgent(options) };
    }
    return result;
  }
  async read() {
    const raw = await readPrivateFile(this.file, { maxBytes: 8192 });
    if (raw === null) return null;
    const record = JSON.parse(raw);
    if (!exact(record, ['format', 'phase', 'previous', 'next', 'supervisor']) || record.format !== 1
      || !['prepared', 'manager-stopped', 'written', 'started', 'committed', 'rolling-back', 'rolled-back'].includes(record.phase))
      throw Error('updater_deployment_record_invalid');
    await this.descriptors(record.next); await this.descriptors(record.supervisor);
    if (record.previous) {
      await this.descriptors(record.previous);
      if (compareVersions(record.next.version, record.previous.version) <= 0) throw Error('updater_deployment_record_invalid');
    } else if (!same(record.next, record.supervisor)) throw Error('updater_deployment_record_invalid');
    return record;
  }
  async record(value, phase) {
    value.phase = phase; await writePrivateFile(this.file, JSON.stringify(value)); await this.onStep(phase);
  }
  async plist(descriptor, allowAbsent = false) {
    const raw = await readPrivateFile(descriptor.plist, { maxBytes: 16384 });
    if (raw === null && allowAbsent) return false;
    const info = await lstat(descriptor.plist);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || info.mode & 0o077)
      throw Error('updater_deployment_plist_conflict');
    if (raw !== descriptor.bytes) throw Error('updater_deployment_plist_conflict');
    return true;
  }
  async write(descriptor, exclusive = false, allowed = [descriptor.bytes]) {
    if (!exclusive && !allowed.includes(await readPrivateFile(descriptor.plist, { maxBytes: 16384 })))
      throw Error('updater_deployment_plist_conflict');
    // LaunchAgents is shared with unrelated user jobs. Do not use the generic
    // private writer, which chmods its parent and would alter that shared dir.
    const temporary = path.join(this.agents, '.guan-updater-' + randomUUID());
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(descriptor.bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      if (exclusive) await link(temporary, descriptor.plist);
      else await rename(temporary, descriptor.plist);
      const dir = await open(this.agents, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    await this.plist(descriptor);
  }
  async remove(descriptor) {
    if (!await this.plist(descriptor, true)) return;
    const before = await lstat(descriptor.plist);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error('updater_deployment_plist_conflict');
    const current = await lstat(descriptor.plist);
    if (current.ino !== before.ino || current.dev !== before.dev) throw Error('updater_deployment_plist_conflict');
    await unlink(descriptor.plist);
    const dir = await open(this.agents, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
  }
  async deploy(pointer, lease) {
    pointer = structuredClone(pointer);
    return this.runtime.manager.locked(async () => {
      await this.initialize();
      if (typeof lease?.assertValid !== 'function') throw Error('install_permit_invalid');
      const old = await this.read();
      if (old && !['committed', 'rolled-back'].includes(old.phase)) throw Error('updater_deployment_recovery_required');
      const previous = old ? old.phase === 'committed' ? old.next : old.previous : null;
      if (previous && compareVersions(pointer.version, previous.version) <= 0) throw Error('version_not_newer');
      const next = await this.descriptors(pointer), prior = previous ? await this.descriptors(previous) : null;
      if (prior && process.execPath === prior.manager.node && path.resolve(process.argv[1] || '.') === prior.manager.entry)
        throw Error('updater_deployment_separate_installer_required');
      const supervisorPointer = previous ? old.supervisor : pointer, supervisor = (await this.descriptors(supervisorPointer)).supervisor;
      await lease.assertValid();
      if (prior) {
        await this.plist(prior.manager); await this.plist(supervisor);
        if (!await this.jobs.inspect(this.labels.manager, prior.manager) || !await this.jobs.inspect(this.labels.supervisor, supervisor))
          throw Error('updater_deployment_job_unknown');
      } else {
        for (const role of ['manager', 'supervisor']) {
          if (await readPrivateFile(next[role].plist, { maxBytes: 16384 }) !== null
            || await this.jobs.inspect(this.labels[role], next[role])) throw Error('updater_deployment_job_exists');
        }
      }
      const record = { format: 1, phase: 'prepared', previous, next: pointer, supervisor: supervisorPointer };
      await this.record(record, 'prepared');
      try {
        await lease.assertValid();
        if (prior) await this.jobs.stop(this.labels.manager, prior.manager);
        await this.record(record, 'manager-stopped'); await lease.assertValid();
        if (!prior) await this.write(next.supervisor, true);
        await this.write(next.manager, !prior, prior ? [prior.manager.bytes] : []); await this.record(record, 'written');
        await lease.assertValid();
        if (!prior) await this.jobs.start(this.labels.supervisor, next.supervisor);
        await this.jobs.start(this.labels.manager, next.manager); await this.record(record, 'started');
        await this.health({ manager: pointer, supervisor: supervisorPointer }); await lease.assertValid();
        await this.record(record, 'committed'); return { state: 'committed', managerVersion: pointer.version, supervisorVersion: supervisorPointer.version };
      } catch {
        // Never run a rollback with an expired maintenance permit. Retain the
        // journal and exact signed runtime/plists for explicit cold recovery.
        try { await lease.assertValid(); await this.rollback(record, lease); }
        catch { throw Error('updater_deployment_recovery_required'); }
        throw Error('updater_deployment_failed_rolled_back');
      }
    });
  }
  async rollback(record, lease) {
    const next = await this.descriptors(record.next), prior = record.previous ? await this.descriptors(record.previous) : null;
    const supervisor = (await this.descriptors(record.supervisor)).supervisor;
    await lease.assertValid(); await this.record(record, 'rolling-back');
    // A failed bootstrap may have succeeded remotely. Inspect before stopping;
    // only exact, signed job descriptors may be touched.
    const raw = await readPrivateFile(next.manager.plist, { maxBytes: 16384 });
    if (raw === next.manager.bytes) await this.jobs.stop(this.labels.manager, next.manager);
    else if (prior && raw === prior.manager.bytes) await this.jobs.stop(this.labels.manager, prior.manager);
    else if (raw !== null) throw Error('updater_deployment_plist_conflict');
    if (prior) {
      await this.plist(supervisor);
      if (!await this.jobs.inspect(this.labels.supervisor, supervisor)) throw Error('updater_deployment_job_unknown');
      await lease.assertValid(); await this.write(prior.manager, false, [next.manager.bytes, prior.manager.bytes]);
      await this.jobs.start(this.labels.manager, prior.manager);
      await this.health({ manager: record.previous, supervisor: record.supervisor });
    } else {
      // Initial deployment owns no app service yet. The trusted health/lease
      // provider must prove this before stopping its newly created supervisor.
      await lease.assertValid(); await this.jobs.stop(this.labels.supervisor, supervisor);
      await this.remove(next.manager); await this.remove(supervisor);
    }
    await lease.assertValid(); await this.record(record, 'rolled-back');
  }
  async recover(lease) {
    return this.runtime.manager.locked(async () => {
      await this.initialize();
      if (typeof lease?.assertValid !== 'function') throw Error('install_permit_invalid');
      const record = await this.read();
      if (!record) return { state: 'not-installed' };
      if (record.phase === 'committed') {
        // A durable receipt does not prove that both jobs are alive or ready.
        const manager = (await this.descriptors(record.next)).manager, supervisor = (await this.descriptors(record.supervisor)).supervisor;
        await lease.assertValid(); await this.plist(manager); await this.plist(supervisor);
        if (!await this.jobs.inspect(this.labels.manager, manager) || !await this.jobs.inspect(this.labels.supervisor, supervisor))
          throw Error('updater_deployment_job_unknown');
        await this.health({ manager: record.next, supervisor: record.supervisor }); await lease.assertValid();
        return { state: 'committed' };
      }
      if (record.phase === 'rolled-back') {
        await lease.assertValid();
        if (record.previous) {
          const prior = await this.descriptors(record.previous), supervisor = (await this.descriptors(record.supervisor)).supervisor;
          await this.plist(prior.manager); await this.plist(supervisor);
          if (!await this.jobs.inspect(this.labels.manager, prior.manager) || !await this.jobs.inspect(this.labels.supervisor, supervisor))
            throw Error('updater_deployment_job_unknown');
          await this.health({ manager: record.previous, supervisor: record.supervisor });
        } else {
          const next = await this.descriptors(record.next);
          for (const role of ['manager', 'supervisor']) {
            if (await readPrivateFile(next[role].plist, { maxBytes: 16384 }) !== null
              || await this.jobs.inspect(this.labels[role], next[role])) throw Error('updater_deployment_job_unknown');
          }
        }
        await lease.assertValid(); return { state: 'rolled-back' };
      }
      await this.rollback(record, lease); return { state: 'rolled-back' };
    });
  }
}
