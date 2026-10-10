import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

export const CREDENTIAL_ACCOUNT = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const codes = new Set(['item_exists', 'authorization_required', 'keychain_unavailable', 'invalid_request', 'invalid_value', 'invalid_secret', 'invalid_namespace']);
export class CredentialError extends Error {
  constructor(code = 'keychain_unavailable') { super(code); this.name = 'CredentialError'; this.code = code; }
}
export class MacKeychainVault {
  constructor({ executable, namespace = 'production', timeoutMs = 15000 } = {}) {
    if (!executable || !path.isAbsolute(executable) || !/^(?:production|qa-[a-f0-9-]{36})$/.test(namespace)) throw new CredentialError('invalid_request');
    this.executable = executable; this.namespace = namespace; this.timeoutMs = timeoutMs;
  }
  async invoke(action, account, secret) {
    if (!CREDENTIAL_ACCOUNT.test(account) || !['insert', 'read', 'remove'].includes(action)
      || action === 'insert' && (typeof secret !== 'string' || !secret || Buffer.byteLength(secret) > 16384 || secret.includes('\0'))) throw new CredentialError('invalid_request');
    const info = await lstat(this.executable).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o022) throw new CredentialError();
    const input = JSON.stringify({ action, account, namespace: this.namespace, ...(secret === undefined ? {} : { secret }) });
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = [];
      let bytes = 0, finished = false;
      const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new CredentialError()); }, this.timeoutMs);
      child.stderr.resume(); // Never return native logs, paths or original OS errors.
      child.stdin.on('error', () => finish(new CredentialError()));
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { child.kill('SIGKILL'); finish(new CredentialError()); }
        else chunks.push(chunk);
      });
      child.once('error', () => finish(new CredentialError()));
      child.once('close', code => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (code !== 0 || value.ok !== true) return finish(new CredentialError(codes.has(value.code) ? value.code : undefined));
          if (action === 'read' && value.value !== null && typeof value.value !== 'string') return finish(new CredentialError());
          finish(null, action === 'read' ? value.value : undefined);
        } catch { finish(new CredentialError()); }
      });
      child.stdin.end(input);
    });
  }
  insert(account, secret) { return this.invoke('insert', account, secret); }
  read(account) { return this.invoke('read', account); }
  remove(account) { return this.invoke('remove', account); }
}
