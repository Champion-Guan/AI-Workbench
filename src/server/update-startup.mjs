// A newly started version must not accept business requests before the updater
// commits its health-checked transaction. Only the inherited Node IPC channel
// can activate it; there is deliberately no HTTP/browser unlock route.
export function createUpdateStartup({ env = process.env, parent = process, onActivate = () => {} } = {}) {
  let quarantined = env.GUAN_UPDATE_QUARANTINE === '1';
  const nonce = env.GUAN_UPDATE_NONCE;
  delete env.GUAN_UPDATE_QUARANTINE; delete env.GUAN_UPDATE_NONCE;
  if (quarantined && (!/^[a-f0-9-]{36}$/.test(nonce || '') || !parent.send)) throw Error('update_startup_invalid');
  if (quarantined) parent.on('message', message => {
    if (!message || Object.keys(message).sort().join(',') !== 'nonce,op'
      || message.op !== 'guan-update-activate' || message.nonce !== nonce) return;
    if (quarantined) { quarantined = false; onActivate(); }
    // Parent can disappear between activation and acknowledgement. A lost ack
    // is reconciled by exact owned-process health; it must not crash a version
    // which has already opened its business routes.
    try { parent.send({ op: 'guan-update-activated', nonce }, () => {}); } catch {}
  });
  return { quarantined: () => quarantined,
    reject(request, response, pathname) {
      if (!quarantined || pathname === '/local-app/health' && request.method === 'GET') return false;
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5' });
      response.end('{"error":"工作台正在验证更新，请稍后重试"}'); return true;
    } };
}
