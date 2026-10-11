import net from 'node:net';
import path from 'node:path';
import { constants } from 'node:fs';
import { chmod, lstat, open, realpath, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { writePrivateFile } from './runtime-paths.mjs';
import { parseVersion } from './stable-version.mjs';
import { validBackendCommand, validBackendEvidence } from './update-control-protocol.mjs';

const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const identityKeys = ['id', 'version', 'commit', 'buildId'];
const identity = v => exact(v, identityKeys) && /^[0-9A-Za-z.+-]{1,160}$/.test(v.id)
  && typeof v.version === 'string' && parseVersion(v.version) && !parseVersion(v.version).pre.length
  && /^[a-f0-9]{40}$/.test(v.commit) && /^[a-f0-9]{24}$/.test(v.buildId);
const uuid = v => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const secretValid = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const publicError = e => /^service_[a-z_]{1,60}$/.test(e?.message || '') ? e.message : 'service_supervisor_request_failed';

async function privatePath(file, socket = false) {
  const parent = path.dirname(file), dir = await lstat(parent), info = await lstat(file);
  if (!path.isAbsolute(file) || await realpath(parent) !== parent || dir.isSymbolicLink() || !dir.isDirectory()
    || dir.uid !== process.getuid() || dir.mode & 0o077 || info.uid !== process.getuid()
    || info.mode & 0o077 || info.isSymbolicLink() || !(socket ? info.isSocket() : info.isFile())) throw Error('service_supervisor_path_invalid');
  return info;
}

// A per-installation local capability, never included in HTTP responses, env,
// argv or packages. An existing invalid file is retained, never regenerated.
export async function supervisorCapability(file, { create = false } = {}) {
  if (create) await writePrivateFile(file, randomBytes(32).toString('hex'), { exclusive: true });
  const before = await privatePath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || info.size !== 64) throw Error('service_supervisor_capability_invalid');
    const bytes = Buffer.alloc(65), { bytesRead } = await handle.read(bytes, 0, 65, 0);
    const value = bytes.subarray(0, bytesRead).toString('ascii');
    if (bytesRead !== 64 || !secretValid(value)) throw Error('service_supervisor_capability_invalid');
    return value;
  } finally { await handle.close(); }
}

// Stable independent process owns the actual ChildProcess and inherited IPC.
// Manager reconnects to this owner; it never adopts a saved PID/port. This
// protocol is not exposed by the Web backend's status/stage socket.
export async function serveUpdateSupervisor({ service, socketPath, capability, versionsRoot, dataRoot, origin }) {
  if (!secretValid(capability) || !path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 103) throw Error('service_supervisor_configuration_invalid');
  const parent = path.dirname(socketPath), info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077
    || await realpath(parent) !== parent) throw Error('service_supervisor_path_invalid');
  try { await lstat(socketPath); throw Error('service_supervisor_socket_exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const incarnation = randomUUID(), sockets = new Set();
  let controller = null, busy = false, ready = false;
  const server = net.createServer(socket => {
    if (!ready || sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket); socket.on('error', () => {});
    let buffer = Buffer.alloc(0), admitted = false, session = null, sequence = 0;
    const authDeadline = setTimeout(() => socket.destroy(), 2000);
    socket.once('close', () => { clearTimeout(authDeadline); sockets.delete(socket); if (controller === socket) controller = null; });
    socket.setTimeout(10000, () => socket.destroy());
    const reply = value => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
    socket.on('data', async chunk => {
      if (admitted && busy || buffer.length + chunk.length > 4096) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) { socket.destroy(); return; }
      let request;
      try { request = JSON.parse(buffer.subarray(0, newline).toString('utf8')); } catch { socket.destroy(); return; }
      buffer = Buffer.alloc(0);
      if (!admitted) {
        if (!exact(request, ['op', 'capability']) || request.op !== 'hello' || !secretValid(request.capability)
          || !timingSafeEqual(Buffer.from(request.capability), Buffer.from(capability)) || controller || busy) { socket.destroy(); return; }
        clearTimeout(authDeadline); admitted = true; session = randomUUID(); controller = socket;
        reply({ ok: true, incarnation, session }); return;
      }
      if (controller !== socket || !exact(request, ['op', 'incarnation', 'session', 'sequence', 'value'])
        || request.incarnation !== incarnation || request.session !== session || request.sequence !== sequence + 1) { socket.destroy(); return; }
      sequence++;
      busy = true; socket.setTimeout(0);
      try {
        let result;
        if (request.op === 'ping' && request.value === null) result = true;
        else if (request.op === 'start' && identity(request.value)) result = await service.start({ ...request.value,
          directory: path.join(versionsRoot, request.value.id), dataRoot, origin });
        else if (request.op === 'activate' && identity(request.value)) result = await service.activate(request.value);
        else if (request.op === 'stop' && Array.isArray(request.value) && request.value.length >= 1 && request.value.length <= 2
          && request.value.every(identity)) { await service.stop({ allowed: request.value }); result = true; }
        else if (request.op === 'isStopped' && request.value === null) result = await service.isStopped();
        else if (request.op === 'recoverySafe' && request.value === null) result = await service.recoverySafe();
        else if (request.op === 'backendControl' && validBackendCommand(request.value)) result = await service.backendControl(request.value);
        else throw Error('service_supervisor_request_invalid');
        reply({ ok: true, incarnation, session, sequence, result });
      } catch (e) { reply({ ok: false, incarnation, session, sequence, error: publicError(e) }); }
      finally { busy = false; socket.setTimeout(10000); }
      // A disconnected controller does not cancel a spawn/stop or release the
      // global operation lock early. A new controller waits for it to settle.
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600); const original = await privatePath(socketPath, true); ready = true;
  return { incarnation,
    async close() {
      // A never-used supervisor may exit even if an unrelated listener owns
      // the app port. It must never signal or adopt that listener.
      if (busy || (service.canDetach ? service.canDetach() !== true : await service.isStopped() !== true)) throw Error('service_supervisor_stop_required');
      ready = false;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      try { const now = await lstat(socketPath); if (now.ino === original.ino && now.dev === original.dev) await unlink(socketPath); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
  };
}

// Persistent, exclusive controller channel. Losing it never retries a state-
// changing operation: the outcome is unknown and must be reconciled by the
// manager journal plus a freshly acquired coordinator lease.
export class SupervisedUpdateService {
  constructor({ socketPath, capabilityFile, timeout = 120000 }) {
    if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 103 || !path.isAbsolute(capabilityFile)
      || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000) throw Error('service_supervisor_configuration_invalid');
    this.socketPath = socketPath; this.capabilityFile = capabilityFile; this.timeout = timeout;
    this.socket = null; this.pending = null; this.sequence = 0; this.connecting = null;
    this.incarnation = null; this.session = null; this.heartbeat = null; this.queue = Promise.resolve();
    Object.defineProperty(this, 'requiredStartupProtocol', { value: 1 });
  }
  disconnect() {
    clearInterval(this.heartbeat); this.heartbeat = null;
    this.socket?.destroy(); this.socket = null;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(Error('service_supervisor_outcome_unknown')); this.pending = null; }
  }
  async connect() {
    if (this.socket && !this.socket.destroyed && this.session) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try { await this.connecting; } finally { this.connecting = null; }
  }
  async open() {
    await privatePath(this.socketPath, true);
    const capability = await supervisorCapability(this.capabilityFile);
    this.session = null; this.sequence = 0;
    const socket = net.createConnection(this.socketPath); this.socket = socket;
    let buffer = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.once('close', () => { if (this.socket === socket) this.disconnect(); });
    socket.on('data', chunk => {
      if (buffer.length + chunk.length > 8192) { this.disconnect(); return; }
      buffer = Buffer.concat([buffer, chunk]); const newline = buffer.indexOf(10);
      if (newline < 0) return;
      if (newline !== buffer.length - 1 || !this.pending) { this.disconnect(); return; }
      try {
        const reply = JSON.parse(buffer.subarray(0, newline).toString('utf8')); buffer = Buffer.alloc(0);
        if (!this.session) {
          if (!exact(reply, ['ok', 'incarnation', 'session']) || reply.ok !== true || !uuid(reply.incarnation) || !uuid(reply.session)) throw Error();
          this.incarnation = reply.incarnation; this.session = reply.session;
        } else if (!exact(reply, reply.ok === true ? ['ok', 'incarnation', 'session', 'sequence', 'result'] : ['ok', 'incarnation', 'session', 'sequence', 'error'])
          || reply.incarnation !== this.incarnation || reply.session !== this.session || reply.sequence !== this.sequence || typeof reply.ok !== 'boolean') throw Error();
        const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
        if (reply.ok === false) pending.reject(Error(publicError({ message: reply.error })));
        else pending.resolve(reply.result);
      } catch { this.disconnect(); }
    });
    await this.exchange({ op: 'hello', capability }, Math.min(this.timeout, 3000));
    this.heartbeat = setInterval(() => { if (!this.pending) void this.call('ping', null).catch(() => {}); }, 2000);
    this.heartbeat.unref();
  }
  exchange(request, timeout = this.timeout) {
    if (this.pending) return Promise.reject(Error('service_operation_in_progress'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.disconnect(), timeout);
      this.pending = { resolve, reject, timer };
      this.socket.write(JSON.stringify(request) + '\n', e => { if (e) this.disconnect(); });
    });
  }
  call(op, value) {
    // Serialize heartbeats with business commands: a heartbeat arriving just
    // before stop must not spuriously abort a valid installation transaction.
    const result = this.queue.then(async () => {
      await this.connect();
      return this.exchange({ op, incarnation: this.incarnation, session: this.session, sequence: ++this.sequence, value });
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async start(pointer) { const result = await this.call('start', Object.fromEntries(identityKeys.map(k => [k, pointer[k]]))); return result; }
  async stop({ allowed }) { if (await this.call('stop', allowed) !== true) throw Error('service_supervisor_response_invalid'); }
  async activate(pointer) { return this.call('activate', Object.fromEntries(identityKeys.map(k => [k, pointer[k]]))); }
  async isStopped() { const value = await this.call('isStopped', null); if (typeof value !== 'boolean') throw Error('service_supervisor_response_invalid'); return value; }
  async recoverySafe() { const value = await this.call('recoverySafe', null); if (typeof value !== 'boolean') throw Error('service_supervisor_response_invalid'); return value; }
  async backendControl(command) {
    if (!validBackendCommand(command)) throw Error('service_backend_request_invalid');
    const value = await this.call('backendControl', structuredClone(command));
    if (!validBackendEvidence(value)) throw Error('service_supervisor_response_invalid');
    return value;
  }
}
