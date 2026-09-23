import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
  "img-src 'self' https: data: blob:;",
  "font-src 'self' data:;",
  "media-src 'self' data: blob:;",
    "connect-src 'self' https:;",
  "worker-src 'self' blob:;",
  "frame-src 'self';",
  "object-src 'none';",
  "base-uri 'self';",
].join(" ");
const workbenchLogoStyle = `<style id="local-workbench-logo">
  [role="dialog"] aside a[href="/"],
  [role="dialog"] aside a[href="/zh-CN/workbench"],
  [role="dialog"] aside a.local-brand-static { position: relative; }
  [role="dialog"] aside a.local-brand-static {
    cursor: default !important;
    text-decoration: none !important;
  }
  [role="dialog"] aside a[href="/"] > svg,
  [role="dialog"] aside a[href="/zh-CN/workbench"] > svg,
  [role="dialog"] aside a.local-brand-static > svg { opacity: 0 !important; }
  [role="dialog"] aside a[href="/"]::after,
  [role="dialog"] aside a[href="/zh-CN/workbench"]::after,
  [role="dialog"] aside a.local-brand-static::after {
    content: "";
    position: absolute;
    inset: 0;
    background: url("/_pixpix-assets/local-brand/workbench-logo.png?g-brand-v4") center / contain no-repeat;
    filter: none;
    pointer-events: none;
  }
  html.dark [role="dialog"] aside a[href="/"]::after,
  html.dark [role="dialog"] aside a[href="/zh-CN/workbench"]::after,
  html.dark [role="dialog"] aside a.local-brand-static::after,
  html[data-theme="dark"] [role="dialog"] aside a[href="/"]::after,
  html[data-theme="dark"] [role="dialog"] aside a[href="/zh-CN/workbench"]::after,
  html[data-theme="dark"] [role="dialog"] aside a.local-brand-static::after,
  body.dark [role="dialog"] aside a[href="/"]::after,
  body.dark [role="dialog"] aside a[href="/zh-CN/workbench"]::after,
  body.dark [role="dialog"] aside a.local-brand-static::after { filter: invert(1) brightness(1.3); }
</style>`;

const localRootNavigationScript = `<script id="local-root-navigation">
  (() => {
    const normalizeBrandLink = () => {
      for (const link of document.querySelectorAll('[role="dialog"] aside a')) {
        link.classList.add("local-brand-static");
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
        link.setAttribute("tabindex", "-1");
      }
    };

    // The logo is decorative in this single-page local build.
    new MutationObserver(normalizeBrandLink).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    document.addEventListener("DOMContentLoaded", normalizeBrandLink, { once: true });

    // Cancel any hydrated navigation handler before React handles the logo.
    document.addEventListener("click", (event) => {
      const target = event.target;
      const link = target instanceof Element ? target.closest('[role="dialog"] aside a') : null;
      if (!link) return;
      event.preventDefault();
      event.stopImmediatePropagation();
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

const localWorkbenchSettingsButtonScript = "<script id=\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\">\n(() => {\n  const setup = () => {\n    const pageDialog = document.querySelector('[role=\"dialog\"]');\n    const header = pageDialog?.querySelector(':scope > .flex.size-full > aside');\n    if (!header || header.dataset.localSettingsButton === \"ready\") return Boolean(header);\n    const button = document.createElement(\"button\");\n    button.type = \"button\"; button.className = \"local-workbench-settings-button\";\n    button.setAttribute(\"aria-label\",\"设置配置\"); button.setAttribute(\"aria-controls\",\"local-workbench-settings-modal\"); button.setAttribute(\"aria-expanded\",\"false\"); button.title=\"设置配置\";\n    button.innerHTML = '<svg fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\"></path><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 12a3 3 0 11-6 0 3 3 0 016 0z\"></path></svg>';\n    const modal = document.createElement(\"div\");\n    modal.id=\"M15 12a3 3 0 11-6 0 3 3 0 016 0z\"; modal.className=\"local-settings-modal\"; modal.hidden=true; modal.setAttribute(\"aria-hidden\",\"true\");\n    const gear = '<svg class=\"settings-modal-gear\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\"></path><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 12a3 3 0 11-6 0 3 3 0 016 0z\"></path></svg>';\n    modal.innerHTML = \"\\n<div class=\\\"local-settings-backdrop\\\"></div>\\n<div class=\\\"local-settings-dialog\\\" role=\\\"dialog\\\" aria-modal=\\\"true\\\" aria-labelledby=\\\"local-settings-title\\\">\\n  <header class=\\\"local-settings-header\\\"><div class=\\\"local-settings-title\\\" id=\\\"local-settings-title\\\"><svg class=\\\"settings-modal-gear\\\" fill=\\\"none\\\" stroke=\\\"currentColor\\\" viewBox=\\\"0 0 24 24\\\" aria-hidden=\\\"true\\\"><path stroke-linecap=\\\"round\\\" stroke-linejoin=\\\"round\\\" stroke-width=\\\"2\\\" d=\\\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\\\"></path><path stroke-linecap=\\\"round\\\" stroke-linejoin=\\\"round\\\" stroke-width=\\\"2\\\" d=\\\"M15 12a3 3 0 11-6 0 3 3 0 016 0z\\\"></path></svg><span>设置</span></div><span class=\\\"local-settings-version\\\">v0.7.12</span><button type=\\\"button\\\" class=\\\"local-settings-close\\\" aria-label=\\\"关闭设置\\\">×</button></header>\\n  <div class=\\\"local-settings-layout\\\">\\n    <nav class=\\\"local-settings-sidebar\\\">\\n      <button class=\\\"local-settings-tab active\\\" data-tab=\\\"api\\\"><span class=\\\"local-settings-tab-icon\\\">⌕</span><span>API 配置</span></button>\\n      <button class=\\\"local-settings-tab\\\" data-tab=\\\"fallback\\\"><span class=\\\"local-settings-tab-icon\\\">⇄</span><span>Fallback 配置</span></button>\\n      <button class=\\\"local-settings-tab\\\" data-tab=\\\"general\\\"><span class=\\\"local-settings-tab-icon\\\">◷</span><span>习惯配置</span></button>\\n      <button class=\\\"local-settings-tab\\\" data-tab=\\\"agent\\\"><span class=\\\"local-settings-tab-icon\\\">♙</span><span>Agent 配置</span></button>\\n      <button class=\\\"local-settings-tab\\\" data-tab=\\\"data\\\"><span class=\\\"local-settings-tab-icon\\\">▣</span><span>数据管理</span></button>\\n      <button class=\\\"local-settings-tab\\\" data-tab=\\\"about\\\"><span class=\\\"local-settings-tab-icon\\\">ⓘ</span><span>关于</span></button>\\n    </nav>\\n    <main class=\\\"local-settings-content\\\">\\n      <section class=\\\"local-settings-panel active\\\" data-panel=\\\"api\\\">\\n        <div class=\\\"local-settings-panel-head\\\"><h4>当前配置 <span>↗</span></h4><div class=\\\"local-settings-inline-actions\\\"><button type=\\\"button\\\" class=\\\"local-settings-small\\\" data-api-action=\\\"create\\\">＋ 新配置</button><button type=\\\"button\\\" class=\\\"local-settings-small\\\" data-api-action=\\\"duplicate\\\">复制当前</button><button type=\\\"button\\\" class=\\\"local-settings-small danger\\\" data-api-action=\\\"delete\\\">删除</button></div></div>\\n        <select class=\\\"local-settings-select\\\" aria-label=\\\"当前配置\\\"><option>IXYAPI　OpenAI</option><option>hi-code　OpenAI</option><option>zzone　OpenAI</option><option>jojocode　OpenAI</option></select>\\n        <div class=\\\"local-settings-info\\\"><span class=\\\"info-mark\\\">i</span><strong>余额 ¥2.52；仅支持 gpt-image-2，¥0.08/张。优先级 2，余额用完即弃；明确余额不足后自动跳过。可在「Fallback 配置」中调整顺序、停用或重新启用。</strong></div>\\n        <label class=\\\"local-settings-label\\\">配置名称<input class=\\\"local-settings-field\\\" value=\\\"IXYAPI\\\"></label>\\n        <label class=\\\"local-settings-label\\\">服务商类型<select class=\\\"local-settings-select\\\"><option>OpenAI 兼容接口</option><option>fal.ai</option><option>自定义服务商</option></select></label>\\n        <label class=\\\"local-settings-label\\\">API URL<input class=\\\"local-settings-field\\\" value=\\\"https://www.tixyw.com/v1\\\"></label>\\n        <p class=\\\"local-settings-help\\\">末尾带 / 时直接使用该地址拼接接口，不补 /v1 前缀，支持通过查询参数覆盖：?apiUrl=。</p>\\n        <label class=\\\"local-settings-label\\\">API Key<input class=\\\"local-settings-field\\\" type=\\\"password\\\" value=\\\"sk-••••••••••••••••••••\\\"></label>\\n        <label class=\\\"local-settings-label\\\">图像模型<input class=\\\"local-settings-field\\\" value=\\\"gpt-image-2\\\"></label>\\n        <label class=\\\"local-settings-label\\\">API 模式<select class=\\\"local-settings-select\\\"><option>Images API</option><option>Responses API</option></select></label>\\n        <div class=\\\"local-settings-grid\\\"><label class=\\\"local-settings-label\\\">请求超时<input class=\\\"local-settings-field\\\" type=\\\"number\\\" value=\\\"120\\\"></label><label class=\\\"local-settings-label\\\">推理强度<select class=\\\"local-settings-select\\\"><option>默认</option><option>low</option><option>medium</option><option>high</option></select></label></div>\\n        <div class=\\\"local-settings-option-list\\\">\\n          <div class=\\\"local-settings-option\\\"><span>启用 API 代理</span><button type=\\\"button\\\" class=\\\"local-settings-switch\\\" data-toggle=\\\"proxy\\\" aria-pressed=\\\"false\\\"><i></i></button></div>\\n          <div class=\\\"local-settings-option\\\"><span>流式返回图片</span><button type=\\\"button\\\" class=\\\"local-settings-switch on\\\" data-toggle=\\\"stream\\\" aria-pressed=\\\"true\\\"><i></i></button></div>\\n          <div class=\\\"local-settings-option\\\"><span>返回 Base64 图片数据</span><button type=\\\"button\\\" class=\\\"local-settings-switch\\\" data-toggle=\\\"base64\\\" aria-pressed=\\\"false\\\"><i></i></button></div>\\n          <div class=\\\"local-settings-option\\\"><span>允许 Codex CLI 兼容模式</span><button type=\\\"button\\\" class=\\\"local-settings-switch\\\" data-toggle=\\\"codex\\\" aria-pressed=\\\"false\\\"><i></i></button></div>\\n        </div>\\n        <button class=\\\"local-settings-action local-settings-save\\\" type=\\\"button\\\">保存当前配置</button><span class=\\\"local-settings-status\\\" role=\\\"status\\\"></span>\\n      </section>\\n      <section class=\\\"local-settings-panel\\\" data-panel=\\\"fallback\\\">\\n        <h4>失败自动切换</h4><p class=\\\"local-settings-muted\\\">从上到下依次尝试已勾选的中转站。明确失败、余额不足时切换下一站；结果不明时暂停，避免重复扣费。</p>\\n        <div class=\\\"local-settings-card\\\"><div class=\\\"local-settings-option\\\"><strong>启用 Fallback 自动切换</strong><button type=\\\"button\\\" class=\\\"local-settings-switch on\\\" data-toggle=\\\"fallback\\\" aria-pressed=\\\"true\\\"><i></i></button></div><p>关闭后仅请求 API 配置当前选中的站点。</p></div>\\n        <div class=\\\"local-settings-panel-head\\\"><h4 class=\\\"sub\\\">中转站顺序</h4><button type=\\\"button\\\" class=\\\"local-settings-small\\\" data-fallback-reset>恢复默认顺序</button></div>\\n        <div class=\\\"local-settings-fallback-list\\\" role=\\\"list\\\">\\n          <div class=\\\"local-settings-fallback-row\\\" data-provider=\\\"zzone\\\"><button type=\\\"button\\\" class=\\\"local-settings-drag\\\">⠿</button><b>1</b><label><input type=\\\"checkbox\\\" checked> <strong>zzone</strong><small>gpt-image-2.5-sunburst · ¥0.06/张 · https://zzone.cc.cd</small></label><button type=\\\"button\\\" data-move=\\\"up\\\">↑</button><button type=\\\"button\\\" data-move=\\\"down\\\">↓</button></div>\\n          <div class=\\\"local-settings-fallback-row\\\" data-provider=\\\"ixyapi\\\"><button type=\\\"button\\\" class=\\\"local-settings-drag\\\">⠿</button><b>2</b><label><input type=\\\"checkbox\\\" checked> <strong>IXYAPI</strong><small>gpt-image-2 · ¥0.08/张 · https://www.tixyw.com</small></label><button type=\\\"button\\\" data-move=\\\"up\\\">↑</button><button type=\\\"button\\\" data-move=\\\"down\\\">↓</button></div>\\n          <div class=\\\"local-settings-fallback-row\\\" data-provider=\\\"jojocode\\\"><button type=\\\"button\\\" class=\\\"local-settings-drag\\\">⠿</button><b>3</b><label><input type=\\\"checkbox\\\" checked> <strong>jojocode</strong><small>gpt-image-2 / 4k · ¥0.10/张 · https://api2.jojocode.com/v1</small></label><button type=\\\"button\\\" data-move=\\\"up\\\">↑</button><button type=\\\"button\\\" data-move=\\\"down\\\">↓</button></div>\\n          <div class=\\\"local-settings-fallback-row\\\" data-provider=\\\"hi-code\\\"><button type=\\\"button\\\" class=\\\"local-settings-drag\\\">⠿</button><b>4</b><label><input type=\\\"checkbox\\\" checked> <strong>hi-code</strong><small>gpt-image-2.5-sunburst / flare · ¥0.22/张 · https://api-cn.hi-code.cc/v1</small></label><button type=\\\"button\\\" data-move=\\\"up\\\">↑</button><button type=\\\"button\\\" data-move=\\\"down\\\">↓</button></div>\\n        </div>\\n        <div class=\\\"local-settings-card\\\"><strong>实际请求顺序</strong><p class=\\\"local-settings-status\\\">zzone → IXYAPI → jojocode → hi-code</p></div>\\n      </section>\\n      <section class=\\\"local-settings-panel\\\" data-panel=\\\"general\\\">\\n        <h4>习惯配置</h4>\\n        <div class=\\\"local-settings-option-list\\\">\\n          <div class=\\\"local-settings-option\\\"><span>任务提交方式</span><select class=\\\"local-settings-mini-select\\\"><option>发送按钮</option><option>回车/发送按钮</option></select></div>\\n          <div class=\\\"local-settings-option\\\"><span>提交任务后清空输入框</span><button class=\\\"local-settings-switch on\\\" data-toggle=\\\"clear-input\\\" aria-pressed=\\\"true\\\"><i></i></button></div>\\n          <div class=\\\"local-settings-option\\\"><span>重启后加载上次的输入框</span><button class=\\\"local-settings-switch on\\\" data-toggle=\\\"persist-input\\\" aria-pressed=\\\"true\\\"><i></i></button></div>\\n          <div class=\\\"local-settings-option\\\"><span>复用配置时临时复用任务 API 配置</span><button class=\\\"local-settings-switch\\\" data-toggle=\\\"reuse-api\\\" aria-pressed=\\\"false\\\"><i></i></button></div>\\n          <div class=\\\"local-settings-option\\\"><span>成功任务仍然展示重试按钮</span><button class=\\\"local-settings-switch\\\" data-toggle=\\\"retry\\\" aria-pressed=\\\"false\\\"><i></i></button></div>\\n          <div class=\\\"local-settings-option\\\"><span>允许模型改写优化提示词</span><button class=\\\"local-settings-switch\\\" data-toggle=\\\"rewrite\\\" aria-pressed=\\\"false\\\"><i></i></button></div>\\n          <div class=\\\"local-settings-option\\\"><span>任务完成后发送系统通知</span><button class=\\\"local-settings-switch\\\" data-toggle=\\\"notification\\\" aria-pressed=\\\"false\\\"><i></i></button></div>\\n          <div class=\\\"local-settings-option\\\"><span>发送消息后自动滚动到底部</span><button class=\\\"local-settings-switch\\\" data-toggle=\\\"scroll-bottom\\\" aria-pressed=\\\"true\\\"><i></i></button></div>\\n          <div class=\\\"local-settings-option\\\"><span>公式输出提示</span><button class=\\\"local-settings-switch\\\" data-toggle=\\\"math\\\" aria-pressed=\\\"false\\\"><i></i></button></div>\\n        </div>\\n        <div class=\\\"local-settings-card\\\"><strong>固定上架参数</strong><p>上架平台 · Wildberries　　语言 · 俄语</p></div>\\n      </section>\\n      <section class=\\\"local-settings-panel\\\" data-panel=\\\"agent\\\">\\n        <h4>Agent 配置</h4>\\n        <div class=\\\"local-settings-option\\\"><span>使用独立的 API 配置</span><select class=\\\"local-settings-mini-select\\\"><option>关闭</option><option>原生</option><option>混合</option></select></div>\\n        <p class=\\\"local-settings-muted\\\">原生：使用 Responses API 配置，由模型调用 image_generation 工具生成图片。<br>混合：使用文本模型调用自定义工具，请求图像模型生成图像。</p>\\n        <div class=\\\"local-settings-option\\\"><span>文本模型 API 配置</span><select class=\\\"local-settings-mini-select\\\"><option>IXYAPI · gpt-image-2</option><option>选择配置</option></select></div>\\n        <div class=\\\"local-settings-option\\\"><span>图像模型 API 配置</span><select class=\\\"local-settings-mini-select\\\"><option>IXYAPI · OpenAI</option><option>选择配置</option></select></div>\\n        <label class=\\\"local-settings-label\\\">最大工具调用轮数<input class=\\\"local-settings-field\\\" type=\\\"number\\\" min=\\\"1\\\" max=\\\"50\\\" value=\\\"15\\\"></label>\\n        <div class=\\\"local-settings-option\\\"><span>网络搜索</span><button class=\\\"local-settings-switch\\\" data-toggle=\\\"web-search\\\" aria-pressed=\\\"false\\\"><i></i></button></div>\\n      </section>\\n      <section class=\\\"local-settings-panel\\\" data-panel=\\\"data\\\">\\n        <h4>数据管理</h4><p class=\\\"local-settings-muted\\\">所有配置、任务和生成图片均仅保存在浏览器本地。建议定期导出备份。</p>\\n        <div class=\\\"local-settings-grid\\\"><div class=\\\"local-settings-card\\\"><strong>导出数据</strong><p>选择要包含的内容并导出 JSON 备份。</p><label class=\\\"local-settings-check\\\"><input type=\\\"checkbox\\\" checked> 包含配置</label><label class=\\\"local-settings-check\\\"><input type=\\\"checkbox\\\" checked> 包含任务</label><button class=\\\"local-settings-action\\\" data-data-action=\\\"export\\\" type=\\\"button\\\">导出所选数据</button></div><div class=\\\"local-settings-card\\\"><strong>导入数据</strong><p>支持一次导入多个普通备份。</p><label class=\\\"local-settings-check\\\"><input type=\\\"checkbox\\\" checked> 包含配置</label><label class=\\\"local-settings-check\\\"><input type=\\\"checkbox\\\" checked> 包含任务</label><button class=\\\"local-settings-action\\\" data-data-action=\\\"import\\\" type=\\\"button\\\">从文件导入</button><input class=\\\"local-settings-file\\\" type=\\\"file\\\" accept=\\\".json,.zip\\\"></div></div>\\n        <div class=\\\"local-settings-card danger-card\\\"><strong>清除数据</strong><p>清除前请先导出备份，此操作不可恢复。</p><label class=\\\"local-settings-check\\\"><input type=\\\"checkbox\\\"> 清除配置</label><label class=\\\"local-settings-check\\\"><input type=\\\"checkbox\\\"> 清除任务</label><button class=\\\"local-settings-action danger-action\\\" data-data-action=\\\"clear\\\" type=\\\"button\\\">清空所选数据</button></div>\\n      </section>\\n      <section class=\\\"local-settings-panel\\\" data-panel=\\\"about\\\"><h4>关于</h4><div class=\\\"local-settings-card\\\"><strong>GPT Image Playground</strong><p>版本 v0.7.12</p><p>本地图片生成工作台，支持多 API 配置、Fallback、Agent 与数据备份。</p><p class=\\\"local-settings-help\\\">当前 Guan A+ 工作台按其设置结构适配为离线本地版本。</p></div><button type=\\\"button\\\" class=\\\"local-settings-action\\\" data-about-action>检查更新</button></section>\\n    </main>\\n  </div>\\n</div>\";\n    const close=()=>{modal.hidden=true;modal.setAttribute(\"aria-hidden\",\"true\");button.setAttribute(\"aria-expanded\",\"false\");document.body.style.overflow=\"\";};\n    const open=()=>{modal.hidden=false;modal.setAttribute(\"aria-hidden\",\"false\");button.setAttribute(\"aria-expanded\",\"true\");document.body.style.overflow=\"hidden\";};\n    const switchTab=(tab)=>{modal.querySelectorAll(\".local-settings-tab\").forEach((item)=>item.classList.toggle(\"active\",item.dataset.tab===tab));modal.querySelectorAll(\".local-settings-panel\").forEach((item)=>item.classList.toggle(\"active\",item.dataset.panel===tab));};\n    button.addEventListener(\"click\",open); modal.querySelector(\".local-settings-close\").addEventListener(\"click\",close); modal.querySelector(\".local-settings-backdrop\").addEventListener(\"click\",close); modal.querySelector(\".local-settings-dialog\").addEventListener(\"pointerdown\",(event)=>event.stopPropagation()); modal.querySelector(\".local-settings-dialog\").addEventListener(\"click\",(event)=>event.stopPropagation());\n    modal.querySelectorAll(\".local-settings-tab\").forEach((tab)=>tab.addEventListener(\"click\",()=>switchTab(tab.dataset.tab))); modal.querySelectorAll(\".local-settings-switch\").forEach((item)=>item.addEventListener(\"click\",()=>{const on=item.classList.toggle(\"on\");item.setAttribute(\"aria-pressed\",String(on));})); modal.querySelectorAll(\".local-settings-fallback-row [data-move]\").forEach((item)=>item.addEventListener(\"click\",()=>{const row=item.closest(\".local-settings-fallback-row\");const sibling=item.dataset.move===\"up\"?row?.previousElementSibling:row?.nextElementSibling;if(row&&sibling){if(item.dataset.move===\"up\")row.parentNode.insertBefore(row,sibling);else row.parentNode.insertBefore(sibling,row);row.parentNode.querySelectorAll(\".local-settings-fallback-row > b\").forEach((n,i)=>n.textContent=String(i+1));}})); modal.querySelector(\".local-settings-save\")?.addEventListener(\"click\",()=>{const status=modal.querySelector(\".local-settings-save + .local-settings-status\");if(status)status.textContent=\"已保存到当前设备\";}); modal.querySelector(\"[data-data-action=export]\")?.addEventListener(\"click\",()=>{const blob=new Blob([JSON.stringify({version:\"0.7.12\",savedAt:new Date().toISOString(),source:\"guan-workbench\"},null,2)],{type:\"application/json\"});const link=document.createElement(\"a\");link.href=URL.createObjectURL(blob);link.download=\"guan-workbench-settings.json\";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}); modal.querySelector(\"[data-data-action=import]\")?.addEventListener(\"click\",()=>modal.querySelector(\".local-settings-file\")?.click()); modal.querySelector(\"[data-data-action=clear]\")?.addEventListener(\"click\",()=>{if(window.confirm(\"确定清空所选数据吗？此操作不可恢复。\"))modal.querySelector(\".danger-card .local-settings-status\")?.replaceChildren(\"已清除\");});\n    document.addEventListener(\"keydown\",(event)=>{if(event.key===\"Escape\"&&!modal.hidden)close();});\n    header.append(button); document.body.append(modal); header.dataset.localSettingsButton=\"ready\"; return true;\n  };\n  const observer=new MutationObserver(()=>{if(setup())observer.disconnect();}); observer.observe(document.documentElement,{childList:true,subtree:true}); setup();\n})();\n</script>";
const localSettingsModalStyle = "<style id=\"local-settings-modal-style\">\n.local-settings-modal[hidden]{display:none!important}\n.local-settings-modal,.local-settings-dialog,.local-settings-sidebar,.local-settings-content{pointer-events:auto!important}\n.local-settings-modal{position:fixed!important;inset:0!important;z-index:240!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:32px!important;color:#f5f5f7!important;font-family:inherit!important}\n.local-settings-backdrop{position:absolute!important;inset:0!important;background:rgba(0,0,0,.76)!important;backdrop-filter:blur(11px)!important;animation:local-settings-fade-in .24s ease both!important}\n.local-settings-dialog{position:relative!important;z-index:1!important;display:flex!important;flex-direction:column!important;width:min(1090px,calc(100vw - 40px))!important;height:min(860px,calc(100vh - 64px))!important;min-height:520px!important;overflow:hidden!important;border:1px solid rgba(255,255,255,.11)!important;border-radius:28px!important;background:#1a1a1d!important;box-shadow:0 28px 90px rgba(0,0,0,.62),0 0 0 1px rgba(255,255,255,.04) inset!important;animation:local-settings-dialog-in .28s cubic-bezier(.2,.8,.2,1) both!important}\n.local-settings-header{display:flex!important;align-items:center!important;justify-content:space-between!important;flex:0 0 98px!important;padding:0 30px 0 34px!important;border-bottom:1px solid rgba(255,255,255,.1)!important}\n.local-settings-title{display:flex!important;align-items:center!important;gap:15px!important;font-size:24px!important;font-weight:700!important}\n.local-settings-title svg{width:25px!important;height:25px!important;color:#4f9cff!important}\n.local-settings-version{margin-left:auto!important;margin-right:26px!important;color:#7c7c87!important;font:600 17px/1 ui-monospace,SFMono-Regular,Menlo,monospace!important}\n.local-settings-close{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:42px!important;height:42px!important;border:0!important;border-radius:12px!important;background:transparent!important;color:#aeb0ba!important;font-size:31px!important;font-weight:300!important;line-height:1!important;cursor:pointer!important;transition:background .16s ease,color .16s ease,transform .16s ease!important}\n.local-settings-close:hover{background:rgba(255,255,255,.08)!important;color:#fff!important}.local-settings-close:active{transform:scale(.92)!important}\n.local-settings-layout{display:flex!important;flex:1 1 auto!important;min-height:0!important}\n.local-settings-sidebar{display:flex!important;flex:0 0 274px!important;flex-direction:column!important;gap:8px!important;padding:22px 18px!important;border-right:1px solid rgba(255,255,255,.1)!important;background:rgba(255,255,255,.025)!important}\n.local-settings-tab{display:flex!important;align-items:center!important;gap:15px!important;min-height:58px!important;padding:0 20px!important;border:0!important;border-radius:17px!important;background:transparent!important;color:#aeb0ba!important;font-size:19px!important;text-align:left!important;cursor:pointer!important;transition:background .18s ease,color .18s ease,transform .18s ease!important}\n.local-settings-tab:hover{background:rgba(255,255,255,.055)!important;color:#e8e8ed!important}.local-settings-tab.active{background:rgba(255,255,255,.11)!important;color:#58a1ff!important;font-weight:600!important}.local-settings-tab:active{transform:scale(.985)!important}\n.local-settings-tab-icon{width:22px!important;color:currentColor!important;font-size:23px!important;line-height:1!important;text-align:center!important}\n.local-settings-content{flex:1 1 auto!important;min-width:0!important;overflow:auto!important;padding:34px 34px 44px!important}\n.local-settings-panel{display:none!important;max-width:780px!important}.local-settings-panel.active{display:block!important;animation:local-settings-panel-in .2s ease both!important}\n.local-settings-panel h4{margin:0 0 18px!important;color:#ececf1!important;font-size:21px!important;font-weight:700!important}.local-settings-panel h4 span{margin-left:9px!important;color:#8b8d97!important;font-size:20px!important}\n.local-settings-label{display:block!important;margin:22px 0 9px!important;color:#e5e5eb!important;font-size:18px!important;font-weight:600!important}\n.local-settings-field,.local-settings-select{box-sizing:border-box!important;width:100%!important;height:58px!important;padding:0 18px!important;border:1px solid rgba(255,255,255,.11)!important;border-radius:18px!important;outline:none!important;background:rgba(255,255,255,.035)!important;color:#eeeef2!important;font:500 18px/1 inherit!important;transition:border-color .18s ease,background .18s ease,box-shadow .18s ease!important}\n.local-settings-field:focus,.local-settings-select:focus{border-color:#468fe8!important;background:rgba(255,255,255,.06)!important;box-shadow:0 0 0 3px rgba(70,143,232,.18)!important}.local-settings-select{appearance:auto!important}\n.local-settings-info{margin-top:16px!important;padding:20px 22px!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:18px!important;color:#d9d9df!important;background:rgba(255,255,255,.035)!important;font-size:17px!important;line-height:1.75!important}.local-settings-info strong{color:#f2f2f5!important}.info-mark{display:inline-flex!important;width:22px!important;height:22px!important;align-items:center!important;justify-content:center!important;margin-right:11px!important;border:2px solid #4f9cff!important;border-radius:50%!important;color:#4f9cff!important;font-weight:700!important}.local-settings-help{margin:8px 0 0!important;color:#8f909a!important;font-size:15px!important;line-height:1.55!important}\n.local-settings-grid{display:grid!important;grid-template-columns:1fr 1fr!important;gap:18px!important}.local-settings-card{padding:20px!important;border:1px solid rgba(255,255,255,.1)!important;border-radius:18px!important;background:rgba(255,255,255,.035)!important}.local-settings-card strong{display:block!important;margin-bottom:8px!important;color:#f0f0f4!important;font-size:18px!important}.local-settings-card p{margin:0!important;color:#9697a1!important;font-size:15px!important;line-height:1.55!important}\n.local-settings-action{margin-top:24px!important;padding:13px 20px!important;border:0!important;border-radius:13px!important;background:#3e8ff5!important;color:#fff!important;font-size:16px!important;cursor:pointer!important}.local-settings-action:hover{background:#579dff!important}.local-settings-muted{color:#9697a1!important;font-size:16px!important;line-height:1.7!important}\n@keyframes local-settings-fade-in{from{opacity:0}to{opacity:1}}@keyframes local-settings-dialog-in{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes local-settings-panel-in{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}\n@media(max-width:760px){.local-settings-modal{padding:10px!important}.local-settings-dialog{width:calc(100vw - 20px)!important;height:calc(100vh - 20px)!important;min-height:0!important;border-radius:20px!important}.local-settings-header{flex-basis:74px!important;padding:0 16px 0 20px!important}.local-settings-title{font-size:20px!important}.local-settings-version{margin-right:8px!important;font-size:13px!important}.local-settings-layout{flex-direction:column!important}.local-settings-sidebar{flex:0 0 auto!important;flex-direction:row!important;overflow-x:auto!important;padding:10px!important;border-right:0!important;border-bottom:1px solid rgba(255,255,255,.1)!important}.local-settings-tab{min-height:43px!important;padding:0 14px!important;border-radius:12px!important;font-size:14px!important}.local-settings-tab-icon{width:auto!important;font-size:17px!important}.local-settings-content{padding:22px 18px 30px!important}.local-settings-grid{grid-template-columns:1fr!important}.local-settings-field,.local-settings-select{height:50px!important;font-size:16px!important}}\n.local-settings-panel-head{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:12px!important}.local-settings-panel-head h4{margin-bottom:0!important}.local-settings-panel-head h4.sub{font-size:18px!important}.local-settings-inline-actions{display:flex!important;gap:7px!important;flex-wrap:wrap!important}.local-settings-small{padding:7px 10px!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:10px!important;background:rgba(255,255,255,.04)!important;color:#bfc0c9!important;font-size:13px!important;cursor:pointer!important}.local-settings-small:hover{background:rgba(255,255,255,.1)!important;color:#fff!important}.local-settings-small.danger{color:#e88b95!important}.local-settings-option-list{display:flex!important;flex-direction:column!important;gap:2px!important;margin-top:18px!important}.local-settings-option{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:18px!important;min-height:54px!important;padding:10px 0!important;border-bottom:1px solid rgba(255,255,255,.07)!important;color:#d8d8df!important;font-size:16px!important}.local-settings-option:last-child{border-bottom:0!important}.local-settings-switch{position:relative!important;width:42px!important;height:24px!important;flex:0 0 42px!important;padding:0!important;border:0!important;border-radius:99px!important;background:#4a4b52!important;cursor:pointer!important;transition:background .18s ease!important}.local-settings-switch i{position:absolute!important;top:3px!important;left:3px!important;width:18px!important;height:18px!important;border-radius:50%!important;background:#c4c5cc!important;transition:transform .18s ease,background .18s ease!important}.local-settings-switch.on{background:#3f8ff3!important}.local-settings-switch.on i{transform:translateX(18px)!important;background:#fff!important}.local-settings-mini-select{min-width:150px!important;padding:8px 12px!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:11px!important;background:rgba(255,255,255,.05)!important;color:#e6e6ec!important;font-size:14px!important}.local-settings-fallback-list{display:flex!important;flex-direction:column!important;gap:8px!important;margin:14px 0 18px!important}.local-settings-fallback-row{display:grid!important;grid-template-columns:26px 22px minmax(0,1fr) 28px 28px!important;align-items:center!important;gap:8px!important;padding:12px!important;border:1px solid rgba(255,255,255,.1)!important;border-radius:14px!important;background:rgba(255,255,255,.035)!important}.local-settings-fallback-row label{min-width:0!important;color:#e7e7ec!important}.local-settings-fallback-row label strong{display:block!important}.local-settings-fallback-row small{display:block!important;margin-top:4px!important;overflow:hidden!important;color:#92939d!important;font-size:12px!important;text-overflow:ellipsis!important;white-space:nowrap!important}.local-settings-fallback-row>button{border:0!important;background:transparent!important;color:#aeb0ba!important;cursor:pointer!important}.local-settings-fallback-row>button:hover{color:#fff!important}.local-settings-drag{font-size:18px!important}.local-settings-check{display:block!important;margin-top:10px!important;color:#c7c8d0!important;font-size:14px!important}.local-settings-check input,.local-settings-fallback-row input{accent-color:#428ff4!important}.local-settings-file{display:block!important;margin-top:12px!important;color:#b5b6c0!important;font-size:13px!important}.danger-card{margin-top:20px!important;border-color:rgba(221,102,111,.3)!important}.danger-card strong{color:#ef9aa2!important}.danger-action{background:#a94c55!important}.danger-action:hover{background:#c25b66!important}.local-settings-status{margin-left:10px!important;color:#68b0ff!important;font-size:13px!important}</style>";

const originalPlaygroundSettingsButtonScript = `<script id="original-playground-settings-button">
(() => {
  const setup = () => {
    const dialog = document.querySelector('[role="dialog"]');
    const header = dialog?.querySelector(':scope > .flex.size-full > aside');
    if (!header || header.querySelector('.local-workbench-settings-button')) return Boolean(header);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'local-workbench-settings-button';
    button.setAttribute('aria-label', '设置配置');
    button.setAttribute('aria-controls', 'playground-settings-root');
    button.setAttribute('aria-expanded', 'false');
    button.title = '设置配置';
    button.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>';
    header.append(button);
    return true;
  };

  const observer = new MutationObserver(() => {
    if (setup()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setup();
})();
</script>`;

const localThemeToggleScript = `<script id="local-theme-toggle">
(() => {
  const storageKey = "guan-workbench-theme";
  const icons = {
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"></path></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.9 13.2A8.5 8.5 0 0 1 10.8 3.1 8.5 8.5 0 1 0 20.9 13.2Z"></path></svg>',
  };
  const getTheme = () => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "dark" || saved === "light") return saved;
    } catch {}
    return document.documentElement.dataset.workbenchTheme === "dark" ? "dark" : "light";
  };
  const applyTheme = (theme) => {
    document.documentElement.dataset.workbenchTheme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.body?.classList.toggle("dark", theme === "dark");
    try { localStorage.setItem(storageKey, theme); } catch {}
    const button = document.querySelector(".local-workbench-theme-button");
    if (!button) return;
    const icon = theme === "dark" ? icons.light : icons.dark;
    if (button.innerHTML !== icon) button.innerHTML = icon;
    button.setAttribute("aria-pressed", String(theme === "dark"));
    button.setAttribute("aria-label", theme === "dark" ? "切换浅色主题" : "切换深色主题");
    button.title = theme === "dark" ? "切换浅色主题" : "切换深色主题";
  };
  applyTheme(getTheme());

  const setup = () => {
    const dialog = document.querySelector('[role="dialog"]');
    const header = dialog?.querySelector(':scope > .flex.size-full > aside');
    if (!header) return false;
    let button = header.querySelector(".local-workbench-theme-button");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "local-workbench-theme-button";
      button.addEventListener("click", () => applyTheme(getTheme() === "dark" ? "light" : "dark"));
      const settingsButton = header.querySelector(".local-workbench-settings-button");
      if (settingsButton) header.insertBefore(button, settingsButton);
      else header.append(button);
    }
    applyTheme(getTheme());
    return true;
  };
  const observer = new MutationObserver(setup);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setup();
})();
</script>`;

const localThemeAndUiStyle = `<style id="local-theme-and-ui-style">
  /* The A+ selector is a visual status pill in this single-tool MVP. */
  [role="dialog"] [role="radiogroup"][aria-label="工具类型"] [role="radio"] {
    pointer-events: none !important;
    cursor: default !important;
  }
  [role="dialog"] [role="radiogroup"][aria-label="工具类型"] [role="radio"][data-state="on"] {
    border: 0 !important;
    border-radius: 9999px !important;
    background: #0d0d0e !important;
    color: #fff !important;
    box-shadow: none !important;
  }
  [role="dialog"] [role="radiogroup"][aria-label="工具类型"] [role="radio"][data-state="on"] svg {
    color: #fff !important;
  }
  [role="dialog"] [data-slot="field-group"] > [data-slot="item"] {
    border-color: #dfdfdf !important;
    background: #fff !important;
  }
  [role="dialog"] textarea {
    border-color: #dfdfdf !important;
    background: #fff !important;
  }
  [role="dialog"] button[type="submit"][disabled] {
    border-color: transparent !important;
    background: #999 !important;
    color: #fff !important;
    opacity: 1 !important;
    box-shadow: none !important;
  }
  [role="dialog"] button[type="submit"][disabled] svg {
    color: #fff !important;
  }
  [role="dialog"] button[type="submit"]:not([disabled]) {
    border-color: #0d0d0e !important;
    background: #0d0d0e !important;
    color: #fff !important;
  }
  .local-workbench-theme-button,
  .local-workbench-settings-button {
    display: inline-flex !important;
    width: 42px !important;
    height: 42px !important;
    flex: 0 0 42px !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 12px !important;
    background: transparent !important;
    color: #5b5c65 !important;
    cursor: pointer !important;
    transition: background-color .16s ease, color .16s ease, transform .16s ease !important;
  }
  .local-workbench-theme-button {
    margin-left: auto !important;
  }
  .local-workbench-settings-button {
    margin-left: 8px !important;
  }
  .local-workbench-theme-button:hover,
  .local-workbench-settings-button:hover {
    background: var(--muted) !important;
  }
  .local-workbench-theme-button:active,
  .local-workbench-settings-button:active {
    transform: scale(.94) !important;
  }
  .local-workbench-theme-button svg,
  .local-workbench-settings-button svg {
    width: 22px !important;
    height: 22px !important;
    pointer-events: none !important;
  }
  html[data-workbench-theme="dark"],
  html[data-workbench-theme="dark"] body {
    background: #111214 !important;
    color-scheme: dark !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] [role="radiogroup"][aria-label="工具类型"] [role="radio"][data-state="on"] {
    background: #f4f4f5 !important;
    color: #161719 !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] [role="radiogroup"][aria-label="工具类型"] [role="radio"][data-state="on"] svg {
    color: #161719 !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] [data-slot="field-group"] > [data-slot="item"] {
    border-color: rgba(255,255,255,.14) !important;
    background: #1b1c1f !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] textarea {
    border-color: rgba(255,255,255,.14) !important;
    background: #1b1c1f !important;
    color: #f4f4f5 !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] button[type="submit"][disabled] {
    background: #5f6064 !important;
    color: #fff !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] button[type="submit"]:not([disabled]) {
    border-color: #f4f4f5 !important;
    background: #f4f4f5 !important;
    color: #161719 !important;
  }
  html[data-workbench-theme="dark"] .local-workbench-theme-button,
  html[data-workbench-theme="dark"] .local-workbench-settings-button {
    color: #e6e7eb !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] .text-foreground,
  html[data-workbench-theme="dark"] [role="dialog"] .text-gray-900 {
    color: #f4f4f5 !important;
  }
</style>`;

const localSettingsRefinementStyle = `<style id="local-settings-refinement-style">
.local-settings-dialog{width:min(768px,calc(100vw - 32px))!important;height:min(600px,calc(100vh - 32px))!important;min-height:420px!important;border-radius:24px!important}
.local-settings-header{flex-basis:68px!important;padding:0 20px!important}
.local-settings-title{gap:9px!important;font-size:18px!important}
.local-settings-title svg{width:20px!important;height:20px!important}
.local-settings-version{margin-right:14px!important;font-size:13px!important}
.local-settings-close{width:32px!important;height:32px!important;font-size:24px!important}
.local-settings-sidebar{flex-basis:192px!important;gap:4px!important;padding:12px!important}
.local-settings-tab{gap:10px!important;min-height:42px!important;padding:0 12px!important;border-radius:12px!important;font-size:14px!important}
.local-settings-tab-icon{width:18px!important;font-size:16px!important}
.local-settings-content{padding:24px 24px 32px!important}
.local-settings-panel h4{margin-bottom:14px!important;font-size:16px!important}
.local-settings-panel h4 span{font-size:15px!important}
.local-settings-label{margin:16px 0 7px!important;font-size:14px!important}
.local-settings-field,.local-settings-select{height:42px!important;padding:0 12px!important;border-radius:12px!important;font-size:14px!important}
.local-settings-info{margin-top:12px!important;padding:13px 15px!important;border-radius:13px!important;font-size:13px!important;line-height:1.65!important}
.local-settings-help{font-size:12px!important}
.local-settings-panel-head h4.sub{font-size:15px!important}
.local-settings-small{padding:6px 8px!important;font-size:11px!important}
.local-settings-option{min-height:42px!important;font-size:14px!important}
.local-settings-card{padding:14px!important;border-radius:14px!important}
.local-settings-card strong{font-size:15px!important}
.local-settings-card p,.local-settings-muted{font-size:13px!important}
.local-settings-action{padding:10px 14px!important;font-size:13px!important}
.local-settings-fallback-row{padding:9px!important}
@media(max-width:760px){.local-settings-dialog{width:calc(100vw - 20px)!important;height:calc(100vh - 20px)!important;min-height:0!important}.local-settings-sidebar{flex-basis:auto!important}.local-settings-content{padding:18px 16px 24px!important}}
</style>
<script id="local-settings-modal-id-fix">
(() => {
  const fix = () => {
    const modal = document.querySelector(".local-settings-modal");
    if (!modal) return false;
    modal.id = "local-workbench-settings-modal";
    document.querySelector(".local-workbench-settings-button")?.setAttribute("aria-controls", modal.id);
    return true;
  };
  const observer = new MutationObserver(() => { if (fix()) observer.disconnect(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  fix();
})();
</script>`;

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
  [role="dialog"] [role="radiogroup"][aria-label="工具类型"] [role="radio"][data-state="on"] {
    border: 1px solid #dedee2 !important;
    border-radius: 9999px !important;
    background: #fff !important;
    color: #202127 !important;
    box-shadow: 0 1px 2px rgb(0 0 0 / 8%) !important;
  }
  [role="dialog"] button:disabled[class*="w-full"][class*="min-h-12"] {
    border: 1px solid #dedee2 !important;
    background: #f1f1f2 !important;
    color: #28292e !important;
    opacity: 1 !important;
    box-shadow: none !important;
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

const imageRelayUpstreams = {
  ixyapi: "www.tixyw.com",
  zzone: "zzone.cc.cd",
  "hi-code": "api-cn.hi-code.cc",
  jojocode: "api2.jojocode.com",
};
const imageRelayEndpoints = new Set(["models", "images/generations", "images/edits", "responses"]);
const localHosts = new Set(["127.0.0.1:5174", "localhost:5174"]);

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
  const isHtml = extname(path).toLowerCase() === ".html";
  response.writeHead(200, {
    "content-type": contentTypes[extname(path).toLowerCase()] || "application/octet-stream",
    "cache-control": isHtml ? "no-store" : "public, max-age=31536000, immutable",
    "content-security-policy": staticOnlyCsp,
    "x-static-archive": "guan-detail-page-static",
  });
  if (method === "HEAD") return response.end();
  if (isHtml) {
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
    response.end(refreshedFavicon.replace("</head>", `${workbenchLogoStyle}${mvpNavigationStyle}${localThemeAndUiStyle}${localRootNavigationScript}${originalPlaygroundSettingsButtonScript}${localThemeToggleScript}${localFixedFieldsScript}${localResolutionButtonsScript}${localAspectRatioButtonsScript}${localOfflineGuardsScript}${localResponsivePreviewScript}<link rel="stylesheet" href="/playground-settings/assets/index.css?v=ui-theme-2"><script type="module" src="/playground-settings/assets/index.js?v=ui-theme-2"></script></head>`));
    return;
  }
  createReadStream(path).pipe(response);
}

async function relayImageApi(request, response, pathname) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  const route = pathname.match(/^\/local-image-api\/(ixyapi|zzone|hi-code|jojocode)\/(models|images\/generations|images\/edits|responses)$/);
  const provider = route?.[1];
  const endpoint = route?.[2];
  const originIsLocal = origin === `http://${host}` || (!origin && request.method === "GET");
  if (!localHosts.has(host) || !originIsLocal) {
    response.writeHead(403, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (!route || !imageRelayUpstreams[provider] || !imageRelayEndpoints.has(endpoint)) {
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if ((endpoint === "models" && request.method !== "GET") || (endpoint !== "models" && request.method !== "POST")) {
    response.writeHead(405, { allow: endpoint === "models" ? "GET" : "POST", "cache-control": "no-store" });
    response.end();
    return;
  }
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > 100 * 1024 * 1024) {
    response.writeHead(413, { "cache-control": "no-store" });
    response.end();
    return;
  }

  const headers = {
    accept: request.headers.accept || "application/json",
    "accept-encoding": "identity",
  };
  if (request.headers.authorization) headers.authorization = request.headers.authorization;
  if (request.headers["content-type"]) headers["content-type"] = request.headers["content-type"];
  if (request.headers["content-length"]) headers["content-length"] = request.headers["content-length"];

  const upstreamUrl = `https://${imageRelayUpstreams[provider]}/v1/${endpoint}`;
  try {
    const abortController = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) abortController.abort();
    });
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : request,
      ...(request.method === "GET" ? {} : { duplex: "half" }),
      redirect: "manual",
      signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(30 * 60 * 1000)]),
    });
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
      "connection": "close",
      "x-image-relay-request-id": randomUUID().replaceAll("-", ""),
      ...(upstream.headers.get("content-length") ? { "content-length": upstream.headers.get("content-length") } : {}),
    });
    if (!upstream.body) return response.end();
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const requestId = randomUUID().replaceAll("-", "");
    const body = JSON.stringify({
      error: {
        code: "local_relay_result_unknown",
        message: "与中转站连接中断，未收到完整结果；上游可能已生成并扣费。将按失败处理并自动切换下一站。",
        request_id: requestId,
      },
    });
    response.writeHead(502, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
      "x-image-result-state": "unknown",
      "x-image-relay-request-id": requestId,
    });
    response.end(body);
  }
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
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname.replace(/\/$/, "") || "/";
  if (pathname.startsWith("/local-image-api/")) {
    if (!["GET", "POST"].includes(method)) {
      response.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" });
      response.end();
      return;
    }
    return relayImageApi(request, response, pathname);
  }
  if (!["GET", "HEAD"].includes(method)) {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  if (pathname.startsWith("/playground-settings/")) {
    const file = safeFile(join(projectRoot, "playground-settings", "dist"), pathname.slice("/playground-settings/".length));
    if (file && await existingFile(file)) return send(response, file, method);
    return notFound(response);
  }

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
