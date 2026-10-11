import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readPrivateFile, writePrivateFile } from './runtime-paths.mjs';
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const taskId = v => uuid(v) || typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const domains = ['canvas', 'workbench', 'agent', 'webdav', 'storage'];

// Backend-owned durable write-ahead evidence. No task content, credentials,
// endpoints or browser database reads. A failed/lost completion stays pending;
// TTL, page close, server restart and an empty UI never remove evidence.
export class UpdateTaskLedger {
  constructor({ file, version, instance = randomUUID(), maximum = 4096 }) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || /[\x00-\x1f]/.test(file)
      || path.dirname(file) === path.parse(file).root || !uuid(instance) || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096) throw Error('task_ledger_invalid');
    this.file = file; this.version = version; this.instance = instance; this.maximum = maximum;
    this.queue = Promise.resolve(); this.frozen = false;
  }
  async read() {
    await this.validateParent();
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 1024 * 1024) throw Error('task_ledger_invalid');
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 1024 * 1024) throw Error('task_ledger_invalid');
      text = bytes.subarray(0, length).toString('utf8');
    } finally { await handle.close(); }
    const value = JSON.parse(text);
    if (!exact(value, ['format', 'revision', 'tasks']) || value.format !== 1 || !Number.isSafeInteger(value.revision)
      || value.revision < 0 || !Array.isArray(value.tasks) || value.tasks.length > this.maximum) throw Error('task_ledger_invalid');
    const ids = new Set();
    for (const row of value.tasks) {
      if (!exact(row, ['id', 'pageId', 'instance', 'domain', 'version']) || !taskId(row.id) || !uuid(row.pageId) || !uuid(row.instance)
        || !domains.includes(row.domain) || typeof row.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(row.version)
        || ids.has(row.id)) throw Error('task_ledger_invalid');
      ids.add(row.id);
    }
    return value;
  }
  async validateParent() {
    const parent = path.dirname(this.file), info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077
      || await realpath(parent) !== parent) throw Error('task_ledger_invalid');
  }
  async initialize() {
    await this.validateParent();
    // Only an absent ledger is seeded; corrupt/unknown existing evidence stays.
    const existing = await readPrivateFile(this.file, { maxBytes: 1024 * 1024 });
    if (existing === null) await writePrivateFile(this.file, JSON.stringify({ format: 1, revision: 0, tasks: [] }), { exclusive: true });
    await this.read();
  }
  serial(operation) {
    const next = this.queue.then(() => this.exclusive(operation)); this.queue = next.catch(() => {}); return next;
  }
  async exclusive(operation) {
    await this.validateParent();
    const file = this.file + '.lock';
    // A crashed writer's lock remains UNKNOWN. No timeout, stale PID guess or
    // cold startup can discard it and silently erase possibly in-flight work.
    const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const original = await handle.stat();
    try {
      await handle.writeFile(JSON.stringify({ instance: this.instance })); await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      const current = await lstat(file);
      if (current.ino === original.ino && current.dev === original.dev && !current.isSymbolicLink()) await unlink(file);
      const directory = await open(path.dirname(file), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  begin(value) {
    if (!exact(value, ['id', 'pageId', 'domain', 'version']) || !taskId(value.id) || !uuid(value.pageId)
      || !domains.includes(value.domain) || value.version !== this.version) return Promise.reject(Error('task_ledger_request_invalid'));
    const input = { ...value };
    return this.serial(async () => {
      if (this.frozen) throw Error('update_quiescing');
      const ledger = await this.read();
      const existing = ledger.tasks.find(row => row.id === input.id);
      // Restoration imports opaque remote evidence idempotently. Never
      // replace/reassign an old-instance row, and never grant completion for it.
      if (existing && /^[a-f0-9]{64}$/.test(input.id) && existing.domain === input.domain) {
        return { id: input.id, instance: existing.instance };
      }
      if (existing || ledger.tasks.length >= this.maximum || ledger.revision >= Number.MAX_SAFE_INTEGER - 1) throw Error('task_ledger_request_invalid');
      ledger.tasks.push({ ...input, instance: this.instance }); ledger.revision++;
      await writePrivateFile(this.file, JSON.stringify(ledger));
      if (!(await this.read()).tasks.some(row => row.id === input.id && row.instance === this.instance)) throw Error('task_ledger_commit_unconfirmed');
      return { id: input.id, instance: this.instance };
    });
  }
  complete(value) {
    if (!exact(value, ['id', 'instance']) || !taskId(value.id) || value.instance !== this.instance) return Promise.reject(Error('task_ledger_request_invalid'));
    const input = { ...value };
    return this.serial(async () => {
      const ledger = await this.read(), row = ledger.tasks.find(row => row.id === input.id);
      if (!row || row.instance !== this.instance || ledger.revision >= Number.MAX_SAFE_INTEGER - 1) throw Error('task_ledger_request_invalid');
      ledger.tasks = ledger.tasks.filter(row => row.id !== input.id); ledger.revision++;
      await writePrivateFile(this.file, JSON.stringify(ledger));
      if ((await this.read()).tasks.some(row => row.id === input.id)) throw Error('task_ledger_commit_unconfirmed');
    });
  }
  async snapshot() {
    return this.serial(async () => {
      const value = await this.read(); return { revision: value.revision, pending: value.tasks.length, frozen: this.frozen };
    });
  }
  async freeze(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw Error('task_ledger_request_invalid');
    return this.serial(async () => {
      const value = await this.read();
      if (this.frozen || value.tasks.length || value.revision !== revision) throw Error('task_ledger_busy');
      this.frozen = true;
    });
  }
  resume() { this.frozen = false; }
}
