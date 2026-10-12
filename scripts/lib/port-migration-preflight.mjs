export async function inspectMigrationPorts(request = fetch) {
  const probe = async port => {
    let response;
    try { response = await request(`http://127.0.0.1:${port}/local-app/health`, { signal: AbortSignal.timeout(2000) }); }
    catch (error) {
      if (error?.cause?.code === 'ECONNREFUSED') return null;
      throw Error('port_state_unknown');
    }
    let health; try { health = await response.json(); } catch { throw Error('port_occupied_unknown'); }
    if (!response.ok || health.app !== 'guan-ai-workbench' || !health.ready || health.maintenance
      || health.origin !== `http://127.0.0.1:${port}`) throw Error('port_occupied_unknown');
    return health;
  };
  const target = await probe(8888);
  if (target) return { state: 'already-migrated', version: target.version };
  const source = await probe(5174);
  if (!source) throw Error('source_service_missing');
  return { state: 'ready', version: source.version };
}
