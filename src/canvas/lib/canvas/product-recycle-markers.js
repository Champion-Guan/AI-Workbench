export const recycleMarkerKey = id => `guan-product-recycled-canvas:${id}`;
export function isRecycledCanvas(id, storage = globalThis.localStorage) {
  try { return storage?.getItem(recycleMarkerKey(id)) === 'deleted'; } catch { return false; }
}
export function filterRecycledProjects(projects, storage = globalThis.localStorage) {
  return projects.filter(project => !isRecycledCanvas(project.id, storage));
}
