import path from 'node:path';
import { homedir } from 'node:os';
import { lstat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { get } from 'node:http';
import { randomUUID } from 'node:crypto';
import { validBackendCommand, validBackendEvidence } from './update-control-protocol.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => a && b && ['id', 'version', 'commit', 'buildId'].every(k => a[k] === b[k]);
const within = (a, b) => b === a || b.startsWith(a + path.sep);
const alive = child => child && child.exitCode === null && child.signalCode === null;

// Transport has no proxy, redirects, cookies, credential headers or unbounded
// response buffering. Only the fixed loopback health endpoint is requested.
function health(origin, timeout) {
  return new Promise((resolve, reject) => {
    const req = get(origin + '/local-app/health', { agent: false }, res => {
      let bytes = 0; const chunks = [];
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8192) req.destroy(Error('service_health_invalid'));
        else chunks.push(chunk);
      });
      res.on('error', () => reject(Error('service_health_unavailable')));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw Error();
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch { reject(Error('service_health_invalid')); }
      });
    });
    // A total deadline, not merely an inactivity timeout.
    const timer = setTimeout(() => req.destroy(Error('service_health_timeout')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(Error('service_health_unavailable')));
  });
}

function portFree(port, timeout = 500) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = result => { clearTimeout(timer); socket.destroy(); resolve(result); };
    const timer = setTimeout(() => finish(false), timeout);
    socket.once('connect', () => finish(false));
    socket.once('error', e => finish(e.code === 'ECONNREFUSED'));
  });
}

// Trusted in-process API only. It cannot adopt a listener or signal a stored
// PID after restart. Signed verification must be supplied by UpdateManager.
// A manager crash/orphan therefore blocks recovery instead of guessing owner.
export class OwnedUpdateService {
  constructor({ versionsRoot, dataRoot, privateRoot, verify, origin = 'http://127.0.0.1:5174',
    startupTimeout = 15000, stopTimeout = 10000, activationTimeout = 3000,
    disableProxy = false }) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.origin !== origin
      || !url.port || typeof verify !== 'function'
      || !path.isAbsolute(versionsRoot || '') || !path.isAbsolute(dataRoot || '') || !path.isAbsolute(privateRoot || '')
      || [startupTimeout, stopTimeout, activationTimeout].some(v => !Number.isSafeInteger(v) || v < 50 || v > 60000)) throw Error('service_configuration_invalid');
    this.versionsRoot = path.resolve(versionsRoot); this.dataRoot = path.resolve(dataRoot);
    this.privateRoot = path.resolve(privateRoot);
    if (this.dataRoot !== path.join(this.privateRoot, 'data')) throw Error('service_configuration_invalid');
    if (within(this.versionsRoot, this.dataRoot) || within(this.dataRoot, this.versionsRoot)
      || [this.versionsRoot, this.dataRoot, this.privateRoot].some(v => v === homedir() || v === path.parse(v).root)) throw Error('service_configuration_invalid');
    this.origin = origin; this.port = Number(url.port); this.verify = verify;
    this.startupTimeout = startupTimeout; this.stopTimeout = stopTimeout;
    this.activationTimeout = activationTimeout; this.disableProxy = disableProxy;
    this.owned = null; this.busy = false;
    Object.defineProperty(this, 'requiredStartupProtocol', { value: 1 });
  }
  async exclusive(fn) {
    if (this.busy) throw Error('service_operation_in_progress');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async checkedDirectory(pointer) {
    if (!pointer || !/^[0-9A-Za-z.+-]{1,160}$/.test(pointer.id || '')) throw Error('service_identity_invalid');
    const directory = path.join(this.versionsRoot, pointer.id);
    if (pointer.directory !== directory || pointer.dataRoot !== this.dataRoot || pointer.origin !== this.origin) throw Error('service_identity_invalid');
    for (const dir of [this.versionsRoot, this.privateRoot, this.dataRoot, directory]) {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
        || info.mode & 0o022 || await realpath(dir) !== dir) throw Error('service_path_invalid');
    }
    // Verification happens immediately before execution, not just staging.
    const checked = await this.verify(Object.freeze(Object.fromEntries(['id', 'version', 'commit', 'buildId'].map(k => [k, pointer[k]]))));
    if (checked?.directory !== directory) throw Error('service_identity_invalid');
    // Older signed releases ignored quarantine environment flags. Never run
    // them speculatively and discover compatibility after opening HTTP routes.
    if (checked.startupProtocol !== 1) throw Error('service_startup_protocol_incompatible');
    for (const relative of ['runtime/node', 'server.mjs']) {
      const file = path.join(directory, relative), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()
        || info.mode & 0o022 || await realpath(file) !== file) throw Error('service_path_invalid');
    }
    return directory;
  }
  async report(owned, maintenance) {
    if (this.owned !== owned || !alive(owned.child) || !owned.child.connected || owned.spawnError) throw Error('service_ownership_lost');
    const report = await health(this.origin, Math.min(500, this.startupTimeout));
    if (this.owned !== owned || !alive(owned.child) || report.app !== 'guan-ai-workbench'
      || report.pid !== owned.child.pid || report.ready !== true || report.origin !== this.origin
      || report.version !== owned.pointer.version || report.buildId !== owned.pointer.buildId
      || typeof report.instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(report.instanceId)
      || owned.instanceId && owned.instanceId !== report.instanceId
      || report.maintenance !== maintenance) throw Error('service_health_invalid');
    owned.instanceId = report.instanceId;
    return report;
  }
  async start(pointer) {
    return this.exclusive(async () => {
      if (this.owned) throw Error('service_stop_required');
      const directory = await this.checkedDirectory(pointer);
      if (!await portFree(this.port)) throw Error('service_port_occupied');
      const nonce = randomUUID();
      const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(),
        PORT: String(this.port), GUAN_WORKBENCH_DATA_DIR: this.privateRoot,
        GUAN_UPDATE_QUARANTINE: '1', GUAN_UPDATE_NONCE: nonce };
      if (this.disableProxy) Object.assign(env, { IMAGE_RELAY_MIHOMO_DISABLED: 'true', IMAGE_RELAY_MIHOMO_AUTO_DOWNLOAD: 'false' });
      const child = spawn(path.join(directory, 'runtime/node'), ['server.mjs'], {
        cwd: directory, env, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: false,
      });
      const owned = { child, nonce, pointer: Object.freeze({ ...pointer }), instanceId: null, active: false, spawnError: false, controlSequence: 0, controlUnknown: false };
      this.owned = owned;
      child.on('error', () => { owned.spawnError = true; });
      child.on('exit', () => {}); // Retain ownership evidence until explicit stop.
      const deadline = Date.now() + this.startupTimeout;
      while (Date.now() < deadline) {
        if (owned.spawnError || !alive(child)) throw Error('service_start_failed');
        try { return await this.report(owned, true); } catch {}
        await pause(40);
      }
      // Keep the child handle for the transaction's rollback stop. Do not kill
      // on timeout and forget a process that may still be starting.
      throw Error('service_start_timeout');
    });
  }
  async stop({ allowed }) {
    return this.exclusive(async () => {
      const owned = this.owned;
      if (!owned) {
        if (!await portFree(this.port)) throw Error('service_ownership_unknown');
        return;
      }
      if (!Array.isArray(allowed) || !allowed.some(v => same(v, owned.pointer))) throw Error('service_identity_invalid');
      if (alive(owned.child) && !owned.spawnError) {
        // ChildProcess retains the exact live handle; never use process.kill
        // with a journal PID, lsof result, or an inherited environment value.
        owned.child.kill('SIGTERM');
        const deadline = Date.now() + this.stopTimeout;
        while (alive(owned.child) && Date.now() < deadline) await pause(25);
        if (alive(owned.child)) throw Error('service_stop_timeout');
      }
      if (!await portFree(this.port)) throw Error('service_port_occupied');
      this.owned = null;
    });
  }
  async isStopped() { return !alive(this.owned?.child) && await portFree(this.port); }
  canDetach() { return this.owned === null && !this.busy; }
  async inspectOwned() {
    return this.exclusive(async () => {
      const owned = this.owned;
      if (!owned) {
        if (!await this.isStopped()) throw Error('service_ownership_lost');
        return { stopped: true };
      }
      const report = await this.report(owned, !owned.active);
      return { stopped: false, pointer: Object.fromEntries(['id', 'version', 'commit', 'buildId'].map(key => [key, owned.pointer[key]])), instance: report.instanceId,
        active: owned.active, maintenance: report.maintenance };
    });
  }
  async recoverySafe() {
    if (!this.owned) return this.isStopped();
    if (!alive(this.owned.child)) return this.isStopped();
    // Only this manager's still-quarantined child can be interrupted safely.
    if (this.owned.active) return false;
    try { await this.report(this.owned, true); return true; } catch { return false; }
  }
  async activate(pointer) {
    return this.exclusive(async () => {
      const owned = this.owned;
      if (!same(pointer, owned?.pointer) || !alive(owned.child) || !owned.child.connected) throw Error('service_ownership_lost');
      // Idempotence covers a lost ack within the same owned IPC session.
      if (owned.active) return this.report(owned, false);
      let acknowledged = false;
      const receive = m => {
        if (m && Object.keys(m).sort().join(',') === 'nonce,op'
          && m.op === 'guan-update-activated' && m.nonce === owned.nonce) acknowledged = true;
      };
      owned.child.on('message', receive);
      try {
        owned.child.send({ op: 'guan-update-activate', nonce: owned.nonce }, () => {});
        const deadline = Date.now() + this.activationTimeout;
        while (!acknowledged && alive(owned.child) && owned.child.connected && Date.now() < deadline) await pause(20);
        // Even without an ack, exact PID/instance health may prove activation.
        // On failure preserve the child and committed pointer; never downgrade.
        const report = await this.report(owned, false); owned.active = true; return report;
      } finally { owned.child.off('message', receive); }
    });
  }
  async backendControl(command) {
    if (!validBackendCommand(command)) throw Error('service_backend_request_invalid');
    // Capture before awaits, and reject commands rather than silently queuing
    // them across a service replacement.
    const input = structuredClone(command);
    return this.exclusive(async () => {
      const owned = this.owned;
      if (!owned || owned.controlUnknown) throw Error('service_backend_outcome_unknown');
      const report = await this.report(owned, !owned.active);
      if (report.backendControlProtocol !== 1) throw Error('service_backend_protocol_incompatible');
      const sequence = ++owned.controlSequence;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return; settled = true;
          clearTimeout(timer); owned.child.off('message', receive); owned.child.off('exit', lost); owned.child.off('disconnect', lost);
          if (error) reject(error); else resolve(value);
        };
        const lost = () => { owned.controlUnknown = true; finish(Error('service_backend_outcome_unknown')); };
        const receive = m => {
          if (m?.op !== 'guan-update-backend-result') return;
          const keys = m.ok === true ? 'evidence,instance,nonce,ok,op,sequence' : 'error,instance,nonce,ok,op,sequence';
          if (Object.keys(m).sort().join(',') !== keys || m.nonce !== owned.nonce || m.instance !== owned.instanceId
            || m.sequence !== sequence || typeof m.ok !== 'boolean' || this.owned !== owned || !alive(owned.child)) { lost(); return; }
          if (!m.ok) {
            if (!/^service_backend_[a-z_]{1,40}$/.test(m.error || '')) { lost(); return; }
            finish(Error(m.error)); return;
          }
          if (!validBackendEvidence(m.evidence) || m.evidence.instance !== owned.instanceId || m.evidence.version !== owned.pointer.version) { lost(); return; }
          finish(null, m.evidence);
        };
        const timer = setTimeout(lost, this.activationTimeout);
        owned.child.on('message', receive); owned.child.once('exit', lost); owned.child.once('disconnect', lost);
        try { owned.child.send({ op: 'guan-update-backend', nonce: owned.nonce, instance: owned.instanceId, sequence, command: input }, error => { if (error) lost(); }); }
        catch { lost(); }
      });
    });
  }
}
