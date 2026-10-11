import net from 'node:net';
import path from 'node:path';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { privateDirectory } from './runtime-paths.mjs';
import { parseVersion } from './stable-version.mjs';

const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
// User-owned Unix socket, not TCP, not HTTP and not reachable from a browser.
// No arbitrary paths, commands, URLs, tokens, deletion or installation verbs.
export async function serveUpdateManager({ manager, socketPath, downloadsDirectory }) {
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 103 || !path.isAbsolute(downloadsDirectory)) throw Error('update_socket_invalid');
  await privateDirectory(path.dirname(socketPath));
  try { await lstat(socketPath); throw Error('update_socket_exists'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const sockets = new Set();
  let ready = false, active = 0;
  // A client may half-close its request after the newline. Keep the response
  // side open while the admitted async inspection/staging operation completes.
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    if (!ready || sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let chunks = [], count = 0, handled = false;
    socket.on('data', async chunk => {
      if (handled) { socket.destroy(); return; }
      count += chunk.length;
      if (count > 2048) { socket.destroy(); return; }
      chunks.push(chunk);
      const raw = Buffer.concat(chunks), newline = raw.indexOf(10);
      if (newline < 0) return;
      handled = true; chunks = []; socket.pause();
      if (newline !== raw.length - 1 || active >= 4) { socket.end('{"ok":false,"error":"update_request_invalid"}\n'); return; }
      active++;
      try {
        const input = JSON.parse(raw.subarray(0, newline).toString('utf8'));
        let result;
        if (exact(input, ['op']) && input.op === 'status') result = manager.inspectStatus ? await manager.inspectStatus() : manager.status();
        else if (exact(input, ['op', 'downloadId', 'version']) && input.op === 'stage'
          && typeof input.downloadId === 'string' && /^verified-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.downloadId)
          && parseVersion(input.version) && !parseVersion(input.version).pre.length) {
          const directory = path.join(downloadsDirectory, input.downloadId);
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink()) throw Error();
          // Input admission has completed. Verification/extraction can take
          // longer than the five-second input deadline; client has its own
          // total bounded operation deadline. Manager locking prevents overlap.
          socket.setTimeout(0);
          result = await manager.stage({ directory, version: input.version });
        } else throw Error();
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch { socket.end('{"ok":false,"error":"update_request_failed"}\n'); }
      finally { active--; }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  const original = await lstat(socketPath); ready = true;
  return {
    async close() {
      ready = false;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      // Closing the server may already remove its socket. Never remove a
      // replacement socket belonging to another process.
      try { const now = await lstat(socketPath); if (now.ino === original.ino && now.dev === original.dev) await unlink(socketPath); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
  };
}
