// Isolated restore rehearsal only. Never import this into the production app.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const codec = await readFile(new URL('./lib/browser-backup-codec.mjs', import.meta.url));
const page = `<!doctype html><meta charset="utf-8"><title>Guan 备份隔离验证</title>
<h1>备份恢复演练（独立测试 Origin）</h1><input id="backup" type="file" accept="application/json"><p id="status">请选择本机备份，仅用于隔离恢复验证。</p>
<script type="module">
import {decodeBackupValue, encodeBackupValue} from '/codec.mjs';
const requestResult = request => new Promise((resolve,reject) => {request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('测试数据库读取失败'));});
const committed = tx => new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(new Error('测试数据库写入失败'));});
window.__verification = {status:'waiting'};
document.querySelector('#backup').onchange = async event => {
 let phase='read';
 try {
  window.__verification = {status:'running'};
  const snapshot = JSON.parse(await event.target.files[0].text());
  if(snapshot.app!=='guan-ai-workbench'||snapshot.kind!=='full-browser-backup'||snapshot.format!==1) throw new Error('备份格式不匹配');
  if(location.origin===snapshot.origin || location.port==='5174' || location.hostname!=='127.0.0.1') throw new Error('禁止在原工作台恢复');
  if(localStorage.length||sessionStorage.length||(await indexedDB.databases()).length) throw new Error('测试环境非空，已停止，未覆盖数据');
  const result={status:'complete',databases:[],localStorageKeys:0,sessionStorageKeys:0,recordsVerified:0};
  for(const spec of snapshot.databases){
   phase='database-schema';
   const open=indexedDB.open(spec.name,spec.version);
   open.onupgradeneeded=()=>{for(const store of spec.stores){const created=open.result.createObjectStore(store.name,{keyPath:store.keyPath,autoIncrement:store.autoIncrement});for(const index of store.indexes)created.createIndex(index.name,index.keyPath,{unique:index.unique,multiEntry:index.multiEntry});}};
   const db=await requestResult(open);
   for(const store of spec.stores){
    phase='decode';
    const decoded=store.records.map(record=>({key:decodeBackupValue(record.key),value:decodeBackupValue(record.value)}));
    const tx=db.transaction(store.name,'readwrite'), done=committed(tx), target=tx.objectStore(store.name);
    for(const record of decoded){if(store.keyPath===null)target.add(record.value,record.key);else target.add(record.value);}
    await done;
    phase='verify-records';
    const readTx=db.transaction(store.name,'readonly'), objectStore=readTx.objectStore(store.name);
    if(JSON.stringify(objectStore.keyPath)!==JSON.stringify(store.keyPath)||objectStore.autoIncrement!==store.autoIncrement||objectStore.indexNames.length!==store.indexes.length)throw new Error('数据库结构不一致');
    for(const index of store.indexes){const actual=objectStore.index(index.name);if(JSON.stringify(actual.keyPath)!==JSON.stringify(index.keyPath)||actual.unique!==index.unique||actual.multiEntry!==index.multiEntry)throw new Error('数据库索引不一致');}
    const [keys,values]=await Promise.all([requestResult(objectStore.getAllKeys()),requestResult(objectStore.getAll())]);
    if(keys.length!==decoded.length)throw new Error('数据库记录数量不一致');
    // Compare keyed values, including every Blob byte, not merely row counts.
    const expected=new Map();
    for(const item of decoded)expected.set(JSON.stringify(await encodeBackupValue(item.key)),JSON.stringify(await encodeBackupValue(item.value)));
    for(let i=0;i<keys.length;i++){const key=JSON.stringify(await encodeBackupValue(keys[i]));if(!expected.has(key)||JSON.stringify(await encodeBackupValue(values[i]))!==expected.get(key))throw new Error('数据库内容恢复校验失败');result.recordsVerified++;}
   }
   db.close();result.databases.push({name:spec.name,version:spec.version,stores:spec.stores.map(store=>({name:store.name,count:store.records.length}))});
  }
  for(const [name,storage] of [['localStorage',localStorage],['sessionStorage',sessionStorage]]){
   phase=name;
   for(const [key,value]of Object.entries(snapshot[name])){if(typeof value!=='string')throw new Error('存储值类型无效');storage.setItem(key,value);}
   for(const [key,value]of Object.entries(snapshot[name]))if(storage.getItem(key)!==value)throw new Error('浏览器配置恢复校验失败');
   result[name+'Keys']=storage.length;
  }
  window.__verification=result;document.querySelector('#status').textContent='隔离恢复和逐项内容校验通过。';
 }catch(error){const safeMessages=['备份格式不匹配','禁止在原工作台恢复','测试环境非空，已停止，未覆盖数据','数据库结构不一致','数据库索引不一致','数据库记录数量不一致','数据库内容恢复校验失败','存储值类型无效','浏览器配置恢复校验失败','备份对象编号无效','备份对象引用无效','备份值格式无效','备份文件长度不一致','备份对象类型不支持'];window.__verification={status:'failed',phase,reason:safeMessages.includes(error.message)?error.message:'读取、解码或写入失败',error:'隔离恢复未通过，请保留原备份和原工作台数据，勿进行生产迁移。'};document.querySelector('#status').textContent=window.__verification.error;}
};
</script>`;
const server = createServer((request, response) => {
  if (request.method !== 'GET' || !['/', '/codec.mjs'].includes(request.url)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': request.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript',
    'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  response.end(request.url === '/' ? page : codec);
});
server.listen(0, '127.0.0.1', () => console.log('Isolated backup verification: http://127.0.0.1:' + server.address().port));
process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); });
process.on('SIGINT', () => { server.close(); server.closeAllConnections(); });
