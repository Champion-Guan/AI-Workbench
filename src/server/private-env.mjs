import { readPrivateFile } from './runtime-paths.mjs';

// Legacy .env.local is imported copy-once by prepareRuntimePaths. Never merge
// it back into an existing private env: removing an old setting is intentional.
// Process-provided values retain the existing launcher override precedence.
export async function loadPrivateRuntimeEnv(file, target = process.env) {
  const source = await readPrivateFile(file, { maxBytes: 2 * 1024 * 1024 });
  if (source === null) return 0;
  let applied = 0;
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z\d_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in target) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    target[match[1]] = value;
    applied++;
  }
  return applied;
}
