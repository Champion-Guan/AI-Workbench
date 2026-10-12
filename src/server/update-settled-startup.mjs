const same = (a, b) => Boolean(a && b) && ['id', 'version', 'commit', 'buildId'].every(key => a[key] === b[key]);

// Normal launchd startup of an ALREADY settled current release, not installation
// permission or crash-transaction recovery. It never changes pointers/consent,
// removes durable tasks, upgrades a release or adopts an existing listener.
export async function startSettledCurrent({ manager, authority, ledger }) {
  const current = await manager.readCurrent();
  if (!current) return { state: 'not-installed' };
  const consent = await authority.read();
  if (!consent || consent.state !== 'completed') return { state: 'maintenance-required' };
  const journal = await manager.readJournal(), bootstrap = await manager.readBootstrap();
  const settled = journal
    ? ['committed', 'rolled-back'].includes(journal.phase) && same(journal.next, consent.next)
      && same(journal.previous, consent.previous) && same(current, journal.phase === 'committed' ? journal.next : journal.previous)
    : bootstrap?.phase === 'activated' && consent.previous === null && same(current, bootstrap.next) && same(current, consent.next);
  if (!settled) throw Error('update_recovery_required');
  const owned = await manager.service.inspectOwned();
  if (!owned.stopped) {
    if (!same(owned.pointer, current) || !owned.active || owned.maintenance) throw Error('update_activation_unconfirmed');
    return { state: 'running' };
  }
  return manager.locked(async () => {
    // Recheck all disk evidence after taking the cross-process deployment lock.
    if (!same(await manager.readCurrent(), current) || JSON.stringify(await authority.read()) !== JSON.stringify(consent)
      || JSON.stringify(await manager.readJournal()) !== JSON.stringify(journal)
      || JSON.stringify(await manager.readBootstrap()) !== JSON.stringify(bootstrap)) throw Error('update_recovery_required');
    // Pending tasks are retained, not reclassified as success. Their presence
    // blocks future installation but should not prevent opening the old app to
    // inspect/reconcile them after reboot. A missing/corrupt ledger still blocks.
    if (!authority.pageOnly) await ledger.snapshot();
    const verified = await manager.verifyInstalled(current);
    if (verified.startupProtocol !== 1 || await manager.service.isStopped() !== true) throw Error('service_ownership_lost');
    await manager.service.stop({ allowed: [current] }); // only an already dead owned handle; never a live listener
    await manager.healthy(current);
    await manager.service.activate(current);
    const active = await manager.service.inspectOwned();
    if (active.stopped || !same(active.pointer, current) || !active.active || active.maintenance) throw Error('update_activation_unconfirmed');
    return { state: 'running' };
  });
}
