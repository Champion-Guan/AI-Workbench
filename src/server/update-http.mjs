import { UpdateError } from './update-auth.mjs';
export function createUpdateHttpHandler({ updates, origin, activityGate }) {
  const reply = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
  return async (req, res) => {
    if (!req.url?.startsWith('/local-app/updates')) return false;
    if (req.headers.host !== new URL(origin).host || req.headers.origin !== origin && !(req.method === 'GET' && req.headers['sec-fetch-site'] === 'same-origin')) {
      reply(res, 403, { error: 'local_origin_required' }); return true;
    }
    let release;
    try {
      if (req.url === '/local-app/updates/status' && req.method === 'GET') reply(res, 200, await updates.status());
      else if (req.method === 'POST' && ['/local-app/updates/check', '/local-app/updates/download', '/local-app/updates/stage', '/local-app/updates/preferences', '/local-app/updates/approve', '/local-app/updates/defer'].includes(req.url)) {
        release = activityGate.acquire('storage');
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new UpdateError('invalid_request');
        let bytes = 0; const chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) throw new UpdateError('request_too_large'); chunks.push(chunk); }
        let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UpdateError('invalid_request'); }
        if (req.url.endsWith('/approve')) {
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'acknowledgement'
            || input.acknowledgement !== 'saved-and-all-tasks-ended') throw new UpdateError('invalid_request');
          // Confirmation is not a business write. Release only this request's
          // activity before the exact-owned backend checks all remaining work.
          // A concurrent new task remains visible to the gate/durable ledger.
          release(); release = null;
          reply(res, 200, await updates.approve(input.acknowledgement)); return true;
        }
        if (!req.url.endsWith('/preferences') && (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)) throw new UpdateError('invalid_request');
        reply(res, 200, req.url.endsWith('/check') ? await updates.check() : req.url.endsWith('/download') ? await updates.download()
          : req.url.endsWith('/stage') ? await updates.stage() : req.url.endsWith('/defer') ? await updates.defer() : await updates.configure(input));
      } else reply(res, 405, { error: 'operation_not_allowed' });
    } catch (e) { if (!res.headersSent) reply(res, 409, { error: e instanceof UpdateError ? e.code : 'update_operation_failed' }); }
    finally { release?.(); }
    return true;
  };
}
