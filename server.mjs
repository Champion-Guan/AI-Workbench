import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const archiveRoot = join(projectRoot, "archive");
const pageFile = join(archiveRoot, "index.html");
const assetRoot = join(archiveRoot, "assets");
const port = Number(process.env.PORT || 5174);
const staticOnlyCsp = [
  "default-src 'self' data: blob:;",
  "script-src 'self' 'unsafe-inline';",
  "style-src 'self' 'unsafe-inline';",
  "img-src 'self' data: blob:;",
  "font-src 'self' data:;",
  "media-src 'self' data: blob:;",
  "connect-src 'self';",
  "worker-src 'self' blob:;",
  "frame-src 'self';",
  "object-src 'none';",
  "base-uri 'self';",
].join(" ");
const workbenchLogoStyle = `<style id="local-workbench-logo">
  [role="dialog"] aside a[href="/"],
  [role="dialog"] aside a[href="/zh-CN/workbench"] { position: relative; }
  [role="dialog"] aside a[href="/"] > svg,
  [role="dialog"] aside a[href="/zh-CN/workbench"] > svg { opacity: 0 !important; }
  [role="dialog"] aside a[href="/"]::after,
  [role="dialog"] aside a[href="/zh-CN/workbench"]::after {
    content: "";
    position: absolute;
    inset: 0;
    background: url("/_pixpix-assets/local-brand/workbench-logo.png?g-brand-v4") center / contain no-repeat;
    filter: none;
    pointer-events: none;
  }
  html.dark [role="dialog"] aside a[href="/"]::after,
  html.dark [role="dialog"] aside a[href="/zh-CN/workbench"]::after,
  html[data-theme="dark"] [role="dialog"] aside a[href="/"]::after,
  html[data-theme="dark"] [role="dialog"] aside a[href="/zh-CN/workbench"]::after,
  body.dark [role="dialog"] aside a[href="/"]::after,
  body.dark [role="dialog"] aside a[href="/zh-CN/workbench"]::after { filter: invert(1) brightness(1.3); }
</style>`;

const localRootNavigationScript = `<script id="local-root-navigation">
  (() => {
    const legacyWorkbenchPath = "/zh-CN/workbench";
    const normalizeBrandLink = () => {
      for (const link of document.querySelectorAll('a[href="' + legacyWorkbenchPath + '"]')) {
        link.setAttribute("href", "/");
      }
    };

    // The archived React runtime restores its original workbench href after
    // hydration. Keep the local MVP's only entry point at the short root URL.
    new MutationObserver(normalizeBrandLink).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    document.addEventListener("DOMContentLoaded", normalizeBrandLink, { once: true });

    // Next's hydrated Link retains the original workbench destination in its
    // event handler even after the href attribute is normalized. Intercept
    // only the header brand action, before that handler runs.
    document.addEventListener("click", (event) => {
      const target = event.target;
      const link = target instanceof Element ? target.closest('[role="dialog"] aside a') : null;
      if (!link) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (location.pathname !== "/" || location.search || location.hash) location.assign("/");
    }, true);
  })();
</script>`;

const localSettingsPanelScript = `<script id="local-settings-panel-script">
  (() => {
    const setup = () => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;

      const panel = Array.from(dialog.querySelectorAll('aside')).find((node) =>
        node.querySelector('textarea, [role="textbox"]')
      );
      if (!panel || panel.dataset.localSettingsPanel === "ready") return Boolean(panel);

      panel.dataset.localSettingsPanel = "ready";
      panel.id = "local-settings-panel";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "local-settings-toggle";
      toggle.setAttribute("aria-controls", panel.id);
      panel.prepend(toggle);

      const setCollapsed = (collapsed) => {
        panel.dataset.localSettingsCollapsed = String(collapsed);
        document.documentElement.dataset.localSettingsCollapsed = String(collapsed);
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute("aria-label", collapsed ? "展开设置面板" : "收起设置面板");
        toggle.title = collapsed ? "展开设置面板" : "收起设置面板";
        toggle.textContent = collapsed ? "›" : "‹";
      };

      toggle.addEventListener("click", () => {
        setCollapsed(panel.dataset.localSettingsCollapsed !== "true");
      });
      setCollapsed(false);
      return true;
    };

    const observer = new MutationObserver(() => {
      if (setup()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setup();
  })();
</script>`;

const localWorkbenchSettingsButtonScript = "<script id=\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\">\n(() => {\n  const setup = () => {\n    const pageDialog = document.querySelector('[role=\"dialog\"]');\n    const header = pageDialog?.querySelector(':scope > .flex.size-full > aside');\n    if (!header || header.dataset.localSettingsButton === \"ready\") return Boolean(header);\n    const button = document.createElement(\"button\");\n    button.type = \"button\"; button.className = \"local-workbench-settings-button\";\n    button.setAttribute(\"aria-label\",\"设置配置\"); button.setAttribute(\"aria-controls\",\"local-workbench-settings-modal\"); button.setAttribute(\"aria-expanded\",\"false\"); button.title=\"设置配置\";\n    button.innerHTML = '<svg fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\"></path><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 12a3 3 0 11-6 0 3 3 0 016 0z\"></path></svg>';\n    const modal = document.createElement(\"div\");\n    modal.id=\"M15 12a3 3 0 11-6 0 3 3 0 016 0z\"; modal.className=\"local-settings-modal\"; modal.hidden=true; modal.setAttribute(\"aria-hidden\",\"true\");\n    const gear = '<svg class=\"settings-modal-gear\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\"></path><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 12a3 3 0 11-6 0 3 3 0 016 0z\"></path></svg>';\n    modal.innerHTML = '<div class=\"local-settings-backdrop\"></div><div class=\"local-settings-dialog\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"local-settings-title\"><header class=\"local-settings-header\"><div class=\"local-settings-title\" id=\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\">'+gear+'<span>设置</span></div><span class=\"local-settings-version\">v0.7.12</span><button type=\"button\" class=\"local-settings-close\" aria-label=\"关闭设置\">×</button></header><div class=\"local-settings-layout\"><nav class=\"local-settings-sidebar\"><button class=\"local-settings-tab active\" data-tab=\"api\"><span class=\"local-settings-tab-icon\">⌕</span><span>API 配置</span></button><button class=\"local-settings-tab\" data-tab=\"fallback\"><span class=\"local-settings-tab-icon\">⇄</span><span>Fallback 配置</span></button><button class=\"local-settings-tab\" data-tab=\"general\"><span class=\"local-settings-tab-icon\">◷</span><span>习惯配置</span></button><button class=\"local-settings-tab\" data-tab=\"agent\"><span class=\"local-settings-tab-icon\">♙</span><span>Agent 配置</span></button><button class=\"local-settings-tab\" data-tab=\"data\"><span class=\"local-settings-tab-icon\">▣</span><span>数据管理</span></button><button class=\"local-settings-tab\" data-tab=\"about\"><span class=\"local-settings-tab-icon\">ⓘ</span><span>关于</span></button></nav><main class=\"local-settings-content\"><section class=\"local-settings-panel active\" data-panel=\"api\"><h4>当前配置 <span>↗</span></h4><select class=\"local-settings-select\" aria-label=\"当前配置\"><option>IXYAPI　OpenAI</option><option>hi-code　OpenAI</option><option>zzone　OpenAI</option><option>jojocode　OpenAI</option></select><div class=\"local-settings-info\"><span class=\"info-mark\">i</span><strong>余额 ¥2.52；仅支持 gpt-image-2，¥0.08/张。优先级 2，余额用完即弃；明确余额不足后自动跳过。可在「Fallback 配置」中调整顺序、停用或重新启用。</strong></div><label class=\"local-settings-label\">配置名称<input class=\"local-settings-field\" value=\"IXYAPI\"></label><label class=\"local-settings-label\">服务商类型<select class=\"local-settings-select\"><option>OpenAI 兼容接口</option></select></label><label class=\"local-settings-label\">API URL<input class=\"local-settings-field\" value=\"https://www.tixyw.com/v1\"></label><p class=\"local-settings-help\">末尾带 / 时直接使用该地址拼接接口，不补 /v1 前缀，支持通过查询参数覆盖：?apiUrl=。</p><label class=\"local-settings-label\">API Key<input class=\"local-settings-field\" type=\"password\" value=\"sk-••••••••••••••••••••\"></label><label class=\"local-settings-label\">模型<input class=\"local-settings-field\" value=\"gpt-image-2\"></label><div class=\"local-settings-grid\"><label class=\"local-settings-label\">请求超时<input class=\"local-settings-field\" value=\"120\"></label><label class=\"local-settings-label\">默认优先级<input class=\"local-settings-field\" value=\"2\"></label></div><button class=\"local-settings-action\" type=\"button\">保存配置</button></section><section class=\"local-settings-panel\" data-panel=\"fallback\"><h4>Fallback 配置</h4><div class=\"local-settings-card\"><strong>失败后自动切换中转站</strong><p>按照优先级尝试可用的图片生成接口，失败或余额不足时继续下一个配置。</p></div><div class=\"local-settings-card\"><strong>当前优先级</strong><p>1　zzone（¥0.06/张）<br>2　IXYAPI（¥0.08/张）<br>3　jojocode（¥0.10/张）<br>4　hi-code（¥0.22/张）</p></div><button class=\"local-settings-action\" type=\"button\">管理 Fallback 顺序</button></section><section class=\"local-settings-panel\" data-panel=\"general\"><h4>习惯配置</h4><div class=\"local-settings-card\"><strong>本地工作台</strong><p>生成结果、任务记录和产品素材全部保留在当前设备，不跳转登录页面。</p></div><div class=\"local-settings-card\"><strong>固定上架参数</strong><p>上架平台 · Wildberries　　语言 · 俄语</p></div></section><section class=\"local-settings-panel\" data-panel=\"agent\"><h4>Agent 配置</h4><p class=\"local-settings-muted\">配置提示词翻译、批量产品任务编排和后续视频生成能力。</p><div class=\"local-settings-card\"><strong>当前模式</strong><p>本地静态工作台（管理员权限）</p></div></section><section class=\"local-settings-panel\" data-panel=\"data\"><h4>数据管理</h4><div class=\"local-settings-grid\"><div class=\"local-settings-card\"><strong>导出数据</strong><p>导出配置、任务和生成结果。</p><button class=\"local-settings-action\" type=\"button\">导出</button></div><div class=\"local-settings-card\"><strong>导入数据</strong><p>从本地文件恢复工作台数据。</p><button class=\"local-settings-action\" type=\"button\">导入</button></div></div></section><section class=\"local-settings-panel\" data-panel=\"about\"><h4>关于</h4><p class=\"local-settings-muted\">Guan A+ 详情页生成工具<br>本地静态版本 · 设置面板基于 GPT Image Playground 的交互结构。</p></section></main></div></div>';\n    const close=()=>{modal.hidden=true;modal.setAttribute(\"aria-hidden\",\"true\");button.setAttribute(\"aria-expanded\",\"false\");document.body.style.overflow=\"\";};\n    const open=()=>{modal.hidden=false;modal.setAttribute(\"aria-hidden\",\"false\");button.setAttribute(\"aria-expanded\",\"true\");document.body.style.overflow=\"hidden\";};\n    const switchTab=(tab)=>{modal.querySelectorAll(\".local-settings-tab\").forEach((item)=>item.classList.toggle(\"active\",item.dataset.tab===tab));modal.querySelectorAll(\".local-settings-panel\").forEach((item)=>item.classList.toggle(\"active\",item.dataset.panel===tab));};\n    button.addEventListener(\"click\",open); modal.querySelector(\".local-settings-close\").addEventListener(\"click\",close); modal.querySelector(\".local-settings-backdrop\").addEventListener(\"click\",close); modal.querySelector(\".local-settings-dialog\").addEventListener(\"pointerdown\",(event)=>event.stopPropagation()); modal.querySelector(\".local-settings-dialog\").addEventListener(\"click\",(event)=>event.stopPropagation());\n    modal.querySelectorAll(\".local-settings-tab\").forEach((tab)=>tab.addEventListener(\"click\",()=>switchTab(tab.dataset.tab)));\n    document.addEventListener(\"keydown\",(event)=>{if(event.key===\"Escape\"&&!modal.hidden)close();});\n    header.append(button); document.body.append(modal); header.dataset.localSettingsButton=\"ready\"; return true;\n  };\n  const observer=new MutationObserver(()=>{if(setup())observer.disconnect();}); observer.observe(document.documentElement,{childList:true,subtree:true}); setup();\n})();\n</script>";
const localSettingsModalStyle = "<style id=\"local-settings-modal-style\">\n.local-settings-modal[hidden]{display:none!important}\n.local-settings-modal,.local-settings-dialog,.local-settings-sidebar,.local-settings-content{pointer-events:auto!important}\n.local-settings-modal{position:fixed!important;inset:0!important;z-index:240!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:32px!important;color:#f5f5f7!important;font-family:inherit!important}\n.local-settings-backdrop{position:absolute!important;inset:0!important;background:rgba(0,0,0,.76)!important;backdrop-filter:blur(11px)!important;animation:local-settings-fade-in .24s ease both!important}\n.local-settings-dialog{position:relative!important;z-index:1!important;display:flex!important;flex-direction:column!important;width:min(1090px,calc(100vw - 40px))!important;height:min(860px,calc(100vh - 64px))!important;min-height:520px!important;overflow:hidden!important;border:1px solid rgba(255,255,255,.11)!important;border-radius:28px!important;background:#1a1a1d!important;box-shadow:0 28px 90px rgba(0,0,0,.62),0 0 0 1px rgba(255,255,255,.04) inset!important;animation:local-settings-dialog-in .28s cubic-bezier(.2,.8,.2,1) both!important}\n.local-settings-header{display:flex!important;align-items:center!important;justify-content:space-between!important;flex:0 0 98px!important;padding:0 30px 0 34px!important;border-bottom:1px solid rgba(255,255,255,.1)!important}\n.local-settings-title{display:flex!important;align-items:center!important;gap:15px!important;font-size:24px!important;font-weight:700!important}\n.local-settings-title svg{width:25px!important;height:25px!important;color:#4f9cff!important}\n.local-settings-version{margin-left:auto!important;margin-right:26px!important;color:#7c7c87!important;font:600 17px/1 ui-monospace,SFMono-Regular,Menlo,monospace!important}\n.local-settings-close{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:42px!important;height:42px!important;border:0!important;border-radius:12px!important;background:transparent!important;color:#aeb0ba!important;font-size:31px!important;font-weight:300!important;line-height:1!important;cursor:pointer!important;transition:background .16s ease,color .16s ease,transform .16s ease!important}\n.local-settings-close:hover{background:rgba(255,255,255,.08)!important;color:#fff!important}.local-settings-close:active{transform:scale(.92)!important}\n.local-settings-layout{display:flex!important;flex:1 1 auto!important;min-height:0!important}\n.local-settings-sidebar{display:flex!important;flex:0 0 274px!important;flex-direction:column!important;gap:8px!important;padding:22px 18px!important;border-right:1px solid rgba(255,255,255,.1)!important;background:rgba(255,255,255,.025)!important}\n.local-settings-tab{display:flex!important;align-items:center!important;gap:15px!important;min-height:58px!important;padding:0 20px!important;border:0!important;border-radius:17px!important;background:transparent!important;color:#aeb0ba!important;font-size:19px!important;text-align:left!important;cursor:pointer!important;transition:background .18s ease,color .18s ease,transform .18s ease!important}\n.local-settings-tab:hover{background:rgba(255,255,255,.055)!important;color:#e8e8ed!important}.local-settings-tab.active{background:rgba(255,255,255,.11)!important;color:#58a1ff!important;font-weight:600!important}.local-settings-tab:active{transform:scale(.985)!important}\n.local-settings-tab-icon{width:22px!important;color:currentColor!important;font-size:23px!important;line-height:1!important;text-align:center!important}\n.local-settings-content{flex:1 1 auto!important;min-width:0!important;overflow:auto!important;padding:34px 34px 44px!important}\n.local-settings-panel{display:none!important;max-width:780px!important}.local-settings-panel.active{display:block!important;animation:local-settings-panel-in .2s ease both!important}\n.local-settings-panel h4{margin:0 0 18px!important;color:#ececf1!important;font-size:21px!important;font-weight:700!important}.local-settings-panel h4 span{margin-left:9px!important;color:#8b8d97!important;font-size:20px!important}\n.local-settings-label{display:block!important;margin:22px 0 9px!important;color:#e5e5eb!important;font-size:18px!important;font-weight:600!important}\n.local-settings-field,.local-settings-select{box-sizing:border-box!important;width:100%!important;height:58px!important;padding:0 18px!important;border:1px solid rgba(255,255,255,.11)!important;border-radius:18px!important;outline:none!important;background:rgba(255,255,255,.035)!important;color:#eeeef2!important;font:500 18px/1 inherit!important;transition:border-color .18s ease,background .18s ease,box-shadow .18s ease!important}\n.local-settings-field:focus,.local-settings-select:focus{border-color:#468fe8!important;background:rgba(255,255,255,.06)!important;box-shadow:0 0 0 3px rgba(70,143,232,.18)!important}.local-settings-select{appearance:auto!important}\n.local-settings-info{margin-top:16px!important;padding:20px 22px!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:18px!important;color:#d9d9df!important;background:rgba(255,255,255,.035)!important;font-size:17px!important;line-height:1.75!important}.local-settings-info strong{color:#f2f2f5!important}.info-mark{display:inline-flex!important;width:22px!important;height:22px!important;align-items:center!important;justify-content:center!important;margin-right:11px!important;border:2px solid #4f9cff!important;border-radius:50%!important;color:#4f9cff!important;font-weight:700!important}.local-settings-help{margin:8px 0 0!important;color:#8f909a!important;font-size:15px!important;line-height:1.55!important}\n.local-settings-grid{display:grid!important;grid-template-columns:1fr 1fr!important;gap:18px!important}.local-settings-card{padding:20px!important;border:1px solid rgba(255,255,255,.1)!important;border-radius:18px!important;background:rgba(255,255,255,.035)!important}.local-settings-card strong{display:block!important;margin-bottom:8px!important;color:#f0f0f4!important;font-size:18px!important}.local-settings-card p{margin:0!important;color:#9697a1!important;font-size:15px!important;line-height:1.55!important}\n.local-settings-action{margin-top:24px!important;padding:13px 20px!important;border:0!important;border-radius:13px!important;background:#3e8ff5!important;color:#fff!important;font-size:16px!important;cursor:pointer!important}.local-settings-action:hover{background:#579dff!important}.local-settings-muted{color:#9697a1!important;font-size:16px!important;line-height:1.7!important}\n@keyframes local-settings-fade-in{from{opacity:0}to{opacity:1}}@keyframes local-settings-dialog-in{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes local-settings-panel-in{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}\n@media(max-width:760px){.local-settings-modal{padding:10px!important}.local-settings-dialog{width:calc(100vw - 20px)!important;height:calc(100vh - 20px)!important;min-height:0!important;border-radius:20px!important}.local-settings-header{flex-basis:74px!important;padding:0 16px 0 20px!important}.local-settings-title{font-size:20px!important}.local-settings-version{margin-right:8px!important;font-size:13px!important}.local-settings-layout{flex-direction:column!important}.local-settings-sidebar{flex:0 0 auto!important;flex-direction:row!important;overflow-x:auto!important;padding:10px!important;border-right:0!important;border-bottom:1px solid rgba(255,255,255,.1)!important}.local-settings-tab{min-height:43px!important;padding:0 14px!important;border-radius:12px!important;font-size:14px!important}.local-settings-tab-icon{width:auto!important;font-size:17px!important}.local-settings-content{padding:22px 18px 30px!important}.local-settings-grid{grid-template-columns:1fr!important}.local-settings-field,.local-settings-select{height:50px!important;font-size:16px!important}}\n</style>";

const localFixedFieldsScript = `<script id="local-fixed-fields-script">
  (() => {
    const fixedFields = [
      { label: "上架平台", value: "Wildberries" },
      { label: "语言", value: "俄语" },
    ];

    const apply = () => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      let applied = false;

      for (const field of fixedFields) {
        const groups = Array.from(dialog.querySelectorAll('[role="group"]'));
        const group = groups.find((node) =>
          node.querySelector('label')?.textContent?.trim() === field.label
        );
        const select = group?.querySelector('select');
        const trigger = group?.querySelector('[role="combobox"]');
        if (!group || !select || !trigger) continue;

        if (!Array.from(select.options).some((option) => option.value === field.value)) {
          select.add(new Option(field.value, field.value), 0);
        }
        if (select.value !== field.value) select.value = field.value;
        if (!select.disabled) select.disabled = true;
        select.dataset.localFixed = "true";
        if (!trigger.disabled) trigger.disabled = true;
        trigger.dataset.localFixed = "true";
        if (trigger.getAttribute("aria-disabled") !== "true") trigger.setAttribute("aria-disabled", "true");
        const fixedLabel = field.label + "（固定为" + field.value + "）";
        if (trigger.getAttribute("aria-label") !== fixedLabel) trigger.setAttribute("aria-label", fixedLabel);
        const fixedTitle = field.label + "已固定为" + field.value;
        if (trigger.title !== fixedTitle) trigger.title = fixedTitle;
        const value = trigger.querySelector('[data-slot="select-value"]');
        if (value && value.textContent !== field.value) value.textContent = field.value;
        const label = group.querySelector('label');
        const summary = field.label + " · " + field.value;
        if (label && label.textContent.trim() !== summary) label.textContent = summary;
        if (label) label.dataset.localFixedSummary = "true";
        if (group.dataset.localFixed !== "true") group.dataset.localFixed = "true";
        applied = true;
      }

      return applied;
    };

    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", apply, { once: true });
    apply();
  })();
</script>`;

const localResolutionButtonsScript = `<script id="local-resolution-buttons-script">
  (() => {
    const resolutionChoices = [
      { text: "1K", value: "1k" },
      { text: "2K", value: "2k" },
      { text: "4K", value: "4k" },
    ];

    const setup = () => {
      const dialog = document.querySelector('[role="dialog"]');
      const aspectGroup = Array.from(dialog?.querySelectorAll('[role="group"]') || []).find((node) =>
        node.querySelector('label')?.textContent?.trim() === "图片比例"
      );
      const parent = aspectGroup?.parentElement;
      if (!aspectGroup || !parent) return false;

      let group = parent.querySelector('[data-local-resolution="true"]');
      if (!group) {
        group = document.createElement("div");
        group.className = aspectGroup.className;
        group.dataset.localResolution = "true";
        group.setAttribute("role", "group");
        group.setAttribute("data-slot", "field");
        group.setAttribute("data-orientation", "vertical");

        const label = document.createElement("label");
        label.className = aspectGroup.querySelector("label")?.className || "";
        label.textContent = "图片分辨率";

        const options = document.createElement("div");
        options.className = "local-resolution-options";
        options.setAttribute("role", "group");
        options.setAttribute("aria-label", "图片分辨率选项");

        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "resolution";
        input.value = resolutionChoices[0].value;
        input.dataset.localResolutionValue = "true";

        resolutionChoices.forEach((choice) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "local-resolution-option";
          button.dataset.value = choice.value;
          button.textContent = choice.text;
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            input.value = choice.value;
            group.dataset.localResolutionValue = choice.value;
            sync();
          });
          options.append(button);
        });

        group.append(label, options, input);
        parent.insertBefore(group, aspectGroup);
      }

      const input = group.querySelector('[data-local-resolution-value="true"]');
      const sync = () => {
        const value = input?.value || resolutionChoices[0].value;
        group.dataset.localResolutionValue = value;
        group.querySelectorAll(".local-resolution-option").forEach((button) => {
          const selected = button.dataset.value === value;
          button.dataset.selected = String(selected);
          button.setAttribute("aria-pressed", String(selected));
        });
      };
      sync();
      return true;
    };

    const observer = new MutationObserver(setup);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", setup, { once: true });
    setup();
  })();
</script>`;

const localAspectRatioButtonsScript = `<script id="local-aspect-ratio-buttons-script">
  (() => {
    const ratioChoices = [
      { text: "1:1", value: "1024x1024" },
      { text: "4:3", value: "1152x864" },
      { text: "3:4", value: "864x1152" },
      { text: "4:5", value: "1024x1280" },
      { text: "16:9", value: "1536x864" },
      { text: "9:16", value: "864x1536" },
    ];

    const setup = () => {
      const dialog = document.querySelector('[role="dialog"]');
      const group = Array.from(dialog?.querySelectorAll('[role="group"]') || []).find((node) =>
        node.querySelector('label')?.textContent?.trim() === "图片比例"
      );
      const select = group?.querySelector('select');
      const label = group?.querySelector('label');
      if (!group || !select || !label) return false;

      group.dataset.localAspectRatio = "true";
      if (select.dataset.localAspectRatioNormalized !== "true") {
        select.replaceChildren(...ratioChoices.map((choice) => new Option(choice.text, choice.value)));
        select.dataset.localAspectRatioNormalized = "true";
      }
      if (!ratioChoices.some((choice) => choice.value === select.value)) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        setter?.call(select, ratioChoices[0].value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }

      let options = group.querySelector('.local-aspect-ratio-options');
      if (!options) {
        options = document.createElement("div");
        options.className = "local-aspect-ratio-options";
        options.setAttribute("role", "group");
        options.setAttribute("aria-label", "图片比例选项");
        label.insertAdjacentElement("afterend", options);
        ratioChoices.forEach((choice) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "local-aspect-ratio-option";
          button.dataset.value = choice.value;
          button.textContent = choice.text;
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
            setter?.call(select, choice.value);
            select.dispatchEvent(new Event("change", { bubbles: true }));
            sync();
          });
          options.append(button);
        });
      }

      const sync = () => {
        options.querySelectorAll(".local-aspect-ratio-option").forEach((button) => {
          const selected = button.dataset.value === select.value;
          button.dataset.selected = String(selected);
          button.setAttribute("aria-pressed", String(selected));
        });
      };
      if (select.dataset.localAspectRatioReady !== "true") {
        select.dataset.localAspectRatioReady = "true";
        select.addEventListener("change", sync);
      }
      sync();
      return true;
    };

    const observer = new MutationObserver(setup);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", setup, { once: true });
    setup();
  })();
</script>`;

const localOfflineGuardsScript = `<script id="local-offline-guards-script">
  (() => {
    const uploadState = { files: [], urls: [], parent: null, preview: null };

    const renderLocalPreviews = (parent) => {
      if (!parent || !uploadState.files.length) return;
      const renderKey = uploadState.files
        .map((file) => file.name + ":" + file.size + ":" + file.lastModified)
        .join("|");
      if (!uploadState.preview || !uploadState.preview.isConnected || uploadState.preview.parentElement !== parent) {
        uploadState.preview?.remove();
        const preview = document.createElement("div");
        preview.className = "local-offline-upload-preview";
        preview.setAttribute("aria-label", "本地已选择图片");
        preview.dataset.renderKey = renderKey;
        parent.prepend(preview);
        uploadState.preview = preview;
      } else if (uploadState.preview.dataset.renderKey === renderKey) {
        return;
      } else {
        uploadState.preview.dataset.renderKey = renderKey;
      }
      uploadState.preview.replaceChildren(...uploadState.files.map((file, index) => {
        const item = document.createElement("div");
        item.className = "local-offline-upload-item";
        const image = document.createElement("img");
        image.src = uploadState.urls[index];
        image.alt = file.name;
        item.append(image);
        return item;
      }));
    };

    const setupUploader = () => {
      const dialog = document.querySelector('[role="dialog"]');
      const input = dialog?.querySelector('input[type="file"][aria-label="上传图片"]');
      const button = input?.parentElement?.querySelector('button[aria-label="上传图片"]');
      if (!input || !button) return false;
      const parent = input.parentElement;

      if (input.dataset.localOfflineReady !== "true") {
        input.dataset.localOfflineReady = "true";
        input.addEventListener("change", (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          uploadState.urls.forEach((url) => URL.revokeObjectURL(url));
          uploadState.files = Array.from(input.files || []).slice(0, 3);
          uploadState.urls = uploadState.files.map((file) => URL.createObjectURL(file));
          uploadState.parent = parent;
          renderLocalPreviews(parent);
        }, true);
      }

      if (button.dataset.localOfflineReady !== "true") {
        button.dataset.localOfflineReady = "true";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          input.click();
        }, true);
      }
      renderLocalPreviews(parent);
      return true;
    };

    // Keep the archived page entirely local: no login route, external href,
    // or fixed-field interaction is allowed to escape this document.
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const fixed = target.closest('[data-local-fixed="true"] [role="combobox"]');
      const link = target.closest("a[href]");
      if (fixed || link) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);

    const observer = new MutationObserver(setupUploader);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", setupUploader, { once: true });
    setupUploader();
  })();
</script>`;

const localResponsivePreviewScript = `<script id="local-responsive-preview-script">
  (() => {
    const state = {
      section: null,
      content: null,
      body: null,
      resizeObserver: null,
      mutationObserver: null,
      frame: 0,
    };

    const findPreview = () => {
      const dialog = document.querySelector('[role="dialog"]');
      const section = dialog?.querySelector("section");
      const content = section?.firstElementChild;
      const body = content?.firstElementChild;
      if (!section || !content || !body) return null;
      return { section, content, body };
    };

    const applyScale = () => {
      state.frame = 0;
      const target = findPreview();
      if (!target) return;

      const { section, content, body } = target;
      if (state.section !== section || state.content !== content || state.body !== body) {
        state.section = section;
        state.content = content;
        state.body = body;
        state.resizeObserver?.disconnect();
        state.resizeObserver = new ResizeObserver(schedule);
        state.resizeObserver.observe(section);
        state.mutationObserver?.disconnect();
        state.mutationObserver = new MutationObserver(schedule);
        state.mutationObserver.observe(body, { childList: true, subtree: true, attributes: true });
        body.addEventListener("load", schedule, true);
      }

      // Measure the complete preview at its natural scale, then fit the whole
      // title, description, carousel, and pagination into the available box.
      content.style.zoom = "1";
      const style = getComputedStyle(content);
      const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const availableWidth = Math.max(0, content.clientWidth - paddingX);
      const availableHeight = Math.max(0, content.clientHeight - paddingY);
      const natural = body.getBoundingClientRect();
      if (!natural.width || !natural.height || !availableWidth || !availableHeight) return;

      const scale = Math.min(1, availableWidth / natural.width, availableHeight / natural.height);
      content.style.zoom = Math.max(0.42, scale).toFixed(3);
    };

    const schedule = () => {
      if (state.frame) return;
      state.frame = requestAnimationFrame(applyScale);
    };

    const setup = () => {
      schedule();
      return Boolean(findPreview());
    };

    new MutationObserver(setup).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("resize", schedule, { passive: true });
    document.addEventListener("DOMContentLoaded", setup, { once: true });
    setup();
  })();
</script>`;

const mvpNavigationStyle = `<style id="mvp-navigation">
  /* Phase 1 is intentionally limited to product image generation and A+ pages. */
  html, body { background: #fff !important; }
  [role="dialog"][data-slot="dialog-content"] {
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100dvh !important;
    max-width: none !important;
    transform: none !important;
    translate: 0 0 !important;
    border: 0 !important;
    border-radius: 0 !important;
  }
  /* Replace the legacy left rail with a single horizontal workspace header. */
  [role="dialog"] > .flex.size-full {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) !important;
    grid-template-rows: 84px minmax(0, 1fr) !important;
  }
  [role="dialog"] > .flex.size-full > aside {
    grid-area: 1 / 1 !important;
    display: flex !important;
    width: 100% !important;
    height: 84px !important;
    min-height: 84px !important;
    flex-direction: row !important;
    align-items: center !important;
    justify-content: flex-start !important;
    padding: 0 24px !important;
    border-right: 0 !important;
    border-bottom: 1px solid var(--border) !important;
    border-radius: 0 !important;
  }
  [role="dialog"] > .flex.size-full > aside > div {
    display: flex !important;
  }
  [role="dialog"] > .flex.size-full > div:not([hidden]) {
    grid-area: 2 / 1 !important;
    width: 100% !important;
    flex-direction: row !important;
    align-items: stretch !important;
  }
  /* The archived page nests the preview section and settings panel one level
     below the workspace wrapper. Keep the desktop inner row explicit so the
     preview and settings panel share the available width above 800px. */
  [role="dialog"] > .flex.size-full > div:not([hidden]) > div {
    flex-direction: row !important;
    align-items: stretch !important;
    min-width: 0 !important;
    min-height: 0 !important;
  }
  [role="dialog"] > .flex.size-full > div:not([hidden]) > div > section {
    display: flex !important;
    flex: 1 1 0% !important;
    width: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
  }
  [role="dialog"] > .flex.size-full > div:not([hidden]) > div > #local-settings-panel {
    min-width: 0 !important;
  }
  [data-local-fixed="true"] [role="combobox"] {
    cursor: default !important;
    opacity: .9 !important;
  }
  [data-local-fixed="true"] [role="combobox"] svg {
    display: none !important;
  }
  /* Platform and language are fixed for this local MVP. Keep their summary
     text while removing the redundant dropdown boxes from the form. */
  [data-local-fixed="true"] [role="combobox"],
  [data-local-fixed="true"] select {
    display: none !important;
  }
  [data-local-fixed-summary="true"] {
    color: #5b5c65 !important;
    white-space: nowrap !important;
  }
  [data-local-aspect-ratio="true"] > [role="combobox"],
  [data-local-aspect-ratio="true"] > select {
    display: none !important;
  }
  [data-local-aspect-ratio="true"] {
    grid-column: 1 / -1 !important;
    width: 100% !important;
  }
  [data-local-resolution="true"] {
    grid-column: 1 / -1 !important;
  }
  .local-resolution-options {
    display: grid !important;
    grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
    gap: 8px !important;
    width: 100% !important;
  }
  .local-resolution-option {
    min-width: 0 !important;
    min-height: 36px !important;
    padding: 7px 10px !important;
    overflow: hidden !important;
    border: 1px solid var(--border) !important;
    border-radius: 8px !important;
    background: var(--card) !important;
    color: var(--foreground) !important;
    font-size: 13px !important;
    line-height: 18px !important;
    text-align: center !important;
    cursor: pointer !important;
    transition: border-color .15s ease, background-color .15s ease, color .15s ease !important;
  }
  .local-resolution-option:hover {
    border-color: var(--muted-foreground) !important;
    background: var(--muted) !important;
  }
  .local-resolution-option[data-selected="true"] {
    border-color: var(--primary) !important;
    background: var(--primary) !important;
    color: var(--primary-foreground) !important;
  }
  .local-aspect-ratio-options {
    display: grid !important;
    grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
    gap: 8px !important;
    width: 100% !important;
  }
  .local-aspect-ratio-option {
    min-width: 0 !important;
    min-height: 36px !important;
    padding: 7px 10px !important;
    overflow: hidden !important;
    border: 1px solid var(--border) !important;
    border-radius: 8px !important;
    background: var(--card) !important;
    color: var(--foreground) !important;
    font-size: 13px !important;
    line-height: 18px !important;
    text-align: center !important;
    white-space: normal !important;
    cursor: pointer !important;
    transition: border-color .15s ease, background-color .15s ease, color .15s ease !important;
  }
  .local-aspect-ratio-option:hover {
    border-color: var(--muted-foreground) !important;
    background: var(--muted) !important;
  }
  .local-aspect-ratio-option[data-selected="true"] {
    border-color: var(--primary) !important;
    background: var(--primary) !important;
    color: var(--primary-foreground) !important;
  }
  .local-offline-upload-preview {
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 8px !important;
  }
  .local-offline-upload-item {
    width: 128px !important;
    height: 128px !important;
    overflow: hidden !important;
    border: 1px solid var(--border) !important;
    border-radius: 12px !important;
    background: var(--card) !important;
  }
  .local-offline-upload-item img {
    display: block !important;
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
  }
  [role="dialog"] [role="radiogroup"][aria-label="工具类型"] {
    display: flex !important;
    position: absolute !important;
    top: 24px !important;
    left: 88px !important;
    z-index: 20 !important;
  }
  [role="dialog"] .no-scrollbar:has(> [role="radiogroup"][aria-label="工具类型"]) {
    display: flex !important;
    overflow: visible !important;
  }
  [role="dialog"] button[aria-label^="工具类型:"] {
    display: none !important;
  }
  [role="dialog"] div:has(> .no-scrollbar > [role="radiogroup"][aria-label="工具类型"]),
  [role="dialog"] div:has(> div > .no-scrollbar > [role="radiogroup"][aria-label="工具类型"]) {
    height: 0 !important;
    min-height: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
  }
  [role="radiogroup"][aria-label="工具类型"]
    [role="radio"][aria-label="商品套图"],
  [role="radiogroup"][aria-label="工具类型"]
    [role="radio"][aria-label="爆款复刻"],
  [role="radiogroup"][aria-label="工具类型"]
    [role="radio"][aria-label="产品精修"],
  [role="radiogroup"][aria-label="工具类型"]
    [role="radio"][aria-label="产品换色"],
  nav[aria-label="Tool categories"],
  [role="dialog"] > button.absolute {
    display: none !important;
  }

  /* Keep the settings controls together in a right-side panel that can be
     collapsed to give the preview canvas more room. */
  #local-settings-panel {
    position: relative !important;
    z-index: 5 !important;
    overflow: visible !important;
    will-change: flex-basis, width, min-width, max-width;
    transition: flex-basis .36s cubic-bezier(.4, 0, .2, 1), width .36s cubic-bezier(.4, 0, .2, 1), min-width .36s cubic-bezier(.4, 0, .2, 1), max-width .36s cubic-bezier(.4, 0, .2, 1), gap .3s ease, padding .3s ease !important;
  }
  #local-settings-panel > form {
    opacity: 1 !important;
    visibility: visible !important;
    transform: translateX(0) !important;
    transition: opacity .26s ease .08s, transform .32s cubic-bezier(.4, 0, .2, 1) .04s, visibility 0s linear 0s !important;
  }
  #local-settings-panel[data-local-settings-collapsed="true"] {
    flex: 0 0 44px !important;
    width: 44px !important;
    min-width: 44px !important;
    max-width: 44px !important;
    gap: 0 !important;
    overflow: visible !important;
  }
  #local-settings-panel[data-local-settings-collapsed="true"] > form {
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
    transform: translateX(20px) !important;
    transition: opacity .24s ease .04s, transform .32s cubic-bezier(.4, 0, .2, 1), visibility 0s linear .36s !important;
  }
  html[data-local-settings-collapsed="true"] [role="dialog"] > .flex.size-full > div:not([hidden]) {
    overflow: visible !important;
  }
  html[data-local-settings-collapsed="true"] [role="dialog"] section {
    overflow: visible !important;
  }
  /* Keep the preview and settings columns stable on desktop. The narrow
     single-column override below restores the official mobile behavior. */
  html[data-local-settings-collapsed="true"] [role="dialog"] > .flex.size-full > div:not([hidden]) > section,
  html[data-local-settings-collapsed="true"] [role="dialog"] > .flex.size-full > div:not([hidden]) > div > section {
    display: flex !important;
    flex: 1 1 auto !important;
    width: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
  }
  [role="dialog"] > .flex.size-full > div:not([hidden]) > section,
  [role="dialog"] > .flex.size-full > div:not([hidden]) > div > section {
    display: flex !important;
    flex: 1 1 0% !important;
    width: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
  }
  @media (max-width: 799px) {
    /* Match the official narrow layout: the settings form becomes the only
       visible workspace column and the preview is intentionally hidden. */
    [role="dialog"] > .flex.size-full > div:not([hidden]) {
      flex-direction: column !important;
      align-items: stretch !important;
      overflow: hidden !important;
    }
    [role="dialog"] > .flex.size-full > div:not([hidden]) > div {
      flex-direction: column !important;
      align-items: stretch !important;
      width: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;
      overflow: hidden !important;
    }
    [role="dialog"] > .flex.size-full > div:not([hidden]) > div > section {
      display: none !important;
      flex: 0 0 0 !important;
      width: 0 !important;
      min-width: 0 !important;
      min-height: 0 !important;
    }
    [role="dialog"] > .flex.size-full > div:not([hidden]) > div > #local-settings-panel,
    html[data-local-settings-collapsed="true"] [role="dialog"] > .flex.size-full > div:not([hidden]) > div > #local-settings-panel {
      flex: 1 1 auto !important;
      width: 100% !important;
      min-width: 0 !important;
      max-width: none !important;
      overflow: hidden !important;
    }
    /* A collapsed desktop state must not carry over as a blank 44px strip on
       mobile. The form stays available while the collapse affordance is
       hidden, just like the official narrow view. */
    #local-settings-panel[data-local-settings-collapsed="true"] > form {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
    .local-settings-toggle {
      display: none !important;
    }
  }
  @media (min-width: 800px) {
    [role="dialog"] > .flex.size-full > div:not([hidden]) > div > #local-settings-panel {
      flex: 0 0 432px !important;
      width: 432px !important;
      min-width: 360px !important;
      max-width: 432px !important;
    }
  }
  @media (max-width: 799px) {
    [role="dialog"] > .flex.size-full > div:not([hidden]) > div > #local-settings-panel {
      flex: 1 1 auto !important;
      width: auto !important;
      max-width: none !important;
    }
  }
  html[data-local-settings-collapsed="true"] [role="dialog"] > .flex.size-full > div:not([hidden]) > #local-settings-panel,
  html[data-local-settings-collapsed="true"] [role="dialog"] > .flex.size-full > div:not([hidden]) > div > #local-settings-panel {
    flex: 0 0 44px !important;
    width: 44px !important;
    min-width: 44px !important;
    max-width: 44px !important;
  }
  @media (max-width: 799px) {
    /* Keep the mobile single-column mode authoritative even if the desktop
       collapse attribute is still present while the viewport is resized. */
    html[data-local-settings-collapsed="true"] [role="dialog"] > .flex.size-full > div:not([hidden]) > div > section {
      display: none !important;
      flex: 0 0 0 !important;
      width: 0 !important;
    }
    html[data-local-settings-collapsed="true"] [role="dialog"] > .flex.size-full > div:not([hidden]) > div > #local-settings-panel {
      flex: 1 1 auto !important;
      width: 100% !important;
      min-width: 0 !important;
      max-width: none !important;
    }
  }
  .local-workbench-settings-button {
    display: inline-flex !important;
    width: 48px !important;
    height: 48px !important;
    flex: 0 0 48px !important;
    align-items: center !important;
    justify-content: center !important;
    margin-left: auto !important;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 12px !important;
    background: transparent !important;
    color: #5b5c65 !important;
    cursor: pointer !important;
    transition: background-color .16s ease, color .16s ease, transform .16s ease !important;
  }
  .local-workbench-settings-button:hover {
    background: var(--muted) !important;
  }
  .local-workbench-settings-button:active {
    transform: scale(.94) !important;
  }
  .local-workbench-settings-button svg {
    width: 24px !important;
    height: 24px !important;
    fill: none !important;
    stroke: currentColor !important;
    stroke-width: 2.15 !important;
    stroke-linecap: round !important;
    stroke-linejoin: round !important;
  }
  @media (max-width: 799px) {
    .local-workbench-settings-button {
      width: 44px !important;
      height: 44px !important;
      flex-basis: 44px !important;
    }
  }
  html.dark .local-workbench-settings-button,
  body.dark .local-workbench-settings-button {
    color: #d8d9e0 !important;
  }

  .local-workbench-config {
    position: fixed !important;
    top: 96px !important;
    right: 24px !important;
    z-index: 120 !important;
    width: min(336px, calc(100vw - 32px)) !important;
    overflow: hidden !important;
    border: 1px solid var(--border) !important;
    border-radius: 14px !important;
    background: var(--card) !important;
    color: var(--foreground) !important;
    box-shadow: 0 16px 40px rgb(0 0 0 / 16%) !important;
    transform-origin: top right !important;
    animation: local-workbench-config-in .16s ease-out !important;
  }
  .local-workbench-config[hidden] {
    display: none !important;
  }
  @keyframes local-workbench-config-in {
    from { opacity: 0; transform: translateY(-6px) scale(.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .local-workbench-config-header {
    display: flex !important;
    min-height: 52px !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding: 0 14px 0 18px !important;
    border-bottom: 1px solid var(--border) !important;
    font-size: 15px !important;
  }
  .local-workbench-config-close {
    width: 30px !important;
    height: 30px !important;
    border: 0 !important;
    border-radius: 8px !important;
    background: transparent !important;
    color: var(--muted-foreground) !important;
    font-size: 22px !important;
    line-height: 1 !important;
    cursor: pointer !important;
  }
  .local-workbench-config-close:hover {
    background: var(--muted) !important;
    color: var(--foreground) !important;
  }
  .local-workbench-config-body {
    display: flex !important;
    flex-direction: column !important;
    gap: 10px !important;
    padding: 14px 18px 17px !important;
    font-size: 13px !important;
  }
  .local-workbench-config-row {
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    gap: 16px !important;
  }
  .local-workbench-config-row span {
    color: var(--muted-foreground) !important;
  }
  .local-workbench-config-row b {
    font-weight: 500 !important;
  }
  .local-workbench-config-body p {
    margin: 5px 0 0 !important;
    color: var(--muted-foreground) !important;
    line-height: 1.5 !important;
  }

  .local-settings-toggle {
    position: absolute !important;
    top: 50% !important;
    /* Sit just outside the panel's left edge so it never covers a field. */
    left: -34px !important;
    z-index: 30 !important;
    display: inline-flex !important;
    width: 32px !important;
    height: 56px !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 0 !important;
    border: 1px solid var(--border) !important;
    border-right: 0 !important;
    border-radius: 10px 0 0 10px !important;
    background: var(--card) !important;
    color: var(--muted-foreground) !important;
    box-shadow: -3px 4px 12px rgb(0 0 0 / 10%) !important;
    font-size: 28px !important;
    line-height: 1 !important;
    transform: translateY(-50%) !important;
    cursor: pointer !important;
    transition: background .15s ease, color .15s ease, box-shadow .15s ease !important;
  }
  .local-settings-toggle:hover {
    background: var(--accent) !important;
    color: var(--accent-foreground) !important;
    box-shadow: 0 6px 18px rgb(0 0 0 / 15%) !important;
  }
  @media (max-width: 799px) {
    .local-settings-toggle {
      display: none !important;
    }
  }
</style>`;

const contentTypes = {
  ".avif": "image/avif", ".css": "text/css; charset=utf-8", ".gif": "image/gif", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".mp4": "video/mp4", ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".webm": "video/webm", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
};

function safeFile(root, relative) {
  const target = join(root, normalize(relative.replace(/^\/+/, "")));
  return target.startsWith(root) ? target : null;
}

async function existingFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function send(response, path, method) {
  response.writeHead(200, {
    "content-type": contentTypes[extname(path).toLowerCase()] || "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": staticOnlyCsp,
    "x-static-archive": "guan-detail-page-static",
  });
  if (method === "HEAD") return response.end();
  if (extname(path).toLowerCase() === ".html") {
    const document = await readFile(path, "utf8");
    const refreshedFavicon = document
      // The archived page includes PixPix's locale-selection redirect, which
      // would turn this project's root entry point into /zh-CN at runtime.
      // The archived detail page itself is Chinese, so the redirect is neither
      // needed nor desirable in this single-page local MVP.
      .replace(/<script id="root-locale-redirect">[\s\S]*?<\/script>/, "")
      .replace(/href="\/_pixpix-assets\/www\.pixpix\.com\/favicon\.ico[^"]*"/g, 'href="/favicon.ico?g-brand-v4"')
      .replace(/href="\/favicon\.ico[^"]*"/g, 'href="/favicon.ico?g-brand-v4"')
      .replace(/\\\"href\\\":\\\"\/favicon\.ico[^\\\"]*/g, '\\\"href\\\":\\\"/favicon.ico?g-brand-v4')
      .replace(/href="\/zh-CN\/workbench"/g, 'href="/"');
    response.end(refreshedFavicon.replace("</head>", `${workbenchLogoStyle}${mvpNavigationStyle}${localRootNavigationScript}${localSettingsPanelScript}${localWorkbenchSettingsButtonScript}${localSettingsModalStyle}${localFixedFieldsScript}${localResolutionButtonsScript}${localAspectRatioButtonsScript}${localOfflineGuardsScript}${localResponsivePreviewScript}</head>`));
    return;
  }
  createReadStream(path).pipe(response);
}

function notFound(response) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end("Not found. This local project serves only the A+ detail page and its local assets.");
}

async function localMedia(response, pathname, method) {
  const relative = pathname.slice("/_pixpix-media/".length);
  // Keep the archived runtime's legacy URL shape working without restoring
  // the old nested storage directory on disk.
  const mediaRelative = relative.startsWith("images/tools/")
    ? "tools/" + relative.slice("images/tools/".length)
    : relative;
  const local = safeFile(assetRoot, "media/" + mediaRelative);
  if (local && await existingFile(local)) return send(response, local, method);
  return notFound(response);
}

const server = createServer(async (request, response) => {
  const method = request.method || "GET";
  if (!["GET", "HEAD"].includes(method)) {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname.replace(/\/$/, "") || "/";
  if (pathname === "/favicon.ico") {
    const favicon = safeFile(assetRoot, "local-brand/favicon.png");
    if (favicon && await existingFile(favicon)) return send(response, favicon, method);
    return notFound(response);
  }
  if (pathname.startsWith("/_pixpix-media/")) return localMedia(response, pathname, method);
  if (pathname.startsWith("/_pixpix-assets/")) {
    const file = safeFile(assetRoot, pathname.slice("/_pixpix-assets/".length));
    if (file && await existingFile(file)) return send(response, file, method);
    return notFound(response);
  }

  if (pathname !== "/" || !await existingFile(pageFile)) return notFound(response);
  return send(response, pageFile, method);
});

server.listen(port, "127.0.0.1", () => {
  console.log("Guan A+ 详情页工作台运行在 http://127.0.0.1:" + port);
});
