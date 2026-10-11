// A newly started version must not accept business requests before the updater
// commits its health-checked transaction. Only the inherited Node IPC channel
// can activate it; there is deliberately no HTTP/browser unlock route.
export function createUpdateStartup({ env = process.env, parent = process, onActivate = () => {}, backendControl = null, instance = null } = {}) {
  let quarantined = env.GUAN_UPDATE_QUARANTINE === '1';
  const nonce = env.GUAN_UPDATE_NONCE;
  delete env.GUAN_UPDATE_QUARANTINE; delete env.GUAN_UPDATE_NONCE;
  if (quarantined && (!/^[a-f0-9-]{36}$/.test(nonce || '') || !parent.send)) throw Error('update_startup_invalid');
  let controlSequence = 0, controlBusy = false;
  if (quarantined) parent.on('message', async message => {
    if (backendControl && message && Object.keys(message).sort().join(',') === 'command,instance,nonce,op,sequence'
      && message.op === 'guan-update-backend' && message.nonce === nonce && message.instance === instance
      && Number.isSafeInteger(message.sequence) && message.sequence === controlSequence + 1 && !controlBusy) {
      // Accept exactly one bounded request at a time. Sequence is consumed
      // before async work, so replay cannot repeat a possibly completed freeze.
      try { if (JSON.stringify(message).length > 2048) return; } catch { return; }
      controlSequence = message.sequence; controlBusy = true;
      let reply;
      try { reply = { ok: true, evidence: await backendControl.command(message.command) }; }
      catch (error) { reply = { ok: false, error: /^service_backend_[a-z_]{1,40}$/.test(error?.message || '') ? error.message : 'service_backend_failed' }; }
      finally { controlBusy = false; }
      try { parent.send({ op: 'guan-update-backend-result', nonce, instance, sequence: message.sequence, ...reply }, () => {}); } catch {}
      return;
    }
    if (!message || Object.keys(message).sort().join(',') !== 'nonce,op'
      || message.op !== 'guan-update-activate' || message.nonce !== nonce) return;
    if (controlBusy || backendControl?.frozen()) return;
    if (quarantined) { quarantined = false; onActivate(); }
    // Parent can disappear between activation and acknowledgement. A lost ack
    // is reconciled by exact owned-process health; it must not crash a version
    // which has already opened its business routes.
    try { parent.send({ op: 'guan-update-activated', nonce }, () => {}); } catch {}
  });
  return { quarantined: () => quarantined,
    reject(request, response, pathname) {
      if ((!quarantined && !backendControl?.frozen()) || pathname === '/local-app/health' && request.method === 'GET') return false;
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5' });
      response.end('{"error":"工作台正在验证更新，请稍后重试"}'); return true;
    } };
}
