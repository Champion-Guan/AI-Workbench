export const portMigrationPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>工作台端口迁移</title>
<style>body{font:16px system-ui;margin:48px auto;padding:24px;max-width:760px;color:#222;background:#fafafa}button,input{margin:12px 0;padding:10px}pre{white-space:pre-wrap}@media(prefers-color-scheme:dark){body{color:#eee;background:#171717}}</style>
<h1>工作台数据迁移：5174 → 8888</h1>
<p>先保存并关闭其他工作台页面。在旧地址导出备份，再在新地址导入。旧数据始终保留；新地址已有数据时禁止覆盖。备份包含私人配置，只保存在你自己的电脑，不要上传到公开仓库。</p>
<button id="export">导出当前浏览器完整备份</button><div>在 8888 地址选择旧地址的备份：<input id="import" type="file" accept="application/json"></div>
<pre id="status" role="status">尚未开始迁移。失败时请保留原地址数据和备份。</pre>
<script type="module">
import {exportBrowserStorage,restoreBrowserStorage} from '/data-contract/port-migration.mjs';
const status=document.querySelector('#status');
document.querySelector('#export').onclick=async()=>{try{
 status.textContent='正在读取浏览器存储，请不要修改工作台数据…';
 const snapshot=await exportBrowserStorage();
 const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot)],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download='AI-Workbench-browser-backup-'+location.port+'-'+Date.now()+'.json';link.click();
 setTimeout(()=>URL.revokeObjectURL(url),60000);status.textContent='已导出备份；请确认文件已经下载并妥善保管。';
}catch{status.textContent='备份失败，原数据未修改，请勿切换服务。';}};
document.querySelector('#import').onchange=async event=>{try{
 const file=event.target.files[0];if(!file)return;
 status.textContent='正在迁移并逐项校验，请不要关闭页面…';
 await restoreBrowserStorage(JSON.parse(await file.text()));
 status.textContent='迁移与内容校验通过。旧地址数据仍保留，可打开工作台。';
 const link=document.createElement('a');link.href='/';link.textContent='打开工作台';status.append(document.createElement('br'),link);
}catch{status.textContent='迁移未通过或新地址已有数据。原数据和已有副本均保留，请勿覆盖、清空或继续安装。';}};
</script></html>`;
