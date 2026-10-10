// Isolated browser QA only. Not included in application/release entry points.
import localforage from 'localforage';
import { localForageStorage, flushLocalForagePersistence } from '../../src/canvas/lib/localforage-storage';
import { flushStorageCheckpoints } from '../../src/canvas/lib/persistence-checkpoint';
import { frontendActivity } from '../../src/canvas/lib/update-activity';

let started = false;
const check = (value: unknown) => { if (!value) throw Error('Isolated storage assertion failed'); };
export async function runNativeStorageSafety() {
  if (started || location.hostname !== '127.0.0.1' || location.port === '5174') throw Error('Fresh isolated browser required');
  started = true;
  check((await indexedDB.databases()).length === 0);
  await localforage.setDriver(localforage.INDEXEDDB);
  const key = 'infinite-canvas:canvas_store', damaged = '{qa-damaged-canvas';
  await localforage.setItem(key, damaged);
  const { useCanvasStore, flushCanvasPersistence } = await import('../../src/canvas/stores/canvas/use-canvas-store');
  await useCanvasStore.persist.rehydrate();
  check(!useCanvasStore.getState().hydrated);
  useCanvasStore.getState().createProject('qa-unrestored-edit');
  let denied = false;
  try { await flushCanvasPersistence(); } catch { denied = true; }
  check(denied && await localforage.getItem(key) === damaged);
  const original = { state: { projects: [{ id: 'qa-kept', title: 'qa-original', nodes: [], connections: [], imageInfoDefaultVersion: 1 }], deletedProjects: [] }, version: 0 };
  await localforage.setItem(key, JSON.stringify(original));
  await useCanvasStore.persist.rehydrate();
  check(useCanvasStore.getState().hydrated && useCanvasStore.getState().projects[0].id === 'qa-kept');
  useCanvasStore.getState().renameProject('qa-kept', 'qa-verified');
  await flushCanvasPersistence(); await flushLocalForagePersistence(); await flushStorageCheckpoints();
  check(JSON.parse((await localforage.getItem<string>(key))!).state.projects[0].title === 'qa-verified');
  const large = 'q'.repeat(12 * 1024 * 1024), largeKey = 'qa-large-canvas';
  let quota = false;
  try { localStorage.setItem('qa-quota-probe', large); } catch (error) { quota = (error as DOMException).name === 'QuotaExceededError'; }
  check(quota && localStorage.getItem('qa-quota-probe') === null);
  await localForageStorage.setItem(largeKey, large);
  await flushLocalForagePersistence(); await flushStorageCheckpoints();
  check(await localforage.getItem(largeKey) === large && localStorage.getItem(largeKey) === null);
  const media = localforage.createInstance({ name: 'infinite-canvas', storeName: 'media_files' });
  const retained = new Blob(['qa-original-video'], { type: 'video/mp4' });
  await media.setItem('video:qa-history-only', retained);
  const { cleanupUnusedMedia } = await import('../../src/canvas/services/file-storage');
  const result = await cleanupUnusedMedia({ assets: [], projects: [], extra: [] });
  check(result.status === 'retained' && (await media.getItem<Blob>('video:qa-history-only'))?.size === retained.size);
  await flushStorageCheckpoints();
  check(frontendActivity.snapshot().storage === 0);
  return { ok: true, nativeDriver: localforage.driver(), damagedRecordPreserved: true, explicitRecoveryVerified: true,
    nativeQuotaObserved: quota, largePrimaryReadBackVerified: true, historyMediaRetained: true, storageIdle: true,
    productionDataTouched: false, installAllowed: false };
}
