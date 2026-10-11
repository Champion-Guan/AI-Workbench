import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { verifyStableRuntime } from '../../scripts/lib/stable-runtime.mjs';

// Homebrew's Node executable relies on a sibling libnode dylib and cannot be
// relocated alone. Prefer the already locally prepared official standalone
// runtime. CI setup-node itself supplies a standalone executable. No download.
export async function localRuntime() {
  const directory = fileURLToPath(new URL('../../output/stable-runtime/arm64/', import.meta.url));
  let prepared = false;
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    try { await access(directory); prepared = true; } catch {}
  }
  if (prepared) {
    const verified = await verifyStableRuntime(directory, 'arm64');
    return { file: directory + '/node', bytes: verified.bytes };
  }
  return { file: process.execPath, bytes: await readFile(process.execPath) };
}
