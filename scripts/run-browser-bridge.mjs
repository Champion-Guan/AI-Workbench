import { ManagedBrowserObservation } from '../src/server/managed-browser-observation.mjs';

// Chrome Native Messaging framing. No TCP/HTTP, commands, credentials,
// filesystem paths or installation control. Installed manifests must restrict
// allowed_origins to the explicitly enrolled extension id, not wildcards.
const origin = process.argv[2];
if (process.argv.length !== 3 || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin || '')) {
  process.stderr.write('Browser bridge refused an invalid native origin.\n'); process.exit(1);
}
const observation = new ManagedBrowserObservation();
let buffer = Buffer.alloc(0), closing = false;
function stop() { if (closing) return; closing = true; process.stdin.destroy(); process.exitCode = 1; }
function reply(value) {
  const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  if (bytes.length > 4096 || process.stdout.writableLength > 8192) { stop(); return; }
  process.stdout.write(Buffer.concat([header, bytes]));
}
process.stdin.on('data', chunk => {
  if (closing || buffer.length + chunk.length > 65540) { stop(); return; }
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE();
    if (size < 1 || size > 65536) { stop(); return; }
    if (buffer.length < size + 4) break;
    const bytes = buffer.subarray(4, size + 4); buffer = buffer.subarray(size + 4);
    try { reply(observation.accept(JSON.parse(bytes.toString('utf8')))); } catch { stop(); return; }
  }
});
process.stdin.on('error', stop); process.stdout.on('error', stop);
process.stdin.on('end', () => { if (buffer.length) stop(); });
