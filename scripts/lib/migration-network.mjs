import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPrivateFile } from '../../src/server/runtime-paths.mjs';

export function localProxy(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && url.port) return url.origin;
  } catch { /* Unknown/protected proxy values are never printed or forwarded. */ }
  return null;
}
export async function migrationNetworks(paths, { execute = promisify(execFile), read = readPrivateFile, env = process.env } = {}) {
  const candidates = [];
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) candidates.push(localProxy(env[key]));
  const config = await read(path.join(paths.data, 'config/runtime.env'), { maxBytes: 1024 * 1024 });
  const configured = /^IMAGE_RELAY_PROXY_URL\s*=\s*["']?([^\r\n"']+)/m.exec(config || '')?.[1]?.trim();
  candidates.push(localProxy(configured));
  try {
    const { stdout } = await execute('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
    for (const kind of ['HTTPS', 'HTTP']) {
      if (new RegExp(`\\b${kind}Enable\\s*:\\s*1\\b`).test(stdout)) {
        const host = new RegExp(`\\b${kind}Proxy\\s*:\\s*(\\S+)`).exec(stdout)?.[1];
        const port = new RegExp(`\\b${kind}Port\\s*:\\s*([0-9]+)`).exec(stdout)?.[1];
        candidates.push(localProxy(`http://${host}:${port}`));
      }
    }
  } catch { /* No system HTTP proxy is a normal case. */ }
  const state = await read(path.join(paths.data, 'proxy/state.json'), { maxBytes: 65536 });
  if (state) {
    try {
      if (JSON.parse(state).enabled === true) {
        const profile = await read(path.join(paths.data, 'proxy/profile.yaml'), { maxBytes: 4 * 1024 * 1024 });
        const port = /^mixed-port:\s*([0-9]+)\s*$/m.exec(profile || '')?.[1];
        if (port) candidates.push(localProxy(`http://127.0.0.1:${port}`));
      }
    } catch { /* Invalid optional proxy discovery cannot modify configuration. */ }
  }
  return [undefined, ...new Set(candidates.filter(Boolean))];
}
