import path from 'node:path';
import { homedir } from 'node:os';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, cp, readdir, open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { privateDirectory, readPrivateFile, writePrivateFile } from './runtime-paths.mjs';
import { sha256 } from './stable-manifest.mjs';
import { verifyReleaseFiles } from '../../scripts/lib/release-validation.mjs';

const required = ['runtime/node', 'scripts/run-update-manager.mjs', 'scripts/run-update-supervisor.mjs', 'scripts/run-browser-bridge.mjs',
  'src/server/update-manager.mjs', 'src/server/update-supervisor.mjs', 'src/server/update-service.mjs'];
async function syncTree(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name), info = await lstat(file);
    if (info.isSymbolicLink()) throw Error('updater_runtime_invalid');
    if (info.isDirectory()) await syncTree(file);
    else if (info.isFile()) {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    } else throw Error('updater_runtime_invalid');
  }
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Independent immutable updater runtime, not installation/current or data.
// Preparation cannot stop/start jobs, replace an active pointer or install an
// app. A later authorized handoff may pin launchd to this verified directory.
export class SignedUpdaterRuntime {
  constructor({ directory, manager }) {
    if (!path.isAbsolute(directory || '') || path.resolve(directory) !== directory || /[\x00-\x1f]/.test(directory)
      || !manager?.verifyInstalled || !manager?.locked || !manager.dataRoot || !manager.root) throw Error('updater_runtime_invalid');
    this.directory = path.resolve(directory); this.manager = manager; this.busy = false;
    const inside = (a, b) => b === a || b.startsWith(a + path.sep);
    if ([path.parse(directory).root, homedir()].includes(directory)
      || [manager.root, manager.dataRoot].some(root => inside(root, this.directory) || inside(this.directory, root))) throw Error('updater_runtime_invalid');
  }
  async verify(pointer, directory) {
    const checked = await this.manager.verifyInstalled(pointer);
    if (checked.startupProtocol !== 1) throw Error('service_startup_protocol_incompatible');
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077
      || await realpath(directory) !== directory) throw Error('updater_runtime_invalid');
    const release = await readPrivateFile(path.join(directory, 'RELEASE.json'), { maxBytes: 32 * 1024 * 1024 });
    if (!release || sha256(Buffer.from(release)) !== checked.releaseSha256) throw Error('updater_runtime_invalid');
    const verified = await verifyReleaseFiles(directory, { trustedRuntime: checked.selected });
    if (verified.buildId !== pointer.buildId) throw Error('updater_runtime_invalid');
    const declared = JSON.parse(release).files;
    for (const relative of required) {
      if (!Object.hasOwn(declared, relative)) throw Error('updater_runtime_incomplete');
      const file = path.join(directory, relative), stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o022) throw Error('updater_runtime_invalid');
    }
    return { directory, pointer: Object.freeze({ ...pointer }), entry: path.join(directory, 'scripts/run-update-manager.mjs'),
      supervisorEntry: path.join(directory, 'scripts/run-update-supervisor.mjs'), node: path.join(directory, 'runtime/node') };
  }
  async prepare(pointer) {
    if (this.busy) throw Error('updater_runtime_busy');
    pointer = Object.freeze({ ...pointer });
    this.busy = true;
    try {
      return await this.manager.locked(async () => {
      // Identity was captured before awaits; verifier independently validates it.
      const checked = await this.manager.verifyInstalled(pointer);
      if (checked.startupProtocol !== 1) throw Error('service_startup_protocol_incompatible');
      await privateDirectory(this.directory);
      if (await realpath(this.directory) !== this.directory) throw Error('updater_runtime_invalid');
      const parent = await lstat(this.directory);
      if (parent.uid !== process.getuid() || parent.mode & 0o077) throw Error('updater_runtime_invalid');
      const destination = path.join(this.directory, pointer.id);
      try { await lstat(destination); return await this.verify(pointer, destination); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      // Validate required files before making the immutable copy. Old v1.0.4
      // remains verifiable but cannot bootstrap the independent updater.
      const release = JSON.parse(await readPrivateFile(path.join(checked.directory, 'RELEASE.json'), { maxBytes: 32 * 1024 * 1024 }));
      if (required.some(file => !Object.hasOwn(release.files, file))) throw Error('updater_runtime_incomplete');
      const temporary = path.join(this.directory, '.preparing-' + randomUUID());
      await mkdir(temporary, { mode: 0o700 });
      for (const name of await readdir(checked.directory)) await cp(path.join(checked.directory, name), path.join(temporary, name),
        { recursive: true, force: false, errorOnExist: true });
      await this.verify(pointer, temporary); await syncTree(temporary);
      // No merge/overwrite of another preparer's version. The manager's
      // process lock spans verification, copy and immutable rename.
      try { await lstat(destination); throw Error('updater_runtime_exists'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await rename(temporary, destination); await syncTree(this.directory);
      const value = await this.verify(pointer, destination);
      // Receipt is external to the exact signed tree; it never grants trust or
      // chooses an active runtime. Existing signed records remain untouched.
      await writePrivateFile(path.join(this.directory, pointer.id + '.prepared.json'), JSON.stringify({ format: 1, pointer }));
      return value;
      });
    } finally { this.busy = false; }
  }
}
