import { encodeBackupValue, decodeBackupValue } from './browser-backup-codec.mjs';
const result = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('浏览器数据库操作失败'));
});
const committed = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(Error('浏览器数据保存失败'));
});
const storage = value => Object.fromEntries(Array.from({ length: value.length }, (_, i) => {
  const key = value.key(i); return [key, value.getItem(key)];
}));
// Read-only source export, including Blob bytes, schemas and indexes.
export async function exportBrowserStorage() {
  const snapshot = { app: 'guan-ai-workbench', kind: 'full-browser-backup', format: 1,
    origin: location.origin, localStorage: storage(localStorage), sessionStorage: storage(sessionStorage), databases: [] };
  for (const info of await indexedDB.databases()) {
    const db = await result(indexedDB.open(info.name, info.version));
    try {
      const spec = { name: db.name, version: db.version, stores: [] };
      for (const name of db.objectStoreNames) {
        const tx = db.transaction(name, 'readonly'), store = tx.objectStore(name);
        const schema = { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
          indexes: Array.from(store.indexNames, index => { const s = store.index(index); return { name: s.name, keyPath: s.keyPath, unique: s.unique, multiEntry: s.multiEntry }; }) };
        const keysRequest = store.getAllKeys(), valuesRequest = store.getAll();
        const [keys, values] = await Promise.all([result(keysRequest), result(valuesRequest)]);
        const records = [];
        for (let i = 0; i < keys.length; i++) records.push({ key: await encodeBackupValue(keys[i]), value: await encodeBackupValue(values[i]) });
        spec.stores.push({ ...schema, records });
      }
      snapshot.databases.push(spec);
    } finally { db.close(); }
  }
  if (JSON.stringify(snapshot.localStorage) !== JSON.stringify(storage(localStorage))) throw Error('源配置仍在变化，请保存并关闭工作台页面后重试');
  return snapshot;
}
// No clear/delete/put. Original source is retained; an occupied target is refused.
export async function restoreBrowserStorage(snapshot) {
  if (location.origin !== 'http://127.0.0.1:8888' || snapshot?.app !== 'guan-ai-workbench'
    || snapshot.kind !== 'full-browser-backup' || snapshot.format !== 1 || snapshot.origin !== 'http://127.0.0.1:5174'
    || !Array.isArray(snapshot.databases) || !snapshot.localStorage || !snapshot.sessionStorage) throw Error('迁移地址或备份格式不匹配');
  if (localStorage.length || sessionStorage.length || (await indexedDB.databases()).length) throw Error('新地址已有数据，已停止迁移，未覆盖任何数据');
  // Validate/decode before the first destination write.
  const decoded = snapshot.databases.map(spec => ({ ...spec, stores: spec.stores.map(store => ({ ...store,
    records: store.records.map(record => ({ key: decodeBackupValue(record.key), value: decodeBackupValue(record.value) })) })) }));
  for (const name of ['localStorage', 'sessionStorage']) for (const value of Object.values(snapshot[name]))
    if (typeof value !== 'string') throw Error('备份配置格式无效');
  try {
    for (const spec of decoded) {
      const request = indexedDB.open(spec.name, spec.version);
      request.onupgradeneeded = () => {
        for (const store of spec.stores) {
          const created = request.result.createObjectStore(store.name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement });
          for (const index of store.indexes) created.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      };
      const db = await result(request);
      try {
        for (const store of spec.stores) {
          const tx = db.transaction(store.name, 'readwrite'), done = committed(tx), target = tx.objectStore(store.name);
          for (const record of store.records) {
            if (store.keyPath === null) target.add(record.value, record.key); else target.add(record.value);
          }
          await done;
          const read = db.transaction(store.name, 'readonly').objectStore(store.name);
          const keysRequest = read.getAllKeys(), valuesRequest = read.getAll();
          const [keys, values] = await Promise.all([result(keysRequest), result(valuesRequest)]);
          if (keys.length !== store.records.length) throw Error('数据库记录数量不一致');
          const expected = new Map();
          for (const record of store.records) expected.set(JSON.stringify(await encodeBackupValue(record.key)), JSON.stringify(await encodeBackupValue(record.value)));
          for (let i = 0; i < keys.length; i++) if (expected.get(JSON.stringify(await encodeBackupValue(keys[i]))) !== JSON.stringify(await encodeBackupValue(values[i])))
            throw Error('数据库内容校验失败');
        }
      } finally { db.close(); }
    }
    for (const [name, target] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) {
      for (const [key, value] of Object.entries(snapshot[name])) target.setItem(key, value);
      for (const [key, value] of Object.entries(snapshot[name])) if (target.getItem(key) !== value) throw Error('配置内容校验失败');
    }
    return { verified: true, databases: decoded.length };
  } catch { throw Error('迁移未通过，已保留原地址和备份；新地址的部分副本也保留，请勿打开工作台或覆盖数据'); }
}
