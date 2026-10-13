// Repository aliases are fixed identities, never caller-provided trust redirects.
export const STABLE_REPOSITORY = 'Champion-Guan/infinite-canvas';
export const WORKBENCH_PORT = 8888;
export const WORKBENCH_ORIGIN = `http://127.0.0.1:${WORKBENCH_PORT}`;
const aliases = new Set(['champion-guan/infinite-canvas', 'champion-guan/ai-workbench', 'champion-guan/guan-ai-workbench', 'mrguam/guan-ai-workbench']);
export const isWorkbenchRepository = value => typeof value === 'string' && aliases.has(value.toLowerCase());
export const sameWorkbenchRepository = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (a.toLowerCase() === b.toLowerCase() || isWorkbenchRepository(a) && isWorkbenchRepository(b));
// Retain anonymous reads of the old public channel for verified migration tools.
// New preferences and releases are locked to STABLE_REPOSITORY.
const publicRepositories = new Set(['champion-guan/infinite-canvas', 'champion-guan/ai-workbench']);
export const isPublicUpdateRepository = value => typeof value === 'string' && publicRepositories.has(value.toLowerCase());
