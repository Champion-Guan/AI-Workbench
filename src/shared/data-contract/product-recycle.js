// Keep a complete, product-scoped contract snapshot. Shared workbook records
// and the original Excel file are never removed by a single-product deletion.
export function detachProduct(state, productId) {
  const product = state.products.find(item => item.id === productId);
  if (!product) return null;
  const snapshot = { product, productSet: state.productSets.find(item => item.id === product.productSetId), importRecord: state.importRecords.find(item => item.id === product.importRecordId) };
  const taskIds = new Set(state.tasks.filter(item => item.productId === productId).map(item => item.id));
  const runIds = new Set(state.runs.filter(item => item.productId === productId || taskIds.has(item.taskId)).map(item => item.id));
  for (const name of ['slots', 'prompts', 'tasks', 'runs', 'providerAttempts', 'assets']) {
    const owns = item => item.productId === productId || taskIds.has(item.taskId) || runIds.has(item.runId);
    snapshot[name] = state[name].filter(owns);
    // Source assets can also be shared by other products: archive a copy but
    // retain those references in the live contract.
    if (name === 'assets') {
      const shared = new Set(state.products.filter(item => item.id !== productId).flatMap(item => [...(item.sourceAssets || []), ...(item.subjectLock?.referenceAssetIds || [])]));
      const referenced = new Set([...(product.sourceAssets || []), ...(product.subjectLock?.referenceAssetIds || [])]);
      snapshot.assets = state.assets.filter(item => owns(item) || referenced.has(item.id));
      state.assets = state.assets.filter(item => !owns(item) || shared.has(item.id));
    } else state[name] = state[name].filter(item => !owns(item));
  }
  state.products = state.products.filter(item => item.id !== productId);
  for (const set of state.productSets) set.productIds = set.productIds.filter(id => id !== productId);
  if (state.workspace.activeProductId === productId) state.workspace.activeProductId = state.products.filter(item => item.productSetId === product.productSetId).sort((a, b) => a.order - b.order)[0]?.id || null;
  return snapshot;
}

export function reattachProduct(state, snapshot) {
  if (!snapshot?.product || state.products.some(item => item.id === snapshot.product.id)) return;
  if (!state.productSets.some(item => item.id === snapshot.productSet.id)) state.productSets.push({ ...snapshot.productSet, productIds: [] });
  if (!state.importRecords.some(item => item.id === snapshot.importRecord.id)) state.importRecords.push(snapshot.importRecord);
  state.products.push(snapshot.product);
  for (const name of ['slots', 'prompts', 'tasks', 'runs', 'providerAttempts', 'assets']) {
    const ids = new Set(state[name].map(item => item.id));
    state[name].push(...snapshot[name].filter(item => !ids.has(item.id)));
  }
  const set = state.productSets.find(item => item.id === snapshot.product.productSetId);
  if (!set.productIds.includes(snapshot.product.id)) set.productIds.push(snapshot.product.id);
}
