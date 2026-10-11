// Explicit developer acceptance setup, not a Stable updater bootstrap. It
// installs only an observational native host, with no credentials/install API.
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, lstat, mkdir, copyFile, chmod, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { verifyStableRuntime } from './lib/stable-runtime.mjs';
import { runtimePaths, writePrivateFile, readPrivateFile } from '../src/server/runtime-paths.mjs';

const quote = v => "'" + v.replaceAll("'", "'\\''") + "'";
async function main() {
  const [confirmation, extensionId] = process.argv.slice(2);
  if (process.argv.length !== 4 || confirmation !== 'INSTALL-READONLY-BRIDGE' || !/^[a-p]{32}$/.test(extensionId || '')
    || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error();
  const projectRoot = fileURLToPath(new URL('../', import.meta.url)), paths = runtimePaths({ projectRoot });
  // Never inherit an alternate data root for a browser host installation.
  if (process.env.GUAN_WORKBENCH_DATA_DIR) throw Error();
  const runtime = path.join(projectRoot, 'output/stable-runtime/arm64'); await verifyStableRuntime(runtime, 'arm64');
  const entries = ['scripts/run-browser-bridge.mjs', 'src/server/managed-browser-observation.mjs'];
  const contents = await Promise.all(entries.map(entry => readFile(path.join(projectRoot, entry))));
  const digest = createHash('sha256'); contents.forEach(value => digest.update(value));
  const directory = path.join(paths.updates, 'browser-bridge-qa', digest.digest('hex'));
  const manifestPath = path.join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.guanaiworkbench.browser.json');
  const chromeRoot = path.dirname(path.dirname(manifestPath)), chromeInfo = await lstat(chromeRoot);
  if (!chromeInfo.isDirectory() || chromeInfo.isSymbolicLink() || chromeInfo.uid !== process.getuid()
    || chromeInfo.mode & 0o022 || await realpath(chromeRoot) !== chromeRoot) throw Error();
  const launcher = path.join(directory, 'native-host');
  const manifest = JSON.stringify({ name: 'com.guanaiworkbench.browser', description: 'Guan readonly browser acceptance bridge',
    path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2) + '\n';
  // Check an existing host before writing anything. No silent override or
  // removal of a separately enrolled/installed native host.
  const previous = await readPrivateFile(manifestPath, { maxBytes: 4096 });
  if (previous !== null) { if (previous !== manifest) throw Error(); console.log(JSON.stringify({ alreadyInstalled: true, qaBridge: true, installAllowed: false })); return; }
  for (let i = 0; i < entries.length; i++) {
    const target = path.join(directory, entries[i]);
    const written = await writePrivateFile(target, contents[i], { exclusive: true });
    if (!written && !(await readFile(target)).equals(contents[i])) throw Error();
  }
  const node = path.join(directory, 'runtime/node'); await mkdir(path.dirname(node), { recursive: true, mode: 0o700 });
  try { await copyFile(path.join(runtime, 'node'), node, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); }
  catch (e) { if (e.code !== 'EEXIST') throw e;
    const info = await lstat(node);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()
      || !createHash('sha256').update(await readFile(node)).digest().equals(createHash('sha256').update(await readFile(path.join(runtime, 'node'))).digest())) throw Error();
  }
  await chmod(node, 0o700);
  const command = `#!/bin/sh\nexec ${quote(node)} ${quote(path.join(directory, 'scripts/run-browser-bridge.mjs'))} "$@"\n`;
  const written = await writePrivateFile(launcher, command, { exclusive: true });
  if (!written && await readPrivateFile(launcher, { maxBytes: 4096 }) !== command) throw Error();
  await chmod(launcher, 0o700);
  // Narrow, per-extension origin. NativeMessagingHosts is a Chrome-owned
  // folder; adding this single manifest does not edit Chrome Preferences.
  const hostDirectory = path.dirname(manifestPath);
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
  const hostInfo = await lstat(hostDirectory);
  if (!hostInfo.isDirectory() || hostInfo.isSymbolicLink() || hostInfo.uid !== process.getuid()
    || hostInfo.mode & 0o022 || await realpath(hostDirectory) !== hostDirectory) throw Error();
  const handle = await open(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(manifest); await handle.sync(); } finally { await handle.close(); }
  const parentHandle = await open(hostDirectory, constants.O_RDONLY);
  try { await parentHandle.sync(); } finally { await parentHandle.close(); }
  console.log(JSON.stringify({ extensionId, manifestPath, qaBridge: true, credentialsAccess: false, installAllowed: false }));
}
main().catch(() => { console.error('Readonly browser bridge setup refused; existing host and browser data were not overwritten.'); process.exitCode = 1; });
