import { runWithActivity } from './activity-gate.mjs';

// Evidence only. No browser-accessible freeze/resume/delete/install route.
export function createUpdateTaskHttpHandler({ ledger, origin, ready = true, activityGate }) {
  const parsed = new URL(origin);
  if (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'http:' || parsed.origin !== origin) throw Error('task_http_invalid');
  return async (request, response) => {
    const pathname = new URL(request.url || '/', origin).pathname;
    if (!pathname.startsWith('/local-app/update-tasks/')) return false;
    const answer = (status, body) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (request.headers.host !== parsed.host || request.headers.origin !== origin
      || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
      answer(403, { error: 'task_request_forbidden' }); return true;
    }
    if (!['/local-app/update-tasks/begin', '/local-app/update-tasks/complete'].includes(pathname)) {
      answer(404, { error: 'task_route_unavailable' }); return true;
    }
    if (request.method !== 'POST') { answer(405, { error: 'task_method_invalid' }); return true; }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      answer(415, { error: 'task_content_type_invalid' }); return true;
    }
    if (!ready) { answer(503, { error: 'task_evidence_unavailable' }); return true; }
    let timer;
    try {
      const text = await new Promise((resolve, reject) => {
        const chunks = []; let bytes = 0, finished = false;
        const finish = (error, value) => {
          if (finished) return;
          finished = true; clearTimeout(timer);
          request.off('data', data); request.off('end', end); request.off('error', errorEvent); request.off('aborted', aborted);
          if (error) { request.resume(); reject(error); } else resolve(value);
        };
        const data = chunk => { bytes += chunk.length; if (bytes > 2048) finish(Error()); else chunks.push(chunk); };
        const end = () => finish(null, Buffer.concat(chunks).toString('utf8'));
        const errorEvent = () => finish(Error());
        const aborted = () => finish(Error());
        request.on('data', data); request.once('end', end); request.once('error', errorEvent); request.once('aborted', aborted);
        timer = setTimeout(() => finish(Error()), 5000);
      });
      const value = JSON.parse(text);
      if (pathname.endsWith('/begin')) {
        const begin = () => ledger.begin(value);
        const result = activityGate ? await runWithActivity(activityGate, 'storage', begin) : await begin();
        answer(200, { ok: true, ...result });
      } else {
        await ledger.complete(value); answer(200, { ok: true });
      }
    } catch {
      answer(409, { error: 'task_evidence_unconfirmed' });
    } finally { clearTimeout(timer); }
    return true;
  };
}
