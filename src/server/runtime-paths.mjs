import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function runtimePaths({ projectRoot, env = process.env, home = homedir(), os = platform() } = {}) {
  const base = os === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : os === 'win32' ? (env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : path.join(home, '.local', 'share');
  const requested = env.GUAN_WORKBENCH_DATA_DIR?.trim();
  if (requested && !path.isAbsolute(requested)) throw new Error('私人运行目录必须是绝对路径');
  const root = path.resolve(requested || path.join(base, 'GuanAIWorkbench'));
  if (root === path.parse(root).root || root === path.resolve(home) || (projectRoot && inside(path.resolve(projectRoot), root))) {
    throw new Error('私人运行目录不能是系统根目录、用户主目录或项目目录');
  }
  const data = path.join(root, 'data');
  return Object.freeze({ root, data, config: path.join(data, 'config'), proxy: path.join(data, 'proxy'),
    runtime: path.join(data, 'runtime'), logs: path.join(root, 'logs'), backups: path.join(root, 'backups'),
    updates: path.join(root, 'updates'), proxyCore: path.join(data, 'proxy', 'core'),
    envFile: path.join(data, 'config', 'runtime.env'), proxyConfigFile: path.join(data, 'proxy', 'profile.yaml'),
    proxyStateFile: path.join(data, 'proxy', 'state.json'), transportsFile: path.join(data, 'runtime', 'image-relay-transports.json'),
  });
}

export async function privateDirectory(directory) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('私人运行目录类型异常，已停止操作');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('私人运行目录类型异常，已停止操作');
  }
  await chmod(directory, 0o700);
}

export async function readPrivateFile(file, { maxBytes } = {}) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('私人配置文件类型异常');
    if (maxBytes !== undefined) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || info.size > maxBytes) throw new Error('私人配置文件超过安全读取限制');
      const chunks = []; let bytes = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(65536, maxBytes - bytes + 1));
        const { bytesRead } = await handle.read(chunk);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > maxBytes) throw new Error('私人配置文件超过安全读取限制');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('无法安全读取私人配置，原文件已保留');
  } finally { await handle?.close(); }
}

export async function writePrivateFile(file, value, { exclusive = false } = {}) {
  await privateDirectory(path.dirname(file));
  try {
    const existing = await lstat(file);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('私人配置文件类型异常');
    if (exclusive) return false;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(file), `.private-write-${randomUUID()}`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    if (exclusive) {
      try { await link(temporary, file); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    } else {
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('私人配置文件类型异常');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(temporary, file);
    }
    await chmod(file, 0o600);
    const directory = await open(path.dirname(file), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function seed(source, destination) {
  if (await readPrivateFile(destination) !== null) { await chmod(destination, 0o600); return false; }
  const value = await readPrivateFile(source);
  return value === null ? false : writePrivateFile(destination, value, { exclusive: true });
}

// Copy-once compatibility: never move/delete legacy files or overwrite user data.
export async function prepareRuntimePaths(projectRoot, options = {}) {
  const paths = runtimePaths({ projectRoot, ...options });
  for (const directory of [paths.root, paths.data, paths.config, paths.proxy, paths.runtime, paths.proxyCore, paths.logs, paths.backups, paths.updates]) {
    await privateDirectory(directory);
  }
  await seed(path.join(projectRoot, '.env.local'), paths.envFile);
  const copiedProfile = await seed(path.join(projectRoot, 'config', 'default-proxy.yaml'), paths.proxyConfigFile);
  const copiedTransports = await seed(path.join(projectRoot, '.image-relay-transports.json'), paths.transportsFile);
  if (await readPrivateFile(paths.proxyConfigFile) === null) {
    await seed(path.join(projectRoot, 'config', 'examples', 'default-proxy.yaml'), paths.proxyConfigFile);
  }
  return { paths, copiedProfile, copiedTransports };
}

export async function readProxyState(file) {
  const text = await readPrivateFile(file);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    if (value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.relayEnabled !== 'boolean') throw new Error();
    if (value.source !== null && (!['text', 'url'].includes(value.source?.kind) || typeof value.source?.value !== 'string' || !value.source.value.trim())) throw new Error();
    if (value.source?.kind === 'url' && !/^https?:\/\//i.test(value.source.value)) throw new Error();
    if (typeof value.configName !== 'string' || (value.cachedConfig != null && typeof value.cachedConfig !== 'string') || Buffer.byteLength(text) > 24 * 1024 * 1024) throw new Error();
    return { version: 1, enabled: value.enabled, relayEnabled: value.relayEnabled,
      source: value.source ? { kind: value.source.kind, value: value.source.value } : null,
      cachedConfig: value.cachedConfig || null, configName: value.configName.slice(0, 200) };
  } catch { throw new Error('私人代理状态损坏，已保留原文件；请先备份后修复，未使用默认配置覆盖'); }
}

// Serialize snapshots: concurrent toggles/route learning must not restore an older value.
const writes = new Map();
export function writePrivateJson(file, value) {
  const serialized = JSON.stringify(value, null, 2);
  const previous = writes.get(file) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writePrivateFile(file, serialized));
  writes.set(file, next);
  return next.finally(() => { if (writes.get(file) === next) writes.delete(file); });
}

export async function flushPrivateWrites() { await Promise.all([...writes.values()]); }
