import net from 'node:net';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { parseVersion } from './stable-version.mjs';
import { UpdateError } from './update-auth.mjs';

const states = new Set(['idle', 'staged', 'prepared', 'stopping', 'switching', 'starting', 'committed',
  'rolling-back', 'rolled-back', 'blocked', 'recovery-required', 'activation-required', 'bootstrap-required', 'awaiting-browser-exit', 'confirmation-required', 'deferred']);
const reasons = new Set(['update_bootstrap_required', 'install_coordination_unavailable', 'update_recovery_required',
  'update_activation_unconfirmed', 'update_state_invalid', 'install_permit_invalid', 'update_failed_rolled_back', 'update_rollback_failed',
  'install_operator_confirmation_required', 'install_operator_record_invalid', 'install_tasks_pending', 'install_browsers_running',
  'install_evidence_changed', 'install_evidence_unconfirmed', 'install_closure_evidence_unavailable', 'install_coordination_busy',
  'install_backend_not_idle', 'install_backend_not_frozen', 'install_service_identity_invalid',
  'update_storage_invalid', 'service_ownership_lost', 'service_port_occupied', 'service_backend_outcome_unknown',
  'service_supervisor_outcome_unknown', 'service_supervisor_path_invalid', 'service_health_invalid']);
const stable = v => typeof v === 'string' && parseVersion(v) && !parseVersion(v).pre.length;

// Backend-only bridge. Fixed private socket; never accepts URLs, paths, tokens,
// commands or installation/recovery operations from the browser.
export class UpdateManagerClient {
  constructor({ socketPath, repository = 'MrGuAm/guan-ai-workbench', timeoutMs = 3000, stageTimeoutMs = 120000 }) {
    if (!path.isAbsolute(socketPath)) throw Error('update_socket_invalid');
    this.socketPath = socketPath; this.repository = repository;
    this.timeoutMs = timeoutMs; this.stageTimeoutMs = stageTimeoutMs;
  }
  async request(input, timeoutMs) {
    try {
      if (Buffer.byteLength(this.socketPath) > 103) throw Error();
      const directory = path.dirname(this.socketPath), parent = await lstat(directory), info = await lstat(this.socketPath);
      if (!parent.isDirectory() || await realpath(directory) !== directory || parent.uid !== process.getuid() || parent.mode & 0o077
        || !info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) throw Error();
      return await new Promise((resolve, reject) => {
        const socket = net.connect(this.socketPath), chunks = []; let count = 0, finished = false;
        const finish = (error, value) => {
          if (finished) return; finished = true; clearTimeout(timer); socket.destroy();
          if (error) reject(new UpdateError(error)); else resolve(value);
        };
        // A total deadline, not an idle timeout which a slow peer can renew.
        const timer = setTimeout(() => finish('update_manager_unavailable'), timeoutMs);
        socket.on('connect', () => socket.write(JSON.stringify(input) + '\n'));
        socket.on('error', () => finish('update_manager_unavailable'));
        socket.on('data', chunk => {
          count += chunk.length;
          if (count > 4096) return finish('update_manager_invalid');
          chunks.push(chunk);
          const raw = Buffer.concat(chunks), newline = raw.indexOf(10);
          if (newline < 0) return;
          try {
            if (newline !== raw.length - 1) throw Error();
            const reply = JSON.parse(raw.subarray(0, newline).toString('utf8'));
            if (!reply || reply.ok !== true || Object.keys(reply).sort().join(',') !== 'ok,result') throw Error();
            finish(null, reply.result);
          } catch { finish('update_manager_invalid'); }
        });
        socket.on('end', () => finish('update_manager_invalid'));
      });
    } catch (e) {
      throw new UpdateError(e instanceof UpdateError ? e.code : 'update_manager_unavailable');
    }
  }
  async status() {
    try {
      const s = await this.request({ op: 'status' }, this.timeoutMs);
      if (!s || Object.keys(s).sort().join(',') !== 'currentVersion,error,installAllowed,state,version'
        || s.installAllowed !== false || !states.has(s.state)
        || s.error !== null && !reasons.has(s.error)
        || s.version !== null && !stable(s.version) || s.currentVersion !== null && !stable(s.currentVersion)) throw Error();
      return { allowed: false, state: s.state, currentVersion: s.currentVersion, targetVersion: s.version, reason: s.error };
    } catch (e) {
      return { allowed: false, state: 'unavailable', currentVersion: null, targetVersion: null,
        reason: e instanceof UpdateError ? e.code : 'update_manager_invalid' };
    }
  }
  async stage({ downloadId, version, repository }) {
    if (repository !== this.repository || typeof downloadId !== 'string'
      || !/^verified-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(downloadId) || !stable(version)) throw new UpdateError('update_stage_invalid');
    const p = await this.request({ op: 'stage', downloadId, version }, this.stageTimeoutMs);
    if (!p || Object.keys(p).sort().join(',') !== 'buildId,commit,id,version' || p.version !== version
      || typeof p.id !== 'string' || !/^[0-9A-Za-z.+-]{1,160}$/.test(p.id)
      || typeof p.commit !== 'string' || !/^[a-f0-9]{40}$/.test(p.commit)
      || typeof p.buildId !== 'string' || !/^[a-f0-9]{24}$/.test(p.buildId)
      || !p.id.startsWith(version + '-' + p.commit.slice(0, 12) + '-')) throw new UpdateError('update_manager_invalid');
    return { version: p.version }; // No filesystem identity/path enters HTTP.
  }
  async approve({ downloadId, version, repository }, acknowledgement) {
    if (repository !== this.repository || typeof downloadId !== 'string'
      || !/^verified-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(downloadId) || !stable(version)
      || acknowledgement !== 'saved-and-all-tasks-ended') throw new UpdateError('install_operator_confirmation_required');
    const result = await this.request({ op: 'approve', downloadId, version, acknowledgement }, this.stageTimeoutMs);
    if (!result || Object.keys(result).sort().join(',') !== 'state,targetVersion' || result.state !== 'awaiting-browser-exit'
      || result.targetVersion !== version) throw new UpdateError('update_manager_invalid');
    return result;
  }
  async defer() {
    const result = await this.request({ op: 'defer' }, this.timeoutMs);
    if (!result || Object.keys(result).join(',') !== 'state' || result.state !== 'deferred') throw new UpdateError('update_manager_invalid');
    return result;
  }
}
