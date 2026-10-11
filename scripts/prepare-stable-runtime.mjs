// Public upstream dependency only. Never copy a Homebrew executable with
// external dylib dependencies into a distributable package.
import { fetch, ProxyAgent } from 'undici';
import { mkdtemp, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { privateDirectory, writePrivateFile } from '../src/server/runtime-paths.mjs';
import { sha256 } from '../src/server/stable-manifest.mjs';
import { NODE_VERSION, machArchitecture, verifyStableRuntime } from './lib/stable-runtime.mjs';

async function bounded(url, limit) {
  let dispatcher;
  if (process.env.GUAN_BUILD_PROXY) {
    const proxy = new URL(process.env.GUAN_BUILD_PROXY);
    if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw Error('Only credential-free local build proxy accepted');
    dispatcher = new ProxyAgent(proxy.href);
  }
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000), ...(dispatcher ? { dispatcher } : {}) });
    if (response.status !== 200) throw Error('Official Node runtime unavailable');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > limit) throw Error('Runtime download exceeds limit'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  } finally { await dispatcher?.destroy().catch(() => {}); }
}
async function main() {
  const arch = process.argv[2];
  if (process.argv.length !== 3 || arch !== 'arm64') throw Error('Only arm64 is supported for future releases');
  const root = fileURLToPath(new URL('../', import.meta.url)), filename = `node-${NODE_VERSION}-darwin-${arch}.tar.gz`;
  const source = `https://nodejs.org/dist/${NODE_VERSION}/${filename}`;
  const sums = (await bounded(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, 65536)).toString('utf8');
  const entries = sums.split('\n').filter(line => line.endsWith('  ' + filename));
  if (entries.length !== 1 || !/^[a-f0-9]{64}  /.test(entries[0])) throw Error('Official checksum entry missing');
  const archive = await bounded(source, 100 * 1024 * 1024), archiveSha256 = sha256(archive);
  if (archiveSha256 !== entries[0].slice(0, 64)) throw Error('Official runtime checksum mismatch');
  const temporary = await mkdtemp(path.join(tmpdir(), 'guan-node-runtime-')); await chmod(temporary, 0o700);
  const archiveFile = path.join(temporary, 'official-node.tar.gz');
  try {
  await writePrivateFile(archiveFile, archive, { exclusive: true });
  // Read exactly two known members, never extract tar paths into the filesystem.
  const prefix = filename.replace(/\.tar\.gz$/, '');
  const node = execFileSync('/usr/bin/tar', ['-xOzf', archiveFile, prefix + '/bin/node'], { maxBuffer: 160 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const license = execFileSync('/usr/bin/tar', ['-xOzf', archiveFile, prefix + '/LICENSE'], { maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (machArchitecture(node) !== arch) throw Error('Official runtime architecture mismatch');
  const directory = path.join(root, 'output/stable-runtime', arch); await privateDirectory(directory);
  for (const [name, bytes] of [['node', node], ['LICENSE', license]]) {
    if (!await writePrivateFile(path.join(directory, name), bytes, { exclusive: true }) && !bytes.equals(await readFile(path.join(directory, name)))) throw Error('Existing runtime retained; conflicting input refused');
  }
  await chmod(path.join(directory, 'node'), 0o700);
  const metadata = { source, archiveSha256, nodeVersion: NODE_VERSION, arch, runtimeSha256: sha256(node), runtimeSize: node.length };
  const bytes = Buffer.from(JSON.stringify(metadata, null, 2) + '\n');
  if (!await writePrivateFile(path.join(directory, 'NODE-RUNTIME.json'), bytes, { exclusive: true }) && !bytes.equals(await readFile(path.join(directory, 'NODE-RUNTIME.json')))) throw Error('Existing runtime metadata retained');
  await verifyStableRuntime(directory, arch);
  console.log(JSON.stringify({ ok: true, arch, nodeVersion: NODE_VERSION, runtimeSha256: metadata.runtimeSha256 }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
main().catch(() => { console.error('Stable runtime preparation failed safely; check official Node connectivity and existing cache.'); process.exitCode = 1; });
