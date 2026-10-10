import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const literalRules = [
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]{4,}@/g],
  ['literal-credential', /(?:["'](?:api_?key|access_?token|refresh_?token|password|secret)["']|\b(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|GITHUB_TOKEN|GH_TOKEN|password|secret))\s*[:=]\s*["']([A-Za-z0-9_+/=.-]{16,})["']/gi],
  // Generic GUIDs occur in Office/vendor code; YAML proxy fields are scoped.
  ['proxy-uuid', /^\s*(?:-\s*)?uuid\s*:\s*["']?(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{32})(?=["'\s,}]|$)/gmi],
  ['configuration-credential', /^\s*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|GITHUB_TOKEN|GH_TOKEN|password|secret|uuid)\s*[:=]\s*([A-Za-z0-9_+/=.-]{16,})\s*(?:#.*)?$/gmi],
  ['bearer-credential', /["'](?:Bearer|bearer) [A-Za-z0-9._-]{20,}["']/g],
];
function safePath(file) {
  return file.replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, '<redacted>');
}
export function privatePath(file) {
  const normalized = file.split(path.sep).join('/').replace(/^\.\//, '');
  if (normalized === 'config/examples/default-proxy.yaml') return false;
  const base = path.posix.basename(normalized);
  if (/^\.env(?:\.|$)/.test(base) && !/\.(?:example|sample)$/.test(base)) return true;
  return /(?:^|\/)(?:personal-config|user-data|proxy-runtime|backups)(?:\/|$)/.test(normalized)
    || normalized === 'config/default-proxy.yaml' || normalized === '.image-relay-transports.json'
    || /(?:\.key|\.pem|\.personal\.zip|\-personal\-.*\.zip)(?:\.sha256)?$/.test(base);
}
export function scanContent(file, content) {
  const findings = [], filename = safePath(file);
  const report = (rule, line = 1) => findings.push({ file: filename, line, rule });
  if (privatePath(file)) report('private-runtime-file');
  if (content.byteLength > MAX_SCAN_BYTES) { report('scan-size-limit'); return findings; }
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : new TextDecoder().decode(content);
  for (const [rule, expression] of literalRules) {
    expression.lastIndex = 0;
    let match, count = 0;
    while ((match = expression.exec(text)) && count++ < 100) report(rule, text.slice(0, match.index).split('\n').length);
  }
  if (/^\s*\{/.test(text)) {
    try {
      const object = JSON.parse(text);
      if (object?.app === 'guan-ai-workbench' && object?.kind === 'full-browser-backup') report('browser-data-backup');
      if (object?.app === 'guan-ai-workbench' && object?.kind === 'private-runtime-handoff') report('private-runtime-handoff');
      if (object?.edition === 'personal-private') report('personal-release');
      const pending = [object];
      while (pending.length) {
        const current = pending.pop();
        if (!current || typeof current !== 'object') continue;
        if (['vmess', 'vless', 'tuic'].includes(current.type) && typeof current.uuid === 'string' && current.uuid.length >= 16) report('proxy-uuid');
        for (const [key, value] of Object.entries(current)) {
          if (/^(?:api_?key|access_?token|refresh_?token|password|secret)$/i.test(key) && typeof value === 'string' && /^[A-Za-z0-9_+/=.-]{16,}$/.test(value)) report('json-credential');
          if (value && typeof value === 'object') pending.push(value);
        }
      }
    } catch {}
  }
  return findings;
}
export async function scanDirectory(root) {
  const findings = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      const info = await lstat(file);
      if (info.isSymbolicLink()) { findings.push({ file: safePath(relative), line: 1, rule: 'symlink-not-scanned' }); continue; }
      if (info.isDirectory()) await visit(file);
      else if (!info.isFile()) findings.push({ file: safePath(relative), line: 1, rule: 'special-file-not-scanned' });
      else if (info.size > MAX_SCAN_BYTES) findings.push({ file: safePath(relative), line: 1, rule: 'scan-size-limit' });
      else findings.push(...scanContent(relative, await readFile(file)));
    }
  }
  await visit(path.resolve(root));
  return findings;
}
const git = (root, args, options = {}) => execFileSync('git', args, { cwd: root, maxBuffer: MAX_SCAN_BYTES + 1024, ...options });
export async function scanWorkingTree(root) {
  const names = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  const findings = [];
  for (const name of new Set(names)) {
    let info;
    try { info = await lstat(path.join(root, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) findings.push({ file: safePath(name), line: 1, rule: 'nonregular-file-not-scanned' });
    else if (info.size > MAX_SCAN_BYTES) findings.push({ file: safePath(name), line: 1, rule: 'scan-size-limit' });
    else findings.push(...scanContent(name, await readFile(path.join(root, name))));
  }
  return { scanned: names.length, findings };
}
export function scanStaged(root) {
  const names = git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).toString().split('\0').filter(Boolean);
  const findings = [];
  for (const name of names) {
    const spec = `:${name}`, size = Number(git(root, ['cat-file', '-s', spec]).toString());
    const mode = git(root, ['ls-files', '--stage', '-z', '--', name]).toString().split(' ')[0];
    if (mode !== '100644' && mode !== '100755') { findings.push({ file: safePath(name), line: 1, rule: 'nonregular-file-not-scanned' }); continue; }
    if (size > MAX_SCAN_BYTES) { findings.push({ file: safePath(name), line: 1, rule: 'scan-size-limit' }); continue; }
    findings.push(...scanContent(name, git(root, ['show', spec])));
  }
  return { scanned: names.length, findings };
}
export function scanHistory(root) {
  const objects = git(root, ['rev-list', '--objects', '--all']).toString().trim().split('\n').filter(Boolean).map(line => {
    const space = line.indexOf(' ');
    return { oid: space < 0 ? line : line.slice(0, space), name: space < 0 ? '(historical-blob)' : line.slice(space + 1) };
  });
  if (!objects.length) return { scanned: 0, findings: [] };
  const metadata = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: objects.map(object => object.oid).join('\n') + '\n' }).toString().trim().split('\n');
  const findings = [];
  let scanned = 0;
  for (let index = 0; index < metadata.length; index++) {
    const [oid, type, rawSize] = metadata[index].split(' ');
    if (type !== 'blob') continue;
    scanned++;
    const name = objects[index].name;
    const results = Number(rawSize) > MAX_SCAN_BYTES ? [{ file: safePath(name), line: 1, rule: 'scan-size-limit' }]
      : scanContent(name, git(root, ['cat-file', 'blob', oid]));
    findings.push(...results.map(result => ({ ...result, object: oid })));
  }
  return { scanned, findings };
}
