import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPrivateFile, writePrivateJson } from './runtime-paths.mjs';
import { CREDENTIAL_ACCOUNT } from './keychain-vault.mjs';
import { validRepository } from './stable-version.mjs';

const LEGACY_REPOSITORY = 'MrGuAm/guan-ai-workbench';

export class UpdateError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export class UpdateAuth {
  constructor({ directory, vault }) { this.file = path.join(directory, 'github-auth.json'); this.vault = vault; }
  async metadata() {
    try {
      const text = await readPrivateFile(this.file, { maxBytes: 4096 });
      if (text === null) return null;
      const v = JSON.parse(text);
      if (v.version !== 1 || !validRepository(v.repository) || !CREDENTIAL_ACCOUNT.test(v.account)
        || Object.keys(v).some(k => !['version', 'repository', 'account'].includes(k))) throw Error();
      return v;
    } catch { throw new UpdateError('auth_storage_invalid'); }
  }
  async token(repository) {
    const meta = await this.metadata();
    const sameRepository = meta && meta.repository.toLowerCase() === repository.toLowerCase();
    const renamedRepository = meta && meta.repository.toLowerCase() === LEGACY_REPOSITORY.toLowerCase()
      && repository.toLowerCase() === 'champion-guan/guan-ai-workbench';
    if (!sameRepository && !renamedRepository) throw new UpdateError('authorization_required');
    let value;
    try { value = await this.vault.read(meta.account); } catch { throw new UpdateError('keychain_unavailable'); }
    if (!value || !/^[A-Za-z0-9_]{20,255}$/.test(value)) throw new UpdateError('authorization_required');
    if (renamedRepository) await writePrivateJson(this.file, { version: 1, repository, account: meta.account });
    return value;
  }
  // CLI only. No browser route accepts, exports or returns the Token.
  async authorize(repository, token) {
    if (!validRepository(repository) || typeof token !== 'string' || !/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new UpdateError('invalid_authorization');
    await this.metadata(); // Preserve malformed old metadata; never replace it silently.
    const account = randomUUID();
    try {
      await this.vault.insert(account, token);
      if (await this.vault.read(account) !== token) throw Error();
      await writePrivateJson(this.file, { version: 1, repository, account });
    } catch { throw new UpdateError('authorization_save_failed'); }
    // Old accounts retained: no removal while an older process might use them.
    return { ok: true, repository, credentialStorage: 'macOS Keychain' };
  }
}
