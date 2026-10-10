import { execFileSync } from 'node:child_process';
import { access, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
let configured = '';
try { configured = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
catch (error) { if (error.status !== 1) throw new Error('Unable to inspect Git hook configuration'); }
if (configured && configured !== '.githooks') throw new Error('Existing custom Git hooks retained; integrate scanner manually instead of replacing them.');
const activeHook = execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-commit'], { cwd: root }).toString().trim();
if (!configured) {
  let exists = false;
  try { await access(path.resolve(root, activeHook)); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) throw new Error('Existing pre-commit hook retained; integrate scanner manually instead of replacing it.');
}
await chmod(path.join(root, '.githooks/pre-commit'), 0o755);
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root });
console.log('Repository-local pre-commit secret scan enabled. No files staged or committed.');
