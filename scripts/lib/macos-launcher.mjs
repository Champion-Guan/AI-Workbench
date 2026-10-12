import path from 'node:path';
import { mkdir, lstat, readFile, chmod, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writePrivateFile, readPrivateFile } from '../../src/server/runtime-paths.mjs';
import { UserLaunchdJobs } from '../../src/server/update-deployment.mjs';

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const shell = value => "'" + value.replaceAll("'", "'\\''") + "'";
export class PortableLaunchdJobs extends UserLaunchdJobs {
  target(label) {
    if (label !== 'com.guanaiworkbench.portable' && !/^com\.guanaiworkbench\.portable\.qa\.[a-f0-9-]{36}$/.test(label)) throw Error('portable_label_invalid');
    return this.domain + '/' + label;
  }
  async resume(label, descriptor) {
    if (!await this.inspect(label, descriptor)) throw Error('portable_job_absent');
    const { stdout } = await this.command(['print', this.target(label)]);
    if (/^\s*pid = [1-9][0-9]*\s*$/m.test(stdout)) return;
    // No -k: start an exited owned job without terminating an active service.
    await this.run('/bin/launchctl', ['kickstart', this.target(label)], {
      timeout: 40000, maxBuffer: 65536, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
  }
}
export function portableDescriptor({ node, root, privateRoot, agents, logs, port = 8888, label = 'com.guanaiworkbench.portable' }) {
  if (![node, root, privateRoot, agents, logs].every(value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value))
    || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('portable_paths_invalid');
  const entry = path.join(root, 'server.mjs'), plist = path.join(agents, label + '.plist');
  const bytes = `<?xml version="1.0"?><plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>GUAN_WORKBENCH_DATA_DIR</key><string>${xml(privateRoot)}</string><key>PORT</key><string>${port}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'portable.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'portable-error.log'))}</string>
</dict></plist>\n`;
  return { node, entry, directory: root, plist, bytes };
}
export async function startPortableJob({ descriptor, jobs, label = 'com.guanaiworkbench.portable' }) {
  const old = await readPrivateFile(descriptor.plist, { maxBytes: 16384 });
  if (old !== null && old !== descriptor.bytes) throw Error('portable_installation_conflict');
  if (old === null && !await writePrivateFile(descriptor.plist, descriptor.bytes, { exclusive: true })) throw Error('portable_installation_conflict');
  if (!await jobs.inspect(label, descriptor)) await jobs.start(label, descriptor);
  else await jobs.resume(label, descriptor);
}
export async function desktopShortcut({ desktop, node, root }) {
  const destination = path.join(desktop, 'AI-Workbench.app');
  // Existing unrelated desktop entries are never replaced. An existing app
  // from this project remains usable and opens an already-running workbench.
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()
      || await readFile(path.join(destination, 'Contents/guan-workbench-shortcut'), 'utf8') !== 'AI-Workbench desktop launcher\n') throw Error('desktop_shortcut_conflict');
    return { path: destination, created: false };
  } catch (error) { if (error.code !== 'ENOENT') throw error;
    // ENOENT inside an existing unrelated bundle must not permit a merge.
    try { await lstat(destination); throw Error('desktop_shortcut_conflict'); } catch (check) { if (check.code !== 'ENOENT') throw check; }
  }
  const temporary = path.join(desktop, '.AI-Workbench-' + randomUUID() + '.app');
  await mkdir(path.join(temporary, 'Contents/MacOS'), { recursive: true, mode: 0o700 });
  await writePrivateFile(path.join(temporary, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.guanaiworkbench.desktop</string><key>CFBundleName</key><string>AI-Workbench</string><key>CFBundleExecutable</key><string>launch</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>\n`);
  await writePrivateFile(path.join(temporary, 'Contents/guan-workbench-shortcut'), 'AI-Workbench desktop launcher\n');
  await writePrivateFile(path.join(temporary, 'Contents/MacOS/launch'), `#!/bin/sh\nexec ${shell(node)} ${shell(path.join(root, 'scripts/start-macos.mjs'))}\n`);
  await chmod(path.join(temporary, 'Contents/MacOS/launch'), 0o700);
  // Do not rename over an existing entry.
  try { await lstat(destination); throw Error('desktop_shortcut_conflict'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(temporary, destination);
  return { path: destination, created: true };
}
