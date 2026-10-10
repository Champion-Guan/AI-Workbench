import { mkdir, chmod, rename, lstat, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin' || process.argv.length !== 2) throw Error('Native macOS build only; no arbitrary compiler options accepted');
const output = path.join(root, 'output/native');
await mkdir(output, { recursive: true, mode: 0o700 });
const source = path.join(root, 'src/native/keychain-helper.swift');
const sourceBefore = await readFile(source);
const temporary = path.join(output, 'keychain-helper-' + randomUUID());
const binary = path.join(output, 'guan-keychain');
try {
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/swiftc', ['-O', source, '-o', temporary], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume(); child.once('error', () => reject(Error('Native helper compiler unavailable')));
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Native helper compile failed; no credentials accessed')));
  });
  await chmod(temporary, 0o700);
  if (!sourceBefore.equals(await readFile(source))) throw Error('Native source changed during build; build again');
  try { const info = await lstat(binary); if (!info.isFile() || info.isSymbolicLink()) throw Error('Unsafe native build destination'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(temporary, binary);
  const manifest = { app: 'guan-ai-workbench', arch: process.arch, platform: 'darwin', unsigned: true,
    sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'),
    binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex') };
  await writeFile(path.join(output, 'KEYCHAIN-BUILD.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, arch: process.arch, unsigned: true, keychainAccessed: false }));
} finally { await unlink(temporary).catch(() => undefined); }
