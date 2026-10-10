export const CANVAS_PRODUCTS_KEY = 'guan-header-canvas-projects';
export const canvasSelectionKey = productSetId => `guan-workbook-active-canvas:${encodeURIComponent(productSetId || '__unbound__')}`;

export function activeWorkbookId(state) {
  return state.workspace?.activeProductSetId || [...(state.productSets || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]?.id || null;
}

// Legacy products had no ownership field. Adopt them once, without touching
// canvas IDs, files or routes. Explicit null means created without a workbook.
export function readCanvasProducts(storage, legacyOwner = null) {
  const raw = storage.getItem(CANVAS_PRODUCTS_KEY);
  const projects = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(projects)) throw new Error('产品列表数据异常，请先备份再恢复。');
  let changed = false;
  const next = projects.map(project => {
    if (!project || Object.hasOwn(project, 'productSetId')) return project;
    changed = true;
    return { ...project, productSetId: legacyOwner || null };
  });
  if (changed) storage.setItem(CANVAS_PRODUCTS_KEY, JSON.stringify(next));
  return next.filter(project => project?.id);
}

export function workbookCanvasProducts(projects, productSetId) {
  return projects.filter(project => (project.productSetId || null) === (productSetId || null));
}

export function rememberCanvasSelection(storage, productSetId, productId) {
  if (productId) storage.setItem(canvasSelectionKey(productSetId), productId);
  else storage.removeItem(canvasSelectionKey(productSetId));
}

export function activeCanvasProduct(state, projects, storage) {
  const owner = activeWorkbookId(state);
  const extras = workbookCanvasProducts(projects, owner).map(project => ({ ...project, standalone: true }));
  const products = [...(state.products || [])].filter(product => (product.productSetId || null) === owner).sort((a, b) => a.order - b.order);
  const all = [...products, ...extras];
  const selected = storage.getItem(canvasSelectionKey(owner));
  return all.find(product => product.id === selected) || all.find(product => product.id === state.workspace?.activeProductId) || all[0] || null;
}

export function registerCanvasProduct(storage, input, currentOwner) {
  const projects = readCanvasProducts(storage, currentOwner);
  const existing = projects.find(project => project.id === input.id);
  const product = existing ? { ...existing, title: input.title } : { ...input, productSetId: input.productSetId || null, order: projects.length, createdAt: new Date().toISOString() };
  storage.setItem(CANVAS_PRODUCTS_KEY, JSON.stringify(existing ? projects.map(item => item.id === product.id ? product : item) : [...projects, product]));
  return product;
}
