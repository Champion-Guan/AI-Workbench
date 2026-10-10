import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPrivateFile, writePrivateFile } from '../../src/server/runtime-paths.mjs';

// A legacy in-memory subscription cannot be recovered from default-proxy.yaml.
// Capture only the actual, still-running owned core's applied YAML. This is a
// private checkpoint, not proof of task idleness and not an install permission.
export async function captureRuntimeHandoff({ projectRoot, port = 5174, output, inspect, fetchStatus }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid handoff port');
  const origin = `http://127.0.0.1:${port}`;
  const before = await inspect(port);
  if (path.resolve(before.cwd) !== path.resolve(projectRoot) || !before.serverEntryVerified || !before.configFile || !Number.isInteger(before.pid) || !Number.isInteger(before.supervisorPid)) throw new Error('Legacy service identity/config not proven');
  const status = await fetchStatus(origin);
  if (status.running !== true || typeof status.relayEnabled !== 'boolean' || typeof status.configName !== 'string') throw new Error('Running proxy config cannot be captured safely');
  const config = await readPrivateFile(before.configFile);
  if (!config?.trim() || Buffer.byteLength(config) > 10 * 1024 * 1024) throw new Error('Active proxy config missing or oversized');
  const after = await inspect(port), finalStatus = await fetchStatus(origin);
  if (before.pid !== after.pid || before.supervisorPid !== after.supervisorPid || before.configFile !== after.configFile || !after.serverEntryVerified || path.resolve(after.cwd) !== path.resolve(projectRoot)
    || status.running !== finalStatus.running || status.relayEnabled !== finalStatus.relayEnabled || status.configName !== finalStatus.configName
    || config !== await readPrivateFile(after.configFile)) throw new Error('Live configuration changed during capture; retry without replacing existing data');
  const record = { app: 'guan-ai-workbench', kind: 'private-runtime-handoff', format: 1, capturedAt: new Date().toISOString(),
    origin, legacyPid: before.pid, identity: 'cwd-entry-supervisor-verified', activityVerified: false, installAllowed: false,
    configSha256: createHash('sha256').update(config).digest('hex'),
    proxy: { version: 1, enabled: true, relayEnabled: status.relayEnabled,
      source: { kind: 'text', value: config }, cachedConfig: config, configName: status.configName.slice(0, 200) },
    limitations: ['Original subscription URL is not exported by the legacy server; applied YAML is preserved instead.', 'No production data changed. Tasks/Agent/WebDAV still require authoritative idle verification.'] };
  if (Buffer.byteLength(JSON.stringify(record.proxy, null, 2)) > 24 * 1024 * 1024) throw new Error('Captured proxy state exceeds runtime safe size limit');
  if (output) {
    if (!path.isAbsolute(output)) throw new Error('Handoff output must be an absolute private path');
    const parent = path.dirname(output), info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Handoff parent must already be a private 0700 directory');
    const canonicalParent = await realpath(parent), canonicalProject = await realpath(projectRoot);
    const relative = path.relative(canonicalProject, canonicalParent);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Private handoff cannot be written inside source tree');
    if (!await writePrivateFile(output, JSON.stringify(record, null, 2), { exclusive: true })) throw new Error('Existing handoff retained; choose a new output file');
  }
  return { ok: true, origin, legacyPid: before.pid, proxyCaptured: true, relayEnabled: status.relayEnabled,
    configSha256: record.configSha256, saved: Boolean(output), activityVerified: false, installAllowed: false };
}
