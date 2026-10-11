const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const controlUuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
export function validBackendCommand(v) {
  return exact(v, ['action', 'value']) && (v.action === 'snapshot' && v.value === null
    || v.action === 'freeze' && exact(v.value, ['backendRevision', 'ledgerRevision', 'writeRevision'])
      && Object.values(v.value).every(count)
    || v.action === 'resume' && controlUuid(v.value));
}
export function validBackendEvidence(v) {
  return exact(v, ['protocol', 'instance', 'version', 'backend', 'ledger', 'writes', 'backgroundBusy', 'fullCoverage', 'installAllowed'])
    && v.protocol === 1 && controlUuid(v.instance) && typeof v.version === 'string' && /^\d+\.\d+\.\d+$/.test(v.version)
    && exact(v.backend, ['revision', 'active', 'frozen', 'epoch']) && count(v.backend.revision) && count(v.backend.active)
    && typeof v.backend.frozen === 'boolean' && (v.backend.frozen ? controlUuid(v.backend.epoch) : v.backend.epoch === null)
    && exact(v.ledger, ['revision', 'pending', 'frozen']) && count(v.ledger.revision) && count(v.ledger.pending) && typeof v.ledger.frozen === 'boolean'
    && exact(v.writes, ['revision', 'pending', 'failed']) && Object.values(v.writes).every(count)
    && typeof v.backgroundBusy === 'boolean' && v.fullCoverage === false && v.installAllowed === false;
}
