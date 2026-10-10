// Strict SemVer precedence, without floating-point coercion or partial matches.
export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!m || m[4]?.split('.').some(x => /^\d+$/.test(x) && x.length > 1 && x[0] === '0')) return null;
  return { version: value.replace(/^v/, ''), core: m.slice(1, 4).map(BigInt), pre: m[4]?.split('.') || [] };
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw Error('invalid_version');
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === q ? 0 : p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}
export function validRepository(value) {
  return typeof value === 'string' && value.length <= 201
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value)
    && !['.', '..'].includes(value.split('/')[1]);
}
