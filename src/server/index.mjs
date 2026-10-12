import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { fetch, ProxyAgent } from "undici";
import { startBuiltInImageProxy } from "./proxy-service.mjs";
import { stopAllProxyProcesses } from "./proxy-process.mjs";
import { prepareRuntimePaths, readProxyState, writePrivateJson, flushPrivateWrites, privateWriteStatus } from "./runtime-paths.mjs";
import { loadPrivateRuntimeEnv } from "./private-env.mjs";
import { ActivityGate } from "./activity-gate.mjs";
import { BrowserActivityReports } from "./browser-activity.mjs";
import { MacKeychainVault } from "./keychain-vault.mjs";
import { CredentialRegistry } from "./credential-registry.mjs";
import { createCredentialHttpHandler } from "./credential-http.mjs";
import { UpdateAuth } from "./update-auth.mjs";
import { SoftwareUpdates } from "./software-updates.mjs";
import { StableDownload } from "./stable-download.mjs";
import { createUpdateStartup } from "./update-startup.mjs";
import { createUpdateHttpHandler } from "./update-http.mjs";
import { UpdateManagerClient } from "./update-manager-client.mjs";
import { UpdateTaskLedger } from "./update-task-ledger.mjs";
import { createUpdateTaskHttpHandler } from "./update-task-http.mjs";
import { createBackendControl } from "./update-backend-control.mjs";
import { portMigrationPage } from "./port-migration-page.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

const { paths: privatePaths } = await prepareRuntimePaths(projectRoot);
await loadPrivateRuntimeEnv(privatePaths.envFile);
const publicRoot = join(projectRoot, "public");
const pageFile = join(publicRoot, "index.html");
const assetRoot = join(publicRoot, "assets");
const infiniteCanvasRoot = join(publicRoot, "infinite-canvas");
const builtInProxyConfigFile = privatePaths.proxyConfigFile;
const port = Number(process.env.PORT || 8888);
const applicationVersion = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version;
const applicationBuildId = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).update(readFileSync(join(infiniteCanvasRoot, "index.html"))).digest("hex").slice(0, 24);
const applicationInstanceId = randomUUID();
const activityGate = new ActivityGate();
const browserActivityReports = new BrowserActivityReports();
const updateTaskLedger = new UpdateTaskLedger({ file: join(privatePaths.updates, "task-ledger.json"),
  version: applicationVersion, instance: applicationInstanceId });
let updateTaskLedgerReady = false;
try { await updateTaskLedger.initialize(); updateTaskLedgerReady = true; }
catch { /* Keep invalid evidence and normal service; automatic installation stays disabled. */ }
const updateTaskHttp = createUpdateTaskHttpHandler({ ledger: updateTaskLedger, origin: `http://127.0.0.1:${port}`,
  ready: updateTaskLedgerReady, activityGate });
const credentialRegistry = new CredentialRegistry({ directory: join(privatePaths.config, "credentials"),
  vault: new MacKeychainVault({ executable: join(privatePaths.runtime, "guan-keychain") }) });
const credentialHttp = createCredentialHttpHandler({ registry: credentialRegistry, origin: `http://127.0.0.1:${port}`, activityGate,
  dispatcherForProfile: profile => profile.kind === "agent" ? undefined : (getImageRelayProxyUrl() ? getImageRelayProxyAgent(getImageRelayProxyUrl()) : undefined) });
const softwareUpdates = new SoftwareUpdates({ directory: privatePaths.updates, currentVersion: applicationVersion,
  manager: new UpdateManagerClient({ socketPath: join(privatePaths.updates, "u.sock") }),
  downloader: new StableDownload({ directory: join(privatePaths.updates, "packages") }),
  auth: new UpdateAuth({ directory: privatePaths.updates, vault: new MacKeychainVault({ executable: join(privatePaths.runtime, "guan-keychain") }) }),
  proxyUrl: () => getImageRelayProxyUrl() });
const updateHttp = createUpdateHttpHandler({ updates: softwareUpdates, origin: `http://127.0.0.1:${port}`, activityGate });
const staticOnlyCsp = [
  "default-src 'self' data: blob:;",
  "script-src 'self' 'unsafe-inline';",
  "style-src 'self' 'unsafe-inline';",
  "img-src 'self' https: data: blob:;",
  "font-src 'self' data:;",
  "media-src 'self' data: blob:;",
  // The UI talks to the local relay only. Allowing arbitrary HTTPS
  // connections lets archived login/analytics code race the local app and
  // leak requests to the original service.
  "connect-src 'self';",
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
    opacity: 1 !important;
    transition: none !important;
  }
  [role="dialog"] aside a.local-brand-static:hover,
  [role="dialog"] aside a.local-brand-static:focus-visible,
  [role="dialog"] aside a.local-brand-static:active {
    opacity: 1 !important;
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
    background: url("/_pixpix-assets/local-brand/workbench-logo.png?g-brand-v6-20260924") center / contain no-repeat;
    filter: none !important;
    pointer-events: none;
  }
  [role="dialog"] aside .local-brand-wrap {
    display: inline-flex !important;
    width: auto !important;
    min-width: max-content !important;
    height: 32px !important;
    min-height: 32px !important;
    margin-left: 24px !important;
    align-items: center !important;
    gap: 10px !important;
    flex: 0 0 auto !important;
  }
  [role="dialog"] aside .local-brand-name {
    display: inline-block !important;
    color: #161719 !important;
    font-size: 16px !important;
    font-weight: 650 !important;
    line-height: 1 !important;
    letter-spacing: -.01em !important;
    white-space: nowrap !important;
    pointer-events: none !important;
    user-select: none !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] aside a[href="/"]::after,
  html[data-workbench-theme="dark"] [role="dialog"] aside a[href="/zh-CN/workbench"]::after,
  html[data-workbench-theme="dark"] [role="dialog"] aside a.local-brand-static::after {
    filter: invert(1) brightness(1.3) !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] aside .local-brand-name {
    color: #f4f4f5 !important;
  }
</style>`;

const localDocumentTitleScript = `<script id="local-document-title">
  (() => {
    const title = "AI生图工作台";
    const applyTitle = () => {
      if (document.title !== title) document.title = title;
    };
    applyTitle();
    new MutationObserver(applyTitle).observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    window.addEventListener("load", applyTitle, { passive: true });
  })();
</script>`;

const localRootNavigationScript = `<script id="local-root-navigation">
  (() => {
    let proxySetupOpen = false;
    let uploadHintDismissed = false;
    const isExcelUploaded = () => {
      const picker = document.querySelector('[role="dialog"] button[aria-label="选择已上传的 Excel 文件"]');
      return Boolean(picker && picker.textContent && !/暂无已上传 Excel|暂无已上传Excel/i.test(picker.textContent));
    };

    const syncEmptyWorkspaceChrome = () => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      const hasExcel = isExcelUploaded();
      const picker = dialog.querySelector('[role="dialog"] button[aria-label="选择已上传的 Excel 文件"]');
      const toggle = dialog.querySelector('.local-settings-toggle');
      if (toggle) toggle.hidden = !hasExcel;
      for (const button of document.querySelectorAll('button')) {
        if (button.textContent?.trim() === '数据') button.hidden = true;
      }
      let hint = dialog.querySelector('.local-upload-step-hint');
      if (!hasExcel && !proxySetupOpen && !uploadHintDismissed) {
        if (!hint) {
          hint = document.createElement('div');
          hint.className = 'local-upload-step-hint';
          hint.setAttribute('role', 'status');
          hint.textContent = '第一步：先上传你的 Excel 文件';
          dialog.append(hint);
        }
        hint.hidden = false;
        if (picker && picker.dataset.uploadHintBound !== 'true') {
          picker.dataset.uploadHintBound = 'true';
          picker.addEventListener('click', () => {
            uploadHintDismissed = true;
            hint.hidden = true;
          });
        }
        const positionHint = () => {
          if (!picker || !hint || hint.hidden) return;
          const rect = picker.getBoundingClientRect();
          hint.style.top = String(Math.round(rect.bottom + 54)) + 'px';
          hint.style.left = String(Math.round(Math.max(12, Math.min(window.innerWidth - hint.offsetWidth - 12, rect.left + rect.width / 2 - hint.offsetWidth / 2)))) + 'px';
          hint.style.right = 'auto';
        };
        positionHint();
        if (!dialog.dataset.uploadHintResizeBound) {
          dialog.dataset.uploadHintResizeBound = 'true';
          window.addEventListener('resize', positionHint, { passive: true });
        }
      } else if (hint) {
        hint.hidden = true;
      }
      return true;
    };

    const normalizeBrandLink = () => {
      for (const link of document.querySelectorAll('[role="dialog"] aside a')) {
        link.classList.add("local-brand-static");
        const brandWrap = link.parentElement;
        if (brandWrap) {
          brandWrap.classList.add("local-brand-wrap");
          if (!brandWrap.querySelector(".local-brand-name")) {
            const name = document.createElement("span");
            name.className = "local-brand-name";
            name.textContent = "AI生图工作台";
            brandWrap.append(name);
          }
          const dialog = link.closest('[role="dialog"]');
          if (dialog) {
            const updateSelectorOffset = () => {
              const rect = brandWrap.getBoundingClientRect();
              dialog.style.setProperty("--local-brand-selector-left", String(Math.ceil(rect.right + 24)) + "px");
            };
            updateSelectorOffset();
            if (!dialog.dataset.localBrandResizeBound) {
              window.addEventListener("resize", updateSelectorOffset, { passive: true });
              dialog.dataset.localBrandResizeBound = "true";
            }
          }
        }
        // The archived logo uses hover:opacity-80, which makes the brand
        // mark visibly change when the pointer passes over it. This local
        // single-page build keeps the logo visually stable.
        link.classList.remove("transition-opacity", "hover:opacity-80");
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

    new MutationObserver(syncEmptyWorkspaceChrome).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    document.addEventListener("DOMContentLoaded", syncEmptyWorkspaceChrome, { once: true });
    window.addEventListener('guan-proxy-setup-opened', () => {
      proxySetupOpen = true;
      document.querySelector('.local-upload-step-hint')?.setAttribute('hidden', '');
    });
    window.addEventListener('guan-proxy-setup-closed', () => {
      proxySetupOpen = false;
      syncEmptyWorkspaceChrome();
    });

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

const canvasSettingsEntryBridgeScript = `<script id="canvas-settings-entry-bridge">
(() => {
  let settingsPending = false;
  let lastSettingsFrame = null;
  let activeSettingsCanvas = null;
  const visibleCanvas = () => Array.from(document.querySelectorAll('iframe.guan-native-canvas-frame')).find(frame => frame.getClientRects().length && getComputedStyle(frame).visibility !== 'hidden');
  const requestSettings = () => {
    if (!settingsPending) return;
    const frame = visibleCanvas();
    if (!frame || lastSettingsFrame === frame) return;
    lastSettingsFrame = frame;
    frame?.contentWindow?.postMessage({ type: 'guan-global-settings-open' }, location.origin);
  };
  const syncActiveCanvas = () => {
    const frame = visibleCanvas();
    if (!frame) return;
    if (activeSettingsCanvas && activeSettingsCanvas !== frame) {
      settingsPending = false;
      activeSettingsCanvas.contentWindow?.postMessage({ type: 'guan-global-settings-close' }, location.origin);
      lastSettingsFrame = null;
    }
    activeSettingsCanvas = frame;
    requestSettings();
  };
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== visibleCanvas()?.contentWindow) return;
    if (event.data?.type === 'guan-global-settings-ready') { lastSettingsFrame = null; syncActiveCanvas(); }
    if (event.data?.type === 'guan-global-settings-opened') settingsPending = false;
  });
  document.addEventListener('load', event => {
    if (event.target instanceof HTMLIFrameElement) { lastSettingsFrame = null; syncActiveCanvas(); }
  }, true);
  new MutationObserver(syncActiveCanvas).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  const setup = () => {
    const dialog = document.querySelector('[role="dialog"]');
    const header = dialog?.querySelector(':scope > .flex.size-full > aside');
    if (!header || header.querySelector('.local-workbench-settings-button')) return Boolean(header);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'local-workbench-settings-button';
    button.setAttribute('aria-label', '画布设置');
    button.title = '画布设置';
    button.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>';
    button.addEventListener('click', () => {
      settingsPending = true;
      lastSettingsFrame = null;
      requestSettings();
    });
    const themeButton = header.querySelector('.local-workbench-theme-button');
    header.insertBefore(button, themeButton || null);
    return true;
  };
  const observer = new MutationObserver(() => { if (setup()) observer.disconnect(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setup();
})();
</script>`;

const localCanvasSettingsEntryBootstrapScript = `<script id="local-canvas-settings-entry-bootstrap">
(() => {
  if (!new URLSearchParams(location.search).has('openCanvasSettings')) return;
  const openSettings = () => {
    const button = Array.from(document.querySelectorAll('button')).find((candidate) => {
      const label = (candidate.getAttribute('aria-label') || candidate.textContent || '').trim();
      return /^(配置|设置|Settings|Configuration)$/.test(label) || /^(配置|设置)$/.test(candidate.title || '');
    });
    if (!button) return false;
    history.replaceState(history.state, '', location.pathname + location.hash);
    window.setTimeout(() => button.click(), 0);
    return true;
  };
  if (openSettings()) return;
  const observer = new MutationObserver(() => { if (openSettings()) observer.disconnect(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 10000);
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
    // Keep the embedded infinite canvas on the same theme as the global
    // workbench control. The canvas owns its own persisted theme store, so
    // sync both the store and any already-mounted canvas iframe.
    try {
      const key = "infinite-canvas:theme_store";
      const current = JSON.parse(localStorage.getItem(key) || "{}");
      const next = JSON.stringify({ ...current, state: { ...(current.state || {}), theme } });
      localStorage.setItem(key, next);
      document.querySelectorAll("iframe").forEach((frame) => {
        try {
          // Commit same-origin React canvases before the whole-window snapshot.
          if (typeof frame.contentWindow?.CustomEvent === "function") {
            frame.contentWindow.dispatchEvent(new frame.contentWindow.CustomEvent("guan-theme-apply", { detail: { theme } }));
          }
          frame.contentWindow?.postMessage({ type: "guan-theme-sync", theme }, location.origin);
          frame.addEventListener("load", () => {
            try { frame.contentWindow?.postMessage({ type: "guan-theme-sync", theme }, location.origin); } catch {}
          }, { once: true });
        } catch {}
      });
    } catch {}
  };
  const animateTheme = (theme, sourceButton) => {
    if (theme === getTheme()) return;
    const apply = () => applyTheme(theme);
    if (typeof document.startViewTransition !== "function") {
      apply();
      return;
    }
    const rect = sourceButton?.getBoundingClientRect?.();
    const x = (rect?.left || 0) + (rect?.width || 0) / 2;
    const y = (rect?.top || 0) + (rect?.height || 0) / 2;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const radius = Math.hypot(Math.max(x, width - x), Math.max(y, height - y));
    const style = document.createElement("style");
    style.textContent = "::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal}";
    document.head.append(style);
    const transition = document.startViewTransition(apply);
    const cleanup = () => style.remove();
    transition.finished?.then?.(cleanup, cleanup);
    transition.ready?.then?.(() => {
      document.documentElement.animate(
        { clipPath: ["circle(0px at " + x + "px " + y + "px)", "circle(" + radius + "px at " + x + "px " + y + "px)"] },
        { duration: 400, easing: "ease-in-out", fill: "forwards", pseudoElement: "::view-transition-new(root)" },
      );
    }, cleanup);
  };
  // Same-origin embedded controls delegate to the shell: never run two
  // independent view transitions for one visible workbench.
  window.__guanAnimateTheme = animateTheme;
  applyTheme(getTheme());

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "guan-theme-change") return;
    const theme = event.data.theme;
    if (theme !== "light" && theme !== "dark") return;
    const fromCanvas = Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === event.source);
    if (!fromCanvas || theme === getTheme()) return;
    applyTheme(theme);
  });

  const setup = () => {
    const dialog = document.querySelector('[role="dialog"]');
    const header = dialog?.querySelector(':scope > .flex.size-full > aside');
    if (!header) return false;
    let button = header.querySelector(".local-workbench-theme-button");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "local-workbench-theme-button";
      button.addEventListener("click", () => animateTheme(getTheme() === "dark" ? "light" : "dark", button));
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
  [role="dialog"] [role="radiogroup"][aria-label="工具类型"] [role="radio"][data-state="on"] > svg {
    display: none !important;
  }
  [role="dialog"] [role="radiogroup"][aria-label="工具类型"] [role="radio"][data-state="on"]::before {
    content: "" !important;
    display: inline-block !important;
    width: 16px !important;
    height: 16px !important;
    flex: 0 0 16px !important;
    border-radius: 4px !important;
    background: url("/_pixpix-assets/local-brand/workbench-logo.png?g-brand-v7-20260924") center / contain no-repeat !important;
    filter: none !important;
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
    background: #0d0d0e !important;
    color: #fff !important;
    opacity: .5 !important;
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
  [role="dialog"] button[type="submit"][data-local-generation-ready="true"] {
    cursor: pointer !important;
    opacity: 1 !important;
    pointer-events: auto !important;
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
    position: static !important;
    z-index: 40 !important;
    margin-left: auto !important;
    margin-right: 0 !important;
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
  .local-upload-step-hint {
    position: fixed !important;
    top: 104px;
    left: auto;
    z-index: 35 !important;
    padding: 10px 16px !important;
    border: 1px solid #e6e6e8 !important;
    border-radius: 12px !important;
    background: rgba(255,255,255,.94) !important;
    color: #5b5c65 !important;
    font-size: 14px !important;
    line-height: 20px !important;
    box-shadow: 0 8px 24px rgba(20,20,30,.08) !important;
    pointer-events: none !important;
  }
  .local-upload-step-hint::before {
    content: "" !important;
    position: absolute !important;
    top: -36px !important;
    left: calc(50% - 5px) !important;
    width: 10px !important;
    height: 10px !important;
    border-left: 2px solid #a7abb4 !important;
    border-top: 2px solid #a7abb4 !important;
    transform: rotate(45deg) !important;
  }
  .local-upload-step-hint::after {
    content: "" !important;
    position: absolute !important;
    top: -35px !important;
    left: 50% !important;
    width: 2px !important;
    height: 27px !important;
    background: #a7abb4 !important;
  }
  .local-upload-step-hint[hidden],
  .local-settings-toggle[hidden] {
    display: none !important;
  }
  /* The canvas view no longer uses the right-side generation settings panel. */
  #local-settings-panel,
  .local-settings-toggle {
    display: none !important;
  }
  /*
   * The settings app is mounted inside the archived dialog. Keep its
   * top-level overlay above the Excel controls and make the modal backdrop
   * visibly blur the workbench behind it.
   */
  .guan-dc-header-upload {
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
    font-size: 0 !important;
    line-height: 0 !important;
    transform: none !important;
  }
  .guan-dc-header-upload svg {
    width: 22px !important;
    height: 22px !important;
    fill: none !important;
    stroke: currentColor !important;
    stroke-linecap: round !important;
    stroke-linejoin: round !important;
    stroke-width: 1.9 !important;
    pointer-events: none !important;
  }
  .guan-dc-header-upload:hover {
    background: var(--muted) !important;
  }
  html[data-workbench-theme="dark"] .guan-dc-header-upload {
    color: #e6e7eb !important;
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
  html[data-workbench-theme="dark"] [role="dialog"] [role="radiogroup"][aria-label="工具类型"] [role="radio"][data-state="on"]::before {
    filter: invert(1) brightness(1.3) !important;
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
    background: #f4f4f5 !important;
    color: #161719 !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] button[type="submit"]:not([disabled]) {
    border-color: #f4f4f5 !important;
    background: #f4f4f5 !important;
    color: #161719 !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] button[type="submit"][data-local-generation-ready="true"] {
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
  /* The root A+ page must stay preview-only.  Its native form is rendered as
     a second aside (it does not carry our legacy #local-settings-panel id),
     so the older id-based hide rule could not prevent it from reappearing.
     Hide that form by its stable textarea marker and let the preview occupy
     the full workspace. */
  [role="dialog"] aside:has(textarea),
  [role="dialog"] .local-settings-toggle {
    display: none !important;
  }
  [role="dialog"] > .flex.size-full > div:not([hidden]) > div > section {
    flex: 1 1 100% !important;
    width: 100% !important;
    max-width: none !important;
  }
</style>`;

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
    const uploadState = {
      files: [],
      urls: [],
      parent: null,
      preview: null,
      input: null,
      removeBackground: new Set(),
      backgroundBusy: new Set(),
      backgroundErrors: new Map(),
      replacements: new Map(),
      publishedSignature: null,
    };

    const fileKey = (file) => [file.name, file.size, file.lastModified].join(":");

    const fileToDataUrl = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(file);
    });

    const dataUrlToFile = (dataUrl, name) => {
      const comma = dataUrl.indexOf(",");
      if (comma < 0) throw new Error("接口返回的图片格式无效");
      const meta = dataUrl.slice(0, comma);
      const payload = dataUrl.slice(comma + 1);
      const mime = (meta.match(/^data:([^;]+)/i)?.[1] || "image/png").toLowerCase();
      const binary = /;base64/i.test(meta)
        ? atob(payload.replace(/\\s/g, ""))
        : decodeURIComponent(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new File([bytes], name, { type: mime, lastModified: Date.now() });
    };

    const replacementName = (file) => {
      const base = file.name.replace(/\\.[^.]+$/, "") || "image";
      return base + "-no-background.png";
    };

    const showBackgroundRemovalNotice = (message, type = "error") => {
      const notice = document.createElement("div");
      notice.className = "local-offline-upload-notice";
      notice.dataset.type = type;
      notice.textContent = message;
      document.body.append(notice);
      window.setTimeout(() => notice.remove(), 3600);
    };

    const publishImageState = () => {
      window.__localWorkbenchImageFiles = uploadState.files.slice();
      uploadState.publishedSignature = uploadState.files.map(fileKey).join("|");
      window.dispatchEvent(new CustomEvent("local-workbench-images-change", {
        detail: { count: uploadState.files.length },
      }));
    };

    const syncInputFiles = () => {
      if (!uploadState.input || typeof DataTransfer === "undefined") return;
      try {
        const transfer = new DataTransfer();
        uploadState.files.forEach((file) => transfer.items.add(file));
        uploadState.input.files = transfer.files;
      } catch {
        // The preview state remains authoritative if a browser disallows
        // assigning a FileList back to the input element.
      }
    };

    const updateUploadHint = (dialog) => {
      const hint = Array.from(dialog?.querySelectorAll("span") || [])
        .find((node) => node.textContent?.trim() === "支持 1-3 张图片");
      if (hint) hint.textContent = "支持多张图片";
    };

    const closeRemoveBackgroundDialog = () => {
      const dialog = document.querySelector(".local-remove-bg-confirm");
      if (!dialog) return;
      dialog.dataset.state = "closing";
      window.setTimeout(() => {
        if (dialog.dataset.state === "closing") dialog.remove();
      }, 170);
    };

    const openRemoveBackgroundDialog = ({ file, index, button, item }) => {
      closeRemoveBackgroundDialog();
      const dialog = document.createElement("div");
      dialog.className = "local-remove-bg-confirm";
      dialog.dataset.state = "opening";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", "确认移除背景");

      const backdrop = document.createElement("div");
      backdrop.className = "local-remove-bg-confirm-backdrop";
      const card = document.createElement("section");
      card.className = "local-remove-bg-confirm-card";
      const preview = document.createElement("div");
      preview.className = "local-remove-bg-confirm-preview";
      preview.setAttribute("aria-label", "待移除背景的图片预览");
      const previewImage = document.createElement("img");
      previewImage.src = uploadState.urls[index] || "";
      previewImage.alt = file.name;
      previewImage.addEventListener("error", () => {
        preview.dataset.error = "true";
        previewImage.removeAttribute("src");
        previewImage.alt = "";
        preview.textContent = "";
      }, { once: true });
      preview.append(previewImage);
      const copy = document.createElement("div");
      copy.className = "local-remove-bg-confirm-copy";
      const title = document.createElement("h2");
      title.textContent = "移除背景？";
      const message = document.createElement("p");
      message.textContent = "确认要为图片“" + file.name + "”移除背景吗？";
      copy.append(title, message);
      const actions = document.createElement("div");
      actions.className = "local-remove-bg-confirm-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "primary";
      confirm.textContent = "确认移除";
      actions.append(cancel, confirm);
      card.append(preview, copy, actions);
      dialog.append(backdrop, card);
      document.body.append(dialog);

      const cancelDialog = () => closeRemoveBackgroundDialog();
      const confirmRemoval = () => {
        closeRemoveBackgroundDialog();
        void startBackgroundRemoval({ file, index });
      };

      backdrop.addEventListener("click", cancelDialog);
      cancel.addEventListener("click", cancelDialog);
      confirm.addEventListener("click", confirmRemoval);
      dialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelDialog();
        }
      });
      window.setTimeout(() => {
        if (dialog.dataset.state === "opening") dialog.dataset.state = "open";
        cancel.focus();
      }, 20);
    };

    const undoReplacement = (index, file) => {
      const replacementKey = fileKey(file);
      const replacement = uploadState.replacements.get(replacementKey);
      if (!replacement || uploadState.files[index] !== file) return;
      const currentUrl = uploadState.urls[index];
      if (currentUrl && currentUrl !== replacement.originalUrl) URL.revokeObjectURL(currentUrl);
      uploadState.files[index] = replacement.originalFile;
      uploadState.urls[index] = replacement.originalUrl;
      uploadState.replacements.delete(replacementKey);
      uploadState.backgroundErrors.delete(fileKey(replacement.originalFile));
      syncInputFiles();
      renderLocalPreviews(uploadState.parent);
      publishImageState();
      showBackgroundRemovalNotice("已撤销移除背景，已恢复原图", "success");
    };

    const startBackgroundRemoval = async ({ file, index }) => {
      const originalKey = fileKey(file);
      if (uploadState.files[index] !== file || uploadState.backgroundBusy.has(originalKey)) return;
      uploadState.backgroundBusy.add(originalKey);
      uploadState.backgroundErrors.delete(originalKey);
      renderLocalPreviews(uploadState.parent);

      try {
        const bridge = window.__localWorkbenchGeneration;
        if (typeof bridge?.generateBackgroundRemoval !== "function") {
          throw new Error("生图配置尚未加载，请稍后重试");
        }
        const inputDataUrl = await fileToDataUrl(file);
        const result = await bridge.generateBackgroundRemoval(inputDataUrl);
        if (!result?.dataUrl?.startsWith("data:")) throw new Error("接口未返回有效图片");
        if (uploadState.files[index] !== file) return;

        const replacementFile = dataUrlToFile(result.dataUrl, replacementName(file));
        const replacementUrl = URL.createObjectURL(replacementFile);
        uploadState.replacements.set(fileKey(replacementFile), {
          originalFile: file,
          originalUrl: uploadState.urls[index],
        });
        uploadState.files[index] = replacementFile;
        uploadState.urls[index] = replacementUrl;
        uploadState.removeBackground.delete(originalKey);
        uploadState.backgroundErrors.delete(originalKey);
        syncInputFiles();
        renderLocalPreviews(uploadState.parent);
        publishImageState();
        showBackgroundRemovalNotice(
          "移除背景成功" + (result.profileName ? "（" + result.profileName + "）" : "") + "，已替换原图",
          "success",
        );
      } catch (error) {
        if (uploadState.files[index] === file) {
          uploadState.backgroundErrors.set(originalKey, error instanceof Error ? error.message : String(error));
          renderLocalPreviews(uploadState.parent);
        }
        showBackgroundRemovalNotice(
          "移除背景失败，已保留原图：" + (error instanceof Error ? error.message : String(error)),
          "error",
        );
      } finally {
        uploadState.backgroundBusy.delete(originalKey);
        renderLocalPreviews(uploadState.parent);
      }
    };

    const removeImage = (index) => {
      const removedFile = uploadState.files[index];
      const removedUrl = uploadState.urls[index];
      const replacement = removedFile ? uploadState.replacements.get(fileKey(removedFile)) : null;
      if (removedUrl) URL.revokeObjectURL(removedUrl);
      if (replacement?.originalUrl) URL.revokeObjectURL(replacement.originalUrl);
      if (removedFile) uploadState.removeBackground.delete(fileKey(removedFile));
      if (removedFile) {
        uploadState.backgroundBusy.delete(fileKey(removedFile));
        uploadState.backgroundErrors.delete(fileKey(removedFile));
        uploadState.replacements.delete(fileKey(removedFile));
      }
      uploadState.files.splice(index, 1);
      uploadState.urls.splice(index, 1);
      syncInputFiles();
      renderLocalPreviews(uploadState.parent);
      publishImageState();
    };

    const renderLocalPreviews = (parent) => {
      if (!parent) return;
      if (!uploadState.files.length) {
        uploadState.preview?.remove();
        uploadState.preview = null;
        return;
      }
      const renderKey = uploadState.files
        .map((file) => {
          const key = fileKey(file);
          return [
            key,
            uploadState.backgroundBusy.has(key) ? "busy" : "idle",
            uploadState.backgroundErrors.has(key) ? "error" : "ok",
            uploadState.replacements.has(key) ? "replacement" : "original",
          ].join(":");
        })
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
        const currentKey = fileKey(file);
        const busy = uploadState.backgroundBusy.has(currentKey);
        const error = uploadState.backgroundErrors.get(currentKey);
        const replacement = uploadState.replacements.has(currentKey);
        const removeBackgroundButton = document.createElement("button");
        removeBackgroundButton.type = "button";
        removeBackgroundButton.className = "local-offline-upload-remove-background";
        removeBackgroundButton.setAttribute("aria-label", replacement ? "撤销替换 " + file.name : "移除背景 " + file.name);
        removeBackgroundButton.setAttribute("aria-pressed", String(replacement));
        removeBackgroundButton.setAttribute("aria-busy", String(busy));
        removeBackgroundButton.title = replacement ? "撤销替换，恢复原图" : error || "移除背景";
        removeBackgroundButton.textContent = busy
          ? "移除背景中…"
          : replacement
            ? "撤销替换"
            : error
              ? "重试移除背景"
              : "移除背景";
        removeBackgroundButton.disabled = busy;
        removeBackgroundButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (busy) return;
          if (replacement) {
            undoReplacement(index, file);
            return;
          }
          openRemoveBackgroundDialog({ file, index, button: removeBackgroundButton, item });
        });
        item.dataset.removeBackground = String(!replacement);
        item.dataset.backgroundBusy = String(busy);
        item.dataset.backgroundReplaced = String(replacement);
        if (error) item.dataset.backgroundError = error;
        const status = document.createElement("span");
        status.className = "local-offline-upload-status";
        status.textContent = busy ? "正在使用生图配置处理…" : error ? "失败，原图已保留" : replacement ? "已替换 · 可撤销" : "";
        status.hidden = !status.textContent;
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "local-offline-upload-delete";
        removeButton.setAttribute("aria-label", "删除图片 " + file.name);
        removeButton.title = "删除图片";
        removeButton.textContent = "×";
        removeButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          removeImage(index);
        });
        item.append(image, status, removeBackgroundButton, removeButton);
        return item;
      }));
    };

    const setupUploader = () => {
      const dialog = document.querySelector('[role="dialog"]');
      const input = dialog?.querySelector('input[type="file"][aria-label="上传图片"]');
      const button = input?.parentElement?.querySelector('button[aria-label="上传图片"]');
      if (!input || !button) return false;
      const parent = input.parentElement;
      parent.classList.add("local-offline-upload-input-row");
      uploadState.parent = parent;
      uploadState.input = input;
      updateUploadHint(dialog);

      if (input.dataset.localOfflineReady !== "true") {
        input.dataset.localOfflineReady = "true";
        input.addEventListener("change", (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          const existing = new Set(uploadState.files.map(fileKey));
          const incoming = Array.from(input.files || [])
            .filter((file) => !existing.has(fileKey(file)));
          uploadState.files.push(...incoming);
          uploadState.urls.push(...incoming.map((file) => URL.createObjectURL(file)));
          syncInputFiles();
          renderLocalPreviews(parent);
          publishImageState();
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
      const signature = uploadState.files.map(fileKey).join("|");
      if (uploadState.publishedSignature !== signature) publishImageState();
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

const localGenerationButtonScript = `<script id="local-generation-button-script">
  (() => {
    const state = { button: null, input: null, queued: false };

    const findButton = () => {
      const dialog = document.querySelector('[role="dialog"]');
      return Array.from(dialog?.querySelectorAll('button[type="submit"]') || [])
        .find((button) => /生成详情页/.test(button.textContent || ""));
    };

    const findImageInput = () => document.querySelector(
      '[role="dialog"] input[type="file"][aria-label="上传图片"]'
    );

    const buttonLabel = (count) => count > 0
      ? "生成详情页（" + count + " 张图片）"
      : "生成详情页（ - 张图片）";

    const sync = () => {
      state.queued = false;
      const button = findButton();
      if (!button) return false;
      const input = findImageInput();
      const localFiles = Array.isArray(window.__localWorkbenchImageFiles)
        ? window.__localWorkbenchImageFiles
        : null;
      const count = localFiles ? localFiles.length : (input?.files?.length || 0);
      const label = buttonLabel(count);
      const labelNode = button.querySelector("span") || button;

      // The archived React form disables this action while it waits for the
      // hosted account/credit state. This local build has no such gate.
      button.disabled = false;
      button.removeAttribute("disabled");
      button.removeAttribute("aria-disabled");
      button.dataset.localGenerationReady = "true";
      if (labelNode.textContent !== label) labelNode.textContent = label;

      if (state.input !== input) {
        state.input?.removeEventListener("change", schedule);
        state.input = input;
        input?.addEventListener("change", schedule, true);
      }
      state.button = button;
      return true;
    };

    const schedule = () => {
      if (state.queued) return;
      state.queued = true;
      queueMicrotask(sync);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "class"],
    });
    document.addEventListener("DOMContentLoaded", sync, { once: true });
    window.addEventListener("local-workbench-images-change", schedule);
    sync();
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
    /* Let preview tiles and the upload trigger share the same flex row. If
       the last row has room, the trigger therefore stays on its right. */
    display: contents !important;
  }
  .local-offline-upload-item {
    position: relative !important;
    width: 128px !important;
    height: 128px !important;
    overflow: visible !important;
    border: 1px solid var(--border) !important;
    border-radius: 12px !important;
    background: var(--card) !important;
  }
  .local-offline-upload-input-row {
    overflow: visible !important;
  }
  .local-offline-upload-delete {
    position: absolute !important;
    top: -10px !important;
    right: -10px !important;
    z-index: 2 !important;
    display: inline-flex !important;
    width: 24px !important;
    height: 24px !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 9999px !important;
    background: rgba(255, 255, 255, .94) !important;
    color: #25262a !important;
    font-size: 18px !important;
    font-weight: 600 !important;
    line-height: 1 !important;
    opacity: 0 !important;
    pointer-events: none !important;
    transform: scale(.9) !important;
    cursor: pointer !important;
    box-shadow: 0 2px 8px rgb(0 0 0 / 18%) !important;
    transition: opacity .16s ease, transform .16s ease, background-color .16s ease !important;
  }
  .local-offline-upload-item:hover .local-offline-upload-delete,
  .local-offline-upload-item:focus-within .local-offline-upload-delete {
    opacity: 1 !important;
    pointer-events: auto !important;
    transform: scale(1) !important;
  }
  .local-offline-upload-delete:hover {
    background: #f0f0f1 !important;
  }
  html[data-workbench-theme="dark"] .local-offline-upload-delete {
    background: #f4f4f5 !important;
    color: #161719 !important;
  }
  html[data-workbench-theme="dark"] .local-offline-upload-delete:hover {
    background: #fff !important;
  }
  .local-offline-upload-remove-background {
    position: absolute !important;
    left: 6px !important;
    right: 6px !important;
    bottom: 6px !important;
    z-index: 2 !important;
    display: inline-flex !important;
    min-height: 26px !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 4px 8px !important;
    overflow: hidden !important;
    border: 0 !important;
    border-radius: 7px !important;
    background: rgb(20 20 22 / 78%) !important;
    color: #fff !important;
    font-size: 11px !important;
    font-weight: 600 !important;
    line-height: 16px !important;
    white-space: nowrap !important;
    text-overflow: ellipsis !important;
    cursor: pointer !important;
    box-shadow: 0 2px 8px rgb(0 0 0 / 16%) !important;
    -webkit-backdrop-filter: blur(5px) !important;
    backdrop-filter: blur(5px) !important;
    transition: background-color .16s ease, transform .16s ease !important;
    opacity: 0 !important;
    pointer-events: none !important;
    transform: translateY(4px) !important;
  }
  .local-offline-upload-item:hover .local-offline-upload-remove-background,
  .local-offline-upload-item:focus-within .local-offline-upload-remove-background {
    opacity: .94 !important;
    pointer-events: auto !important;
    transform: translateY(0) !important;
  }
  .local-offline-upload-remove-background:hover {
    background: rgb(8 8 9 / 90%) !important;
  }
  .local-offline-upload-remove-background[aria-pressed="true"] {
    background: #fff !important;
    color: #17181b !important;
  }
  .local-offline-upload-remove-background:disabled {
    opacity: .96 !important;
    cursor: progress !important;
  }
  .local-offline-upload-remove-background:active {
    transform: scale(.97) !important;
  }
  .local-offline-upload-status {
    position: absolute !important;
    top: 6px !important;
    left: 6px !important;
    right: 6px !important;
    z-index: 2 !important;
    display: inline-flex !important;
    min-height: 22px !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 3px 7px !important;
    overflow: hidden !important;
    border-radius: 7px !important;
    background: rgb(20 20 22 / 72%) !important;
    color: #fff !important;
    font-size: 10px !important;
    font-weight: 600 !important;
    line-height: 15px !important;
    white-space: nowrap !important;
    text-overflow: ellipsis !important;
    pointer-events: none !important;
    -webkit-backdrop-filter: blur(5px) !important;
    backdrop-filter: blur(5px) !important;
  }
  .local-offline-upload-item[data-background-error] .local-offline-upload-status {
    background: rgb(185 28 28 / 78%) !important;
  }
  .local-offline-upload-notice {
    position: fixed !important;
    left: 50% !important;
    bottom: 28px !important;
    z-index: 1300 !important;
    max-width: min(560px, calc(100vw - 40px)) !important;
    padding: 10px 14px !important;
    border: 1px solid rgb(255 255 255 / 18%) !important;
    border-radius: 12px !important;
    background: rgb(22 23 26 / 92%) !important;
    color: #fff !important;
    font: 13px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    text-align: center !important;
    box-shadow: 0 12px 36px rgb(0 0 0 / 22%) !important;
    transform: translateX(-50%) !important;
    animation: local-offline-upload-notice-in .2s cubic-bezier(.16, 1, .3, 1) both !important;
    pointer-events: none !important;
  }
  .local-offline-upload-notice[data-type="success"] {
    background: rgb(21 128 61 / 94%) !important;
  }
  @keyframes local-offline-upload-notice-in {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
  .local-offline-upload-item img {
    display: block !important;
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
    border-radius: 11px !important;
  }
  .local-remove-bg-confirm {
    --local-remove-bg-card: #fff;
    --local-remove-bg-text: #17181a;
    --local-remove-bg-muted: #72757a;
    --local-remove-bg-border: rgba(20, 24, 32, .12);
    position: fixed !important;
    inset: 0 !important;
    z-index: 1100 !important;
    display: grid !important;
    place-items: center !important;
    padding: 20px !important;
    pointer-events: auto !important;
    color: var(--local-remove-bg-text) !important;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
  }
  .local-remove-bg-confirm-backdrop {
    position: absolute !important;
    inset: 0 !important;
    pointer-events: auto !important;
    background: rgba(9, 10, 12, .34) !important;
    -webkit-backdrop-filter: blur(8px) !important;
    backdrop-filter: blur(8px) !important;
  }
  .local-remove-bg-confirm-card {
    position: relative !important;
    z-index: 1 !important;
    display: grid !important;
    grid-template-columns: auto minmax(0, 1fr) !important;
    gap: 14px !important;
    width: min(440px, calc(100vw - 40px)) !important;
    box-sizing: border-box !important;
    padding: 22px !important;
    border: 1px solid var(--local-remove-bg-border) !important;
    border-radius: 20px !important;
    background: var(--local-remove-bg-card) !important;
    box-shadow: 0 28px 80px rgb(0 0 0 / 28%) !important;
    animation: local-remove-bg-confirm-in .18s cubic-bezier(.16, 1, .3, 1) both !important;
    pointer-events: auto !important;
  }
  .local-remove-bg-confirm[data-state="closing"] .local-remove-bg-confirm-card {
    animation: local-remove-bg-confirm-out .15s cubic-bezier(.4, 0, .2, 1) both !important;
  }
  .local-remove-bg-confirm-preview {
    position: relative !important;
    display: grid !important;
    width: 76px !important;
    height: 76px !important;
    place-items: center !important;
    overflow: hidden !important;
    border: 1px solid var(--local-remove-bg-border) !important;
    border-radius: 16px !important;
    background: #f4f5f7 !important;
    color: var(--local-remove-bg-muted) !important;
    font-size: 12px !important;
    font-weight: 600 !important;
  }
  .local-remove-bg-confirm-preview img {
    display: block !important;
    width: 100% !important;
    height: 100% !important;
    object-fit: contain !important;
    background: #f4f5f7 !important;
  }
  .local-remove-bg-confirm-preview[data-error]::before {
    content: "图片预览不可用";
    padding: 8px !important;
    text-align: center !important;
  }
  .local-remove-bg-confirm-copy h2 {
    margin: 1px 0 6px !important;
    color: var(--local-remove-bg-text) !important;
    font-size: 17px !important;
    line-height: 1.25 !important;
  }
  .local-remove-bg-confirm-copy p {
    margin: 0 !important;
    color: var(--local-remove-bg-muted) !important;
    font-size: 13px !important;
    line-height: 1.55 !important;
    overflow-wrap: anywhere !important;
  }
  .local-remove-bg-confirm-actions {
    grid-column: 2 !important;
    display: flex !important;
    justify-content: flex-end !important;
    gap: 8px !important;
    margin-top: 4px !important;
  }
  .local-remove-bg-confirm-actions button {
    min-width: 72px !important;
    padding: 9px 14px !important;
    border: 1px solid var(--local-remove-bg-border) !important;
    border-radius: 10px !important;
    background: var(--local-remove-bg-card) !important;
    color: var(--local-remove-bg-text) !important;
    cursor: pointer !important;
    font: 13px/1.2 inherit !important;
    transition: background .14s ease, border-color .14s ease, transform .14s ease !important;
  }
  .local-remove-bg-confirm-actions button:hover {
    background: var(--muted) !important;
  }
  .local-remove-bg-confirm-actions button:active {
    transform: translateY(1px) !important;
  }
  .local-remove-bg-confirm-actions button.primary {
    border-color: #2563eb !important;
    background: #2563eb !important;
    color: #fff !important;
  }
  .local-remove-bg-confirm-actions button.primary:hover {
    border-color: #1d4ed8 !important;
    background: #1d4ed8 !important;
  }
  html[data-workbench-theme="dark"] .local-remove-bg-confirm {
    --local-remove-bg-card: #1d1e20;
    --local-remove-bg-text: #f4f4f5;
    --local-remove-bg-muted: #a1a1aa;
    --local-remove-bg-border: rgba(255, 255, 255, .14);
  }
  html[data-workbench-theme="dark"] .local-remove-bg-confirm-preview,
  html[data-workbench-theme="dark"] .local-remove-bg-confirm-preview img {
    background: #2b2d31 !important;
  }
  @keyframes local-remove-bg-confirm-in {
    from { opacity: 0; transform: translateY(8px) scale(.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes local-remove-bg-confirm-out {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to { opacity: 0; transform: translateY(5px) scale(.98); }
  }
  [role="dialog"] button[data-local-offline-ready="true"]:focus,
  [role="dialog"] button[data-local-offline-ready="true"]:focus-visible {
    outline: none !important;
    box-shadow: none !important;
  }
  [role="dialog"] [role="radiogroup"][aria-label="工具类型"] {
    display: none !important;
  }
  [role="dialog"] button:disabled[class*="w-full"][class*="min-h-12"] {
    /* Match the archived GPT Image Playground button exactly.  This
       selector is intentionally more specific than the utility classes on
       the button, so the disabled state cannot fall back to the old gray
       treatment. */
    border: 1px solid transparent !important;
    background: #0d0d0e !important;
    color: #fff !important;
    opacity: .5 !important;
    box-shadow: none !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] button:disabled[class*="w-full"][class*="min-h-12"] {
    border-color: transparent !important;
    background: #f4f4f5 !important;
    color: #161719 !important;
  }
  html[data-workbench-theme="dark"] [role="dialog"] button:disabled[class*="w-full"][class*="min-h-12"] svg {
    color: #161719 !important;
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
    [role="dialog"] > .flex.size-full > div:not([hidden]) > div > #local-settings-panel {
      flex: 1 1 auto !important;
      width: auto !important;
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
      transform: translateX(0) !important;
      transition: opacity .26s ease .08s, transform .32s cubic-bezier(.4, 0, .2, 1) .04s, visibility 0s linear 0s !important;
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
  html[data-local-settings-booting="true"] [role="dialog"] aside:has(textarea) {
    visibility: hidden !important;
  }
  html[data-local-settings-booting="true"] #local-settings-panel,
  html[data-local-settings-booting="true"] #local-settings-panel > form,
  html[data-local-settings-booting="true"] #local-settings-panel > * {
    transition: none !important;
    animation: none !important;
  }
  @media (max-width: 799px) {
    .local-settings-toggle {
      display: none !important;
    }
  }
</style>`;

const localProxySetupScript = `<script id="local-proxy-setup-script">
  (() => {
    const SESSION_KEY = "guan-workbench:proxy-setup-dismissed";
    const FILE_NAME_KEY = "guan-workbench:proxy-file-name";
    const FROZEN_KEY = "guan-workbench:proxy-setup-frozen";
    let modal = null;
    let autoCloseTimer = null;
    let autoCloseCountdownTimer = null;
    let autoClosePending = false;
    // The startup wizard can open before React mounts its trapped dialog.
    // Follow that dialog when it appears so native typing remains in its scope.
    const syncStartupFocusScope = () => {
      if (!modal) return;
      const activeDialog = Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter((node) => !node.closest('.local-proxy-setup') && node.getAttribute('aria-hidden') !== 'true')
        .at(-1);
      if (activeDialog && !activeDialog.contains(modal)) {
        activeDialog.append(modal);
        modal.querySelector('[data-proxy-url]')?.focus({ preventScroll: true });
      }
    };
    new MutationObserver(syncStartupFocusScope).observe(document.documentElement, { childList: true, subtree: true });

    const addStyles = () => {
      if (document.getElementById("local-proxy-setup-style")) return;
      const style = document.createElement("style");
      style.id = "local-proxy-setup-style";
      style.textContent = [
        ".local-proxy-setup{position:fixed;inset:0;z-index:2147483000;isolation:isolate;display:grid;place-items:center;padding:20px;background:rgba(15,17,22,.32);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
        ".local-proxy-setup,.local-proxy-setup *{pointer-events:auto!important}",
        ".local-proxy-setup-card{width:min(520px,calc(100vw - 32px));border:1px solid rgba(0,0,0,.08);border-radius:24px;background:#fff;color:#17181a;box-shadow:0 30px 100px rgba(0,0,0,.24);padding:26px}",
        ".local-proxy-setup-card h2{margin:0 0 8px;font-size:22px;line-height:1.3}.local-proxy-setup-card p{margin:0;color:#686d76;font-size:13px;line-height:1.6}",
        ".local-proxy-setup-field{display:grid;gap:7px;margin-top:18px}.local-proxy-setup-field label{font-size:13px;font-weight:650}.local-proxy-setup-field input{width:100%;box-sizing:border-box;border:1px solid #d9dce2;border-radius:12px;padding:11px 12px;font:13px inherit;outline:none;background:#fff}.local-proxy-setup-field input:focus{border-color:#3478f6;box-shadow:0 0 0 3px rgba(52,120,246,.14)}",
        ".local-proxy-input-row{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;border:1px solid #d9dce2;border-radius:12px;padding:4px 5px 4px 12px;background:#fff}.local-proxy-input-row:focus-within{border-color:#3478f6;box-shadow:0 0 0 3px rgba(52,120,246,.14)}.local-proxy-input-row input[data-proxy-url]{min-width:0;flex:1;border:0!important;box-shadow:none!important;outline:none;padding:7px 0!important;background:transparent}.local-proxy-file-button{flex:0 0 auto;border:1px solid #d9dce2;border-radius:9px;padding:7px 10px;background:#f7f8fa;color:#34363b;font:12px inherit;cursor:pointer;white-space:nowrap}.local-proxy-file-button:hover{background:#eef1f5}.local-proxy-file-input{display:none!important}",
        ".local-proxy-setup-actions{display:flex;align-items:center;justify-content:flex-end;gap:9px;margin-top:22px}.local-proxy-setup-actions button{border:1px solid #d9dce2;border-radius:12px;padding:10px 15px;background:#fff;color:#24262a;font:13px inherit;cursor:pointer}.local-proxy-setup-actions button.primary{border-color:#111;background:#111;color:#fff}.local-proxy-setup-actions button:disabled{cursor:not-allowed;opacity:.55}.local-proxy-setup-status{margin-right:auto;font-size:12px;color:#22925a}.local-proxy-setup-status[data-status='pending']{color:#b7791f}.local-proxy-setup-status[data-status='inactive'],.local-proxy-setup-status[data-status='error']{color:#d92d20}.local-proxy-setup-status:empty{display:none}",
        ".local-proxy-setup-error{min-height:20px;margin-top:12px;color:#c53030;font-size:12px;line-height:1.5}.local-proxy-setup-hint{margin-top:15px!important;font-size:12px!important;color:#8a9099!important}",
        "html[data-workbench-theme='dark'] .local-proxy-setup-card{border-color:rgba(255,255,255,.1);background:#1e2024;color:#f4f4f5}html[data-workbench-theme='dark'] .local-proxy-setup-field input,html[data-workbench-theme='dark'] .local-proxy-setup-actions button,html[data-workbench-theme='dark'] .local-proxy-input-row{border-color:rgba(255,255,255,.14);background:#26292e;color:#f4f4f5}html[data-workbench-theme='dark'] .local-proxy-file-button{border-color:rgba(255,255,255,.14);background:#30343b;color:#f4f4f5}",
      ].join("");
      document.head.append(style);
    };

    const close = () => {
      if (autoCloseTimer) window.clearTimeout(autoCloseTimer);
      if (autoCloseCountdownTimer) window.clearInterval(autoCloseCountdownTimer);
      autoCloseTimer = null;
      autoCloseCountdownTimer = null;
      autoClosePending = false;
      modal?.remove();
      modal = null;
      window.dispatchEvent(new Event('guan-proxy-setup-closed'));
    };
    const open = (status) => {
      if (modal) return;
      addStyles();
      modal = document.createElement("div");
      modal.className = "local-proxy-setup";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      window.dispatchEvent(new Event('guan-proxy-setup-opened'));
      modal.innerHTML = '<section class="local-proxy-setup-card"><h2>设置网络代理</h2><p>本项目会先尝试直连。若服务商无法直连，再使用这里配置的临时代理节点。代理配置只在本次服务运行期间使用，关闭服务后自动清除。</p><div class="local-proxy-setup-field"><label>代理配置文件或远端订阅地址</label><div class="local-proxy-input-row"><input data-proxy-url type="text" inputmode="url" placeholder="https://example.com/your-subscription" autocomplete="off" spellcheck="false" /><button type="button" class="local-proxy-file-button" data-proxy-file-button>选择文件</button><input data-proxy-file class="local-proxy-file-input" type="file" accept=".yaml,.yml,.txt,text/plain,application/yaml" /></div></div><p class="local-proxy-setup-hint">支持 Mihomo / Clash 配置文件，也可以直接填写订阅地址。没有代理也可以先跳过。</p><div class="local-proxy-setup-error" role="alert"></div><div class="local-proxy-setup-actions"><span class="local-proxy-setup-status" data-proxy-status></span><button type="button" data-proxy-skip>稍后配置</button><button type="button" data-proxy-unfreeze hidden>取消冻结</button><button type="button" class="primary" data-proxy-save>保存并启动代理</button></div></section>';
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((node) => !node.closest('.local-proxy-setup'));
      const host = dialogs.filter((node) => node.getAttribute('aria-hidden') !== 'true').at(-1) || document.body;
      host.append(modal);
      const error = modal.querySelector('.local-proxy-setup-error');
      const fileInput = modal.querySelector('[data-proxy-file]');
      const urlInput = modal.querySelector('[data-proxy-url]');
      const fileButton = modal.querySelector('[data-proxy-file-button]');
      const save = modal.querySelector('[data-proxy-save]');
      const statusNode = modal.querySelector('[data-proxy-status]');
      const unfreeze = modal.querySelector('[data-proxy-unfreeze]');
      urlInput?.addEventListener('pointerdown', (event) => event.stopPropagation());
      urlInput?.addEventListener('click', (event) => event.stopPropagation());
      let statusTimer = null;
      // An explicit unlock remains valid across status polls until a new save succeeds.
      let editingUnlocked = false;
      const setStatus = (text, state) => {
        if (!statusNode) return;
        statusNode.textContent = text;
        statusNode.dataset.status = state;
      };
      const scheduleAutoClose = () => {
        if (autoCloseTimer) window.clearTimeout(autoCloseTimer);
        if (autoCloseCountdownTimer) window.clearInterval(autoCloseCountdownTimer);
        autoClosePending = true;
        let remaining = 10;
        setStatus('代理启动成功，' + remaining + ' 秒后自动关闭设置面板', 'active');
        autoCloseCountdownTimer = window.setInterval(() => {
          remaining -= 1;
          if (remaining > 0) setStatus('代理启动成功，' + remaining + ' 秒后自动关闭设置面板', 'active');
        }, 1000);
        autoCloseTimer = window.setTimeout(() => {
          if (autoCloseCountdownTimer) window.clearInterval(autoCloseCountdownTimer);
          autoCloseCountdownTimer = null;
          close();
        }, 10000);
      };
      const setFrozen = (frozen) => {
        if (urlInput instanceof HTMLInputElement) urlInput.disabled = frozen;
        if (fileButton instanceof HTMLButtonElement) fileButton.disabled = frozen;
        if (save instanceof HTMLButtonElement) save.disabled = frozen;
        if (unfreeze instanceof HTMLButtonElement) {
          unfreeze.hidden = !frozen;
          unfreeze.setAttribute('aria-hidden', String(!frozen));
        }
        modal.dataset.proxyFrozen = String(frozen);
      };
      let savedFileName = '';
      let savedProxyFrozen = false;
      try { savedFileName = sessionStorage.getItem(FILE_NAME_KEY) || ''; } catch {}
      try { savedProxyFrozen = sessionStorage.getItem(FROZEN_KEY) === 'true'; } catch {}
      if (savedFileName && urlInput instanceof HTMLInputElement) urlInput.value = savedFileName;
      void fetch('/local-proxy/status', { cache: 'no-store' }).then((response) => response.json()).then((state) => {
        if (statusNode && state.running) {
          setStatus('代理启动成功', 'active');
          if (!editingUnlocked) setFrozen(Boolean(savedFileName || savedProxyFrozen));
        }
        if (!state.running && savedFileName && urlInput instanceof HTMLInputElement && !fileInput?.files?.length) {
          urlInput.value = '';
          savedFileName = '';
          try { sessionStorage.removeItem(FILE_NAME_KEY); } catch {}
        }
      }).catch(() => {});
      statusTimer = window.setInterval(() => {
        void fetch('/local-proxy/status', { cache: 'no-store' }).then((response) => response.json()).then((state) => {
          if (!autoClosePending) setStatus(state.running ? '代理启动成功' : (state.lastError ? '代理启动失败' : '代理未启动'), state.running ? 'active' : (state.lastError ? 'error' : 'inactive'));
          if (state.running && (savedFileName || savedProxyFrozen) && !editingUnlocked && modal.dataset.proxyFrozen !== 'true') setFrozen(true);
          if (!state.running && modal.dataset.proxyFrozen === 'true' && !autoClosePending) {
            savedProxyFrozen = false;
            try { sessionStorage.removeItem(FROZEN_KEY); } catch {}
            setFrozen(false);
          }
        }).catch(() => { setStatus('状态获取失败', 'error'); });
      }, 3000);
      unfreeze?.addEventListener('click', () => {
        editingUnlocked = true;
        savedProxyFrozen = false;
        try { sessionStorage.removeItem(FROZEN_KEY); } catch {}
        setFrozen(false);
        urlInput?.focus();
      });
      fileButton?.addEventListener('click', () => fileInput instanceof HTMLInputElement && fileInput.click());
      fileInput?.addEventListener('change', () => {
        const fileName = fileInput instanceof HTMLInputElement ? fileInput.files?.[0]?.name : '';
        if (urlInput instanceof HTMLInputElement && fileName) urlInput.value = fileName;
        setStatus('', '');
      });
      urlInput?.addEventListener('input', () => {
        if (!(urlInput instanceof HTMLInputElement) || !(fileInput instanceof HTMLInputElement)) return;
        if (fileInput.files?.length) {
          fileInput.value = '';
        }
      });
      modal.querySelector('[data-proxy-skip]')?.addEventListener('click', () => {
        try { sessionStorage.setItem(SESSION_KEY, 'true'); } catch {}
        close();
      });
      save?.addEventListener('click', async () => {
        if (!(save instanceof HTMLButtonElement)) return;
        save.disabled = true;
        setStatus('代理启动中…', 'pending');
        if (error) error.textContent = '';
        try {
          const file = fileInput instanceof HTMLInputElement ? fileInput.files?.[0] : null;
          const configText = file ? await file.text() : '';
          const enteredValue = urlInput instanceof HTMLInputElement ? urlInput.value.trim() : '';
          const subscriptionUrl = file || (savedFileName && enteredValue === savedFileName) ? '' : enteredValue;
          if (!configText.trim() && !subscriptionUrl) throw new Error('请先选择配置文件或填写订阅地址');
          const response = await fetch('/local-proxy/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ configText, subscriptionUrl }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || '代理启动失败');
          if (payload?.running !== true) throw new Error(payload?.error || '代理未启动');
          if (file?.name) {
            savedFileName = file.name;
            try { sessionStorage.setItem(FILE_NAME_KEY, savedFileName); } catch {}
          }
          setStatus('代理启动成功', 'active');
          editingUnlocked = false;
          savedProxyFrozen = true;
          try { sessionStorage.setItem(FROZEN_KEY, 'true'); } catch {}
          setFrozen(true);
          try { sessionStorage.setItem(SESSION_KEY, 'true'); } catch {}
          scheduleAutoClose();
        } catch (requestError) {
          setStatus('代理启动失败', 'error');
          if (error) error.textContent = requestError instanceof Error ? requestError.message : String(requestError);
          save.disabled = false;
        }
      });
      modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
      modal.addEventListener('DOMNodeRemoved', () => { if (statusTimer) window.clearInterval(statusTimer); }, { once: true });
      urlInput?.focus();
    };

    const check = async () => {
      try {
        const response = await fetch('/local-proxy/status', { cache: 'no-store' });
        const status = await response.json();
        let dismissed = false;
        try { dismissed = sessionStorage.getItem(SESSION_KEY) === 'true'; } catch {}
        if (status?.firstRun && !dismissed) open(status);
      } catch {
        // A static file opened outside the local service does not need the wizard.
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void check(), { once: true });
    else void check();
  })();
</script>`;

const localCanvasImageRelayScript = `<script id="local-canvas-image-relay">
(() => {
  const relays = {
    "https://www.tixyw.com/v1": "ixyapi",
    "https://zzone.cc.cd/v1": "zzone",
    "https://api2.jojocode.com/v1": "jojocode",
    "https://api-cn.hi-code.cc/v1": "hi-code",
  };
  const endpoints = /\\/(models|images\\/generations|images\\/edits|responses)(?:[?#]|$)/;
  const rewrite = (value) => {
    try {
      const original = new URL(String(value), location.href);
      // The native canvas prepends its local proxy URL when its own switch is
      // enabled, producing e.g. http://127.0.0.1:23210/https://host/v1/....
      // The workbench already owns an equivalent same-origin relay. Unwrap
      // that form before resolving the provider so retries do not depend on a
      // separately running canvas-proxy process.
      const wrappedTarget = original.pathname.match(/^\\/(https?:\\/\\/[^/]+\\/.*)$/i);
      const input = wrappedTarget ? new URL(wrappedTarget[1] + original.search) : original;
      const segments = input.pathname.split("/");
      const versionIndex = segments.indexOf("v1");
      if (versionIndex < 0) return value;
      const base = input.origin + segments.slice(0, versionIndex + 1).join("/");
      const provider = relays[base];
      const match = input.pathname.match(endpoints);
      if (!provider || !match) return value;
      return "/local-image-api/" + provider + "/" + match[1] + input.search;
    } catch { return value; }
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return originalOpen.call(this, method, rewrite(url), ...rest);
  };
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === "string" || input instanceof URL) return originalFetch.call(this, rewrite(input), init);
    if (input instanceof Request) {
      const next = rewrite(input.url);
      return originalFetch.call(this, next === input.url ? input : new Request(next, input), init);
    }
    return originalFetch.call(this, input, init);
  };
})();
</script>`;

const localCanvasSettingsBridgeScript = `<script id="local-canvas-settings-bridge">
  (() => {
    const STORAGE_KEY = "infinite-canvas:ai_config_store";
    const FALLBACK_KEY = "infinite-canvas:channel-fallback-v2";
    const LEGACY_FALLBACK_KEY = "infinite-canvas:channel-fallback";
    const NETWORK_FROZEN_KEY = "guan-workbench:network-proxy-frozen";
    const FALLBACK_CAPABILITIES = [
      { key: "image", label: "生图" },
      { key: "video", label: "视频" },
      { key: "text", label: "文本" },
      { key: "audio", label: "音频" },
    ];
    const installedDialogs = new WeakMap();
    const styleId = "local-canvas-settings-bridge-style";
    const addStyle = () => {
      if (document.getElementById(styleId)) return;
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = \`
        .local-canvas-settings-tabpanel{padding:2px 0 12px;min-height:260px}
        .local-canvas-proxy-section{margin-top:16px}
        .local-canvas-settings-card{border:1px solid #e7e5e4;border-radius:8px;padding:12px;background:transparent}
        .local-canvas-settings-card h4{margin:0;color:#17181a;font-size:14px;font-weight:650}
        .local-canvas-settings-card p{margin:4px 0 0;color:#78716c;font-size:12px;line-height:1rem}
        .local-canvas-settings-field{display:grid;gap:7px;margin-top:16px}
        .local-canvas-settings-field label{font-size:12px;color:#454950;font-weight:600}
        .local-canvas-settings-input-row{display:flex;gap:8px;align-items:center;border:1px solid #d9dce2;border-radius:9px;padding:4px 5px 4px 10px}
        .local-canvas-settings-input-row:focus-within{border-color:#3478f6;box-shadow:0 0 0 3px rgba(52,120,246,.14)}
        .local-canvas-settings-input{min-width:0;flex:1;border:0;outline:0;padding:7px 0;font:inherit;background:transparent;color:inherit}
        .local-canvas-settings-file{border:1px solid #d9dce2;border-radius:7px;padding:6px 9px;background:#f7f8fa;color:#34363b;font-size:12px;cursor:pointer}
        .local-canvas-settings-actions{display:flex;align-items:center;gap:8px;margin-top:16px}
        .local-canvas-settings-actions button{border:1px solid #d9dce2;border-radius:8px;padding:7px 11px;background:#fff;color:#24262a;font-size:12px;cursor:pointer}
        .local-canvas-settings-actions [data-canvas-proxy-unfreeze]{min-width:72px;color:#24262a;background:#fff}
        .local-canvas-settings-actions button.primary{border-color:#111;background:#111;color:#fff}
        .local-canvas-settings-actions button:disabled{opacity:.55;cursor:not-allowed}
        .local-canvas-settings-status{margin-right:auto;font-size:12px;color:#22925a}.local-canvas-settings-status[data-status='pending']{color:#b7791f}.local-canvas-settings-status[data-status='inactive'],.local-canvas-settings-status[data-status='error'],.local-canvas-settings-status.error{color:#d92d20}
        .local-canvas-settings-header{display:flex;align-items:center;justify-content:space-between;gap:12px}
        .local-canvas-settings-toggle{display:inline-flex;align-items:center;gap:8px;color:#454950;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
        .local-canvas-settings-toggle input{appearance:none;-webkit-appearance:none;position:relative;width:44px;height:24px;flex:0 0 44px;margin:0;border:1px solid #cfd3da;border-radius:999px;background:#d9dce2;cursor:pointer;transition:background .18s,border-color .18s,box-shadow .18s}
        .local-canvas-settings-toggle input::after{content:\"\";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .18s}
        .local-canvas-settings-toggle input:checked{border-color:#1f2024;background:#1f2024}
        .local-canvas-settings-toggle input:checked::after{transform:translateX(20px)}
        .local-canvas-settings-toggle input:focus-visible{outline:2px solid #3478f6;outline-offset:2px}
        .local-canvas-settings-toggle input:disabled{cursor:not-allowed;opacity:.55}
        .local-canvas-proxy-state{margin-top:8px;font-size:12px;color:#22925a}.local-canvas-proxy-state[data-status='pending']{color:#b7791f}.local-canvas-proxy-state[data-status='inactive'],.local-canvas-proxy-state[data-status='error'],.local-canvas-proxy-state.error{color:#d92d20}
        .local-canvas-native-proxy-status{display:inline-flex;align-items:center;margin:12px 0 0 10px;font-size:12px;color:#22925a}.local-canvas-native-proxy-status[data-status='pending']{color:#b7791f}.local-canvas-native-proxy-status[data-status='inactive'],.local-canvas-native-proxy-status[data-status='error'],.local-canvas-native-proxy-status.error{color:#d92d20}
        .local-canvas-fallback-list{display:grid;gap:8px;margin-top:14px}
        .local-canvas-fallback-switch{display:flex;align-items:center;gap:2px;width:max-content;max-width:100%;margin-top:14px;padding:3px;border-radius:9px;background:#f1f2f4}
        .local-canvas-fallback-switch button{border:0;border-radius:7px;padding:6px 14px;background:transparent;color:#60656d;font:inherit;font-size:12px;cursor:pointer;transition:background .18s,color .18s,box-shadow .18s}
        .local-canvas-fallback-switch button:hover{color:#1677ff}
        .local-canvas-fallback-switch button.is-active{background:#fff;color:#24262a;box-shadow:0 1px 4px rgba(20,24,32,.16);font-weight:600}
        .local-canvas-fallback-group{margin-top:14px;padding-top:14px;border-top:1px solid #eceef1}
        .local-canvas-fallback-group:first-of-type{margin-top:12px;padding-top:0;border-top:0}
        .local-canvas-fallback-group-head{display:flex;align-items:center;gap:10px}
        .local-canvas-fallback-group-head label{font-size:12px;color:#34363b;font-weight:650;cursor:pointer}
        .local-canvas-fallback-group-head small{margin-left:auto;color:#8b9098;font-size:11px}
        .local-canvas-fallback-group-head button{border:1px solid #d9dce2;border-radius:6px;padding:3px 7px;background:#fff;color:#666b73;font-size:11px;cursor:pointer;white-space:nowrap}
        .local-canvas-fallback-master{width:15px;height:15px;accent-color:#1677ff}
        .local-canvas-fallback-row{display:flex;align-items:center;gap:10px;border:1px solid #e7e7eb;border-radius:9px;padding:10px 11px}
        .local-canvas-fallback-row label{min-width:0;flex:1;font-size:12px;color:#25272b}.local-canvas-fallback-row small{display:block;margin-top:3px;color:#8b9098;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .local-canvas-fallback-row button{border:0;background:transparent;color:#717780;cursor:pointer;font-size:14px;padding:2px 4px}.local-canvas-fallback-row button:disabled{opacity:.35;cursor:not-allowed}
        .local-canvas-settings-note{margin-top:12px;font-size:12px;line-height:1rem;color:#78716c}
        html[data-theme="dark"] .local-canvas-settings-card,html.dark .local-canvas-settings-card{border-color:#292524;background:transparent;color:#f4f4f5}
        html[data-theme="dark"] .local-canvas-settings-card h4,html.dark .local-canvas-settings-card h4{color:#f4f4f5}
        html[data-theme="dark"] .local-canvas-settings-card p,html.dark .local-canvas-settings-card p,html[data-theme="dark"] .local-canvas-settings-note,html.dark .local-canvas-settings-note{color:#78716c}
        html[data-theme="dark"] .local-canvas-settings-field label,html.dark .local-canvas-settings-field label{color:#d8dce3}
        html[data-theme="dark"] .local-canvas-settings-input-row,html.dark .local-canvas-settings-input-row,html[data-theme="dark"] .local-canvas-settings-file,html.dark .local-canvas-settings-file,html[data-theme="dark"] .local-canvas-settings-actions button,html.dark .local-canvas-settings-actions button{border-color:rgba(255,255,255,.14);background:transparent;color:#f4f4f5}
        html[data-theme="dark"] .local-canvas-settings-actions button.primary,html.dark .local-canvas-settings-actions button.primary{border-color:#f4f4f5;background:#f4f4f5;color:#1e2024}
        html[data-theme="dark"] .local-canvas-settings-actions [data-canvas-proxy-unfreeze],html.dark .local-canvas-settings-actions [data-canvas-proxy-unfreeze]{border-color:rgba(255,255,255,.14);background:transparent;color:#f4f4f5}
        html[data-theme="dark"] .local-canvas-settings-toggle,html.dark .local-canvas-settings-toggle{color:#d8dce3}
        html[data-theme="dark"] .local-canvas-settings-toggle input,html.dark .local-canvas-settings-toggle input{border-color:rgba(255,255,255,.22);background:#4b4f57}
        html[data-theme="dark"] .local-canvas-settings-toggle input:checked,html.dark .local-canvas-settings-toggle input:checked{border-color:#f4f4f5;background:#f4f4f5}
        html[data-theme="dark"] .local-canvas-settings-toggle input:checked::after,html.dark .local-canvas-settings-toggle input:checked::after{background:#1e2024}
        html[data-theme="dark"] .local-canvas-fallback-row,html.dark .local-canvas-fallback-row,html[data-theme="dark"] .local-canvas-fallback-group,html.dark .local-canvas-fallback-group{border-color:#292524}
        html[data-theme="dark"] .local-canvas-fallback-row label,html.dark .local-canvas-fallback-row label{color:#f4f4f5}
        html[data-theme="dark"] .local-canvas-fallback-group-head label,html.dark .local-canvas-fallback-group-head label{color:#f4f4f5}
        html[data-theme="dark"] .local-canvas-fallback-master,html.dark .local-canvas-fallback-master{accent-color:#8ab4ff}
        html[data-theme="dark"] .local-canvas-fallback-switch,html.dark .local-canvas-fallback-switch{background:#292524}
        html[data-theme="dark"] .local-canvas-fallback-switch button,html.dark .local-canvas-fallback-switch button{color:#aeb4bf}
        html[data-theme="dark"] .local-canvas-fallback-switch button:hover,html.dark .local-canvas-fallback-switch button:hover{color:#8ab4ff}
        html[data-theme="dark"] .local-canvas-fallback-switch button.is-active,html.dark .local-canvas-fallback-switch button.is-active{background:#44403c;color:#f4f4f5;box-shadow:0 1px 4px rgba(0,0,0,.35)}
        [data-local-canvas-tab].ant-tabs-tab-active .ant-tabs-tab-btn{font-weight:400}
        [data-local-canvas-tab].ant-tabs-tab-active{border-bottom:0}
        .ant-tabs-nav-list{gap:4px}
        .ant-tabs-content-holder[data-local-canvas-custom-active="true"] [role="tabpanel"],.ant-tabs-body-holder[data-local-canvas-custom-active="true"] [role="tabpanel"]{display:none!important}
        [data-guan-hidden-native-settings]{display:none!important}
      \`;
      document.head.appendChild(style);
    };
    const readRootSettings = () => {
      try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        const settings = raw?.state?.config || raw?.config || {};
        const profiles = Array.isArray(settings.channels) ? settings.channels : [{
          id: "default", name: "默认渠道", baseUrl: "https://api.openai.com", apiFormat: "openai",
          models: [{ name: "gpt-image-2" }, { name: "grok-imagine-video" }, { name: "gpt-5.5" }, { name: "gpt-4o-mini-tts" }],
        }];
        const storedFallback = JSON.parse(localStorage.getItem(FALLBACK_KEY) || "null");
        const legacyFallback = JSON.parse(localStorage.getItem(LEGACY_FALLBACK_KEY) || "null");
        const storedCapabilities = storedFallback && storedFallback.capabilities
          ? storedFallback.capabilities
          : { image: legacyFallback && Array.isArray(legacyFallback.entries) ? legacyFallback : null };
        const byId = new Map(profiles.map((profile) => [profile.id, profile]));
        const capabilities = {};
        FALLBACK_CAPABILITIES.forEach(({ key }) => {
          const stored = storedCapabilities[key];
          const storedEntries = stored && Array.isArray(stored.entries) ? stored.entries : [];
          const available = profiles.filter((profile) => {
            const models = Array.isArray(profile.models) ? profile.models : [];
            return models.some((model) => !model.capability || model.capability === key);
          });
          const availableIds = new Set(available.map((profile) => profile.id));
          const entries = [];
          const storedFor = (profileId, modelName) => storedEntries.find((entry) => entry.profileId === profileId && (!entry.modelName || entry.modelName === modelName));
          available.forEach((profile) => {
            (profile.models || []).filter((model) => !model.capability || model.capability === key).forEach((model) => {
              const storedEntry = storedFor(profile.id, model.name);
              entries.push({ profileId: profile.id, modelName: model.name, enabled: storedEntry?.enabled === true, profile, model });
            });
          });
          const entryKey = (entry) => String(entry.profileId || "") + "::" + String(entry.modelName || "");
          const availableByKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
          const orderedEntries = [];
          const seenEntryKeys = new Set();
          storedEntries.forEach((storedEntry) => {
            const keyForEntry = entryKey(storedEntry);
            const availableEntry = availableByKey.get(keyForEntry);
            if (availableEntry && !seenEntryKeys.has(keyForEntry)) {
              orderedEntries.push(availableEntry);
              seenEntryKeys.add(keyForEntry);
            }
          });
          entries.forEach((entry) => {
            const keyForEntry = entryKey(entry);
            if (!seenEntryKeys.has(keyForEntry)) orderedEntries.push(entry);
          });
          capabilities[key] = { enabled: Boolean(stored?.enabled), entries: orderedEntries };
        });
        const enabled = FALLBACK_CAPABILITIES.some(({ key }) => {
          const group = capabilities[key];
          return group?.enabled === true && group.entries.some((entry) => entry.enabled === true);
        });
        return { raw, settings, capabilities, enabled };
      } catch {
        return { raw: null, settings: {}, capabilities: {}, enabled: false };
      }
    };
    const writeFallbackCapabilities = (capabilities, enabled) => {
      try {
        const normalized = {};
        FALLBACK_CAPABILITIES.forEach(({ key }) => {
          const group = capabilities?.[key] || {};
          normalized[key] = {
            enabled: Boolean(group.enabled),
            entries: Array.isArray(group.entries) ? group.entries.map((entry) => ({ profileId: entry.profileId, modelName: entry.modelName, enabled: entry.enabled === true })) : [],
          };
        });
        const effectiveEnabled = FALLBACK_CAPABILITIES.some(({ key }) => normalized[key].enabled && normalized[key].entries.some((entry) => entry.enabled));
        localStorage.setItem(FALLBACK_KEY, JSON.stringify({ enabled: effectiveEnabled, capabilities: normalized }));
        window.dispatchEvent(new CustomEvent("guan-fallback-config-changed", { detail: { enabled: effectiveEnabled, capabilities: normalized } }));
      } catch {}
    };
    const makeNetworkPanel = () => {
      const panel = document.createElement("div");
      panel.className = "local-canvas-settings-tabpanel";
      panel.dataset.localCanvasPanel = "network";
      panel.innerHTML = '<section class="local-canvas-settings-card"><div class="local-canvas-settings-header"><h4>设置网络代理</h4><label class="local-canvas-settings-toggle"><input data-canvas-proxy-toggle type="checkbox" />启用网络代理</label></div><div class="local-canvas-proxy-state" data-canvas-proxy-state>网络代理：查询中…</div><div class="local-canvas-settings-field"><label>代理配置文件或远端订阅地址</label><div class="local-canvas-settings-input-row"><input class="local-canvas-settings-input" data-canvas-proxy-input type="text" placeholder="https://example.com/your-subscription" autocomplete="off" /><button type="button" class="local-canvas-settings-file" data-canvas-proxy-file>选择文件</button><input data-canvas-proxy-file-input type="file" accept=".yaml,.yml,.txt,text/plain,application/yaml" hidden /></div></div><div class="local-canvas-settings-actions"><span class="local-canvas-settings-status" data-canvas-proxy-status></span><button type="button" data-canvas-proxy-unfreeze hidden>取消冻结</button><button type="button" class="primary" data-canvas-proxy-save>保存并启动代理</button></div><div class="local-canvas-settings-note" data-canvas-proxy-error></div></section>';
      let configText = "";
      const input = panel.querySelector("[data-canvas-proxy-input]");
      const fileButton = panel.querySelector("[data-canvas-proxy-file]");
      const fileInput = panel.querySelector("[data-canvas-proxy-file-input]");
      const saveButton = panel.querySelector("[data-canvas-proxy-save]");
      const toggle = panel.querySelector("[data-canvas-proxy-toggle]");
      const stateNode = panel.querySelector("[data-canvas-proxy-state]");
      const unfreezeButton = panel.querySelector("[data-canvas-proxy-unfreeze]");
      const status = panel.querySelector("[data-canvas-proxy-status]");
      const error = panel.querySelector("[data-canvas-proxy-error]");
      const diagnostics = document.createElement("div");
      diagnostics.className = "local-canvas-settings-note";
      diagnostics.innerHTML = '<div data-network-summary>当前服务器：读取中… · 延迟：未测试 · 配置文件：读取中…</div><div class="local-canvas-settings-actions"><button type="button" data-network-test>测试连接</button><button type="button" data-network-test-all>测试所有服务器延迟</button></div><div data-network-connect-status role="status"></div><div data-network-results style="max-height:220px;overflow:auto"></div>';
      stateNode?.after(diagnostics);
      const summary = diagnostics.querySelector("[data-network-summary]");
      const resultsNode = diagnostics.querySelector("[data-network-results]");
      const renderNetworkInfo = (result) => {
        const current = result?.currentNode;
        summary.textContent = "当前测试实际节点：" + (current?.name === "DIRECT" ? "直连（DIRECT，未经过远端代理服务器）" : current?.name || "未读取") + " · HTTP 实测延迟：" + (current?.latencyMs > 0 ? current.latencyMs + " ms" : current?.error || "尚未测试") + " · 配置文件：" + (result?.configName || "未配置") + (current?.testedAt ? " · 测试时间：" + new Date(current.testedAt).toLocaleTimeString() : "");
        resultsNode.replaceChildren();
        (result?.delayResults || []).forEach((item) => {
          const row = document.createElement("div");
          row.textContent = item.name + "：" + (item.latencyMs ? item.latencyMs + " ms" : item.error || "不可用");
          row.style.padding = "5px 0";
          resultsNode.append(row);
        });
      };
      const refreshNetworkInfo = async () => {
        try {
          const response = await fetch("/local-proxy/nodes", { cache: "no-store" });
          const result = await response.json();
          renderNetworkInfo(result);
          if (result.error) error.textContent = result.error;
        } catch { summary.textContent = "当前服务器：无法读取 · 延迟：未测试 · 配置文件：未知"; }
      };
      diagnostics.querySelector("[data-network-test-all]")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = "正在测试所有服务器…";
        try {
          const response = await fetch("/local-proxy/test-all", { method: "POST" });
          const result = await response.json();
          renderNetworkInfo(result);
          error.textContent = result.error || "";
        } catch { error.textContent = "节点延迟测试失败"; }
        finally { button.disabled = false; button.textContent = "测试所有服务器延迟"; }
      });
      diagnostics.querySelector("[data-network-test]")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        const connectionStatus = diagnostics.querySelector("[data-network-connect-status]");
        connectionStatus.style.color = "";
        connectionStatus.textContent = "正在通过网络代理测试外网访问…";
        try {
          const response = await fetch("/local-proxy/diagnostics", { cache: "no-store" });
          const result = await response.json();
          error.textContent = result.error || "";
          const connected = response.ok && result.reachable;
          connectionStatus.style.color = connected ? "#16a34a" : "#dc2626";
          connectionStatus.textContent = connected ? "Google 访问正常（通过网络代理）" : "Google 访问失败";
        } catch { connectionStatus.style.color = "#dc2626"; connectionStatus.textContent = "外网访问失败"; error.textContent = "网络代理连接测试失败"; }
        finally { button.disabled = false; }
      });
      void refreshNetworkInfo();
      let networkInfoTimer = window.setInterval(() => {
        if (!panel.isConnected) { window.clearInterval(networkInfoTimer); networkInfoTimer = null; return; }
        void refreshNetworkInfo();
      }, 10000);
      let editingUnlocked = false;
      let actionStatusTimer = null;
      const setFrozen = (frozen) => {
        if (input instanceof HTMLInputElement) input.disabled = frozen;
        if (fileButton instanceof HTMLButtonElement) fileButton.disabled = frozen;
        if (saveButton instanceof HTMLButtonElement) saveButton.disabled = frozen;
        if (unfreezeButton instanceof HTMLButtonElement) {
          unfreezeButton.hidden = !frozen;
          unfreezeButton.setAttribute("aria-hidden", String(!frozen));
        }
        panel.dataset.proxyFrozen = String(frozen);
      };
      const setState = (text, state) => {
        if (!(stateNode instanceof HTMLElement)) return;
        const resolvedState = typeof state === "string"
          ? state
          : state === true
            ? "error"
            : /启动中|停止中|查询中/.test(text)
              ? "pending"
              : /未启动|未启用/.test(text)
                ? "inactive"
                : "active";
        stateNode.textContent = text;
        stateNode.dataset.status = resolvedState;
        stateNode.classList.toggle("error", resolvedState === "error" || resolvedState === "inactive");
      };
      const setActionStatus = (text, state, clearAfterMs = 0) => {
        if (actionStatusTimer) window.clearTimeout(actionStatusTimer);
        actionStatusTimer = null;
        if (!(status instanceof HTMLElement)) return;
        status.textContent = text;
        if (state) status.dataset.status = state;
        else delete status.dataset.status;
        status.classList.toggle("error", state === "error" || state === "inactive");
        if (text && clearAfterMs > 0) {
          actionStatusTimer = window.setTimeout(() => {
            actionStatusTimer = null;
            setActionStatus("", "");
          }, clearAfterMs);
        }
      };
      const readFrozenPreference = () => {
        try { return sessionStorage.getItem(NETWORK_FROZEN_KEY) === "true"; } catch { return false; }
      };
      const writeFrozenPreference = (value) => {
        try {
          if (value) sessionStorage.setItem(NETWORK_FROZEN_KEY, "true");
          else sessionStorage.removeItem(NETWORK_FROZEN_KEY);
        } catch {}
      };
      const refreshStatus = async () => {
        try {
          const response = await fetch("/local-proxy/status", { cache: "no-store" });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result?.error || "状态获取失败");
          const running = result?.running === true;
          if (toggle instanceof HTMLInputElement) toggle.checked = running;
          setState(running ? "网络代理：已启动" : (result?.lastError ? "网络代理：启动失败" : "网络代理：未启动"), running ? "active" : (result?.lastError ? "error" : "inactive"));
          if (!running) {
            // The bottom action status is transient. Clear a previous
            // "代理启动成功" message when a later panel open reports that the
            // runtime is stopped, so the panel never shows stale state.
            if (status instanceof HTMLElement) {
              setActionStatus("", "");
            }
            if (error instanceof HTMLElement) error.textContent = result?.lastError || "";
          }
          if (running && readFrozenPreference() && !editingUnlocked) setFrozen(true);
          if (!running && panel.dataset.proxyFrozen === "true") setFrozen(false);
          return result;
        } catch (reason) {
          setState("网络代理：状态获取失败", "error");
          if (reason instanceof Error && error instanceof HTMLElement) error.textContent = reason.message;
          return null;
        }
      };
      fileButton?.addEventListener("click", () => fileInput?.click());
      fileInput?.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file || !input) return;
        configText = await file.text();
        input.value = file.name;
        input.dataset.fileName = file.name;
        editingUnlocked = true;
        setFrozen(false);
      });
      input?.addEventListener("input", () => {
        configText = "";
        editingUnlocked = true;
        setFrozen(false);
      });
      toggle?.addEventListener("change", async () => {
        if (!(toggle instanceof HTMLInputElement)) return;
        const enabled = toggle.checked;
        toggle.disabled = true;
        setState(enabled ? "网络代理：启动中…" : "网络代理：停止中…", "pending");
        try {
          const response = await fetch("/local-proxy/toggle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || (enabled && result?.running !== true)) throw new Error(result?.error || (enabled ? "代理启动失败" : "代理停止失败"));
          if (!enabled) {
            editingUnlocked = true;
            writeFrozenPreference(false);
            setFrozen(false);
          }
          setState(result?.running ? "网络代理：已启动" : "网络代理：未启动", result?.running ? "active" : "inactive");
        } catch (reason) {
          toggle.checked = !enabled;
          setState("网络代理：切换失败", "error");
          if (error instanceof HTMLElement) error.textContent = reason instanceof Error ? reason.message : "代理状态切换失败";
        } finally {
          toggle.disabled = false;
        }
      });
      saveButton?.addEventListener("click", async () => {
        if (!(input instanceof HTMLInputElement) || !(saveButton instanceof HTMLButtonElement)) return;
        const value = input.value.trim();
        const payload = configText.trim() ? { configText, fileName: input.dataset.fileName || value } : { subscriptionUrl: value };
        if (!configText.trim() && !value) { error.textContent = "请先上传配置文件或填写订阅地址"; return; }
        saveButton.disabled = true; error.textContent = ""; setActionStatus("启动中…", "pending");
        try {
          const response = await fetch("/local-proxy/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
          const result = await response.json();
          if (!response.ok) throw new Error(result?.error || "代理启动失败");
          setActionStatus(
            result?.running ? "代理启动成功" : "代理未启动",
            result?.running ? "active" : "inactive",
            result?.running ? 10000 : 0,
          );
          if (toggle instanceof HTMLInputElement) toggle.checked = result?.running === true;
          if (result?.running) {
            editingUnlocked = false;
            writeFrozenPreference(true);
            setFrozen(true);
            setState("网络代理：已启动", "active");
          } else {
            // A successful configuration response can still report a stopped
            // runtime (for example while a sidecar is unavailable). Do not
            // leave the editor disabled in that state.
            editingUnlocked = true;
            writeFrozenPreference(false);
            setFrozen(false);
            saveButton.disabled = false;
            setState("网络代理：未启动", "inactive");
          }
        } catch (reason) {
          setActionStatus("代理启动失败", "error");
          error.textContent = reason instanceof Error ? reason.message : "代理启动失败";
          saveButton.disabled = false;
        }
      });
      unfreezeButton?.addEventListener("click", () => {
        editingUnlocked = true;
        writeFrozenPreference(false);
        setFrozen(false);
        input?.focus();
      });
      panel._refreshStatus = () => {
        void refreshNetworkInfo();
        if (!networkInfoTimer) networkInfoTimer = window.setInterval(() => {
          if (!panel.isConnected) { window.clearInterval(networkInfoTimer); networkInfoTimer = null; return; }
          void refreshNetworkInfo();
        }, 10000);
        return refreshStatus();
      };
      void refreshStatus();
      return panel;
    };
    const installNativeProxyStatus = (holder) => {
      const pane = holder?.querySelector("[id$='-panel-local-proxy']");
      if (!(pane instanceof HTMLElement)) return null;
      const switchNode = Array.from(pane.querySelectorAll('[role="switch"]')).find((candidate) => /本地代理/.test(candidate.parentElement?.parentElement?.textContent || pane.textContent || ""));
      if (!(switchNode instanceof HTMLElement)) return null;
      const card = switchNode.closest("section") || switchNode.parentElement?.parentElement?.parentElement;
      if (!(card instanceof HTMLElement)) return null;
      // The native settings card is React-owned. We intentionally remove the
      // embedded workbench's unused tutorial nodes, but React may still try to
      // reconcile those exact nodes when the proxy switch rerenders. Keep a
      // small allow-list for only the nodes removed by this bridge so those
      // stale removeChild calls become harmless without masking other DOM
      // lifecycle errors in the canvas.
      const removedNodes = window.__guanNativeProxyRemovedNodes || (window.__guanNativeProxyRemovedNodes = new WeakSet());
      if (!window.__guanNativeProxyRemovePatch) {
        const nativeRemoveChild = Node.prototype.removeChild;
        Node.prototype.removeChild = function (child) {
          if (removedNodes.has(child) && child?.parentNode !== this) return child;
          return nativeRemoveChild.call(this, child);
        };
        window.__guanNativeProxyRemovePatch = true;
      }
      const rememberRemovedTree = (node) => {
        if (!(node instanceof Node)) return;
        removedNodes.add(node);
        node.querySelectorAll?.("*").forEach((nested) => removedNodes.add(nested));
      };
      const removeLeaf = (pattern, containerSelector = "") => {
        Array.from(card.querySelectorAll("*")).forEach((node) => {
          if (!(node instanceof HTMLElement) || node.children.length || !pattern.test((node.textContent || "").trim())) return;
          const container = containerSelector ? node.closest(containerSelector) : null;
          const target = container instanceof HTMLElement && container !== card ? container : node;
          rememberRemovedTree(target);
          target.remove();
        });
      };
      // The embedded workbench owns the proxy process, so the standalone
      // command/tutorial copy is not useful here. Remove those nodes instead
      // of hiding them while keeping the address and test controls. React can
      // repaint this card after the switch changes, so keep the cleanup in a
      // card-local observer rather than relying on a one-time pass.
      const cleanupCopy = () => {
        removeLeaf(/^开启后，拉取模型列表、生图、生视频、生成文本、生成音频和 WebDAV 同步/);
        removeLeaf(/^先在终端运行下面的命令/);
        removeLeaf(/^npx @basketikun\\/canvas-proxy@latest$/, "[class*='bg-stone-']");
        removeLeaf(/^需要和上面命令启动后打印的地址一致/);
        removeLeaf(/^渠道和 WebDAV 仍填写真实地址/);
      };
      let statusNode = card.querySelector("[data-local-canvas-native-proxy-status]");
      if (!(statusNode instanceof HTMLElement)) {
        statusNode = document.createElement("div");
        statusNode.dataset.localCanvasNativeProxyStatus = "true";
        statusNode.className = "local-canvas-native-proxy-status";
      }
      const placeStatus = () => {
        if (!(statusNode instanceof HTMLElement)) return;
        const testButton = Array.from(card.querySelectorAll("button")).find((candidate) => /测试连接/.test(candidate.textContent || ""));
        if (testButton instanceof HTMLElement) {
          if (statusNode.previousElementSibling !== testButton) testButton.insertAdjacentElement("afterend", statusNode);
          return;
        }
        const header = switchNode.parentElement;
        if (header instanceof HTMLElement && statusNode.parentElement !== header) header.append(statusNode);
        else if (!(statusNode.parentElement instanceof HTMLElement)) card.append(statusNode);
      };
      const setNativeStatus = (text, state) => {
        if (!(statusNode instanceof HTMLElement)) return;
        statusNode.textContent = text;
        statusNode.dataset.status = state;
        statusNode.classList.toggle("error", state === "error" || state === "inactive");
      };
      const installNativeProxyTest = () => {
        const testButton = Array.from(card.querySelectorAll("button")).find((candidate) => /测试连接/.test(candidate.textContent || ""));
        if (!(testButton instanceof HTMLButtonElement) || testButton.dataset.guanNativeProxyTestBridge) return;
        testButton.dataset.guanNativeProxyTestBridge = "true";
        testButton.addEventListener("click", async (event) => {
          // The native canvas test expects an external canvas-proxy process on
          // 127.0.0.1:23210. The workbench owns the relay process instead, so
          // test its authoritative same-origin status and prevent the native
          // handler from producing duplicate "Failed to fetch" toasts.
          event.preventDefault();
          event.stopImmediatePropagation();
          const wasDisabled = testButton.disabled;
          testButton.disabled = true;
          setNativeStatus("本地代理状态：检测中…", "pending");
          try {
            const response = await fetch("/local-proxy/status", { cache: "no-store" });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result?.relayEnabled === false) throw new Error(result?.lastError || "本地代理未启用");
            statusNode.removeAttribute("title");
            setNativeStatus("本地代理状态：测试成功", "active");
          } catch (reason) {
            setNativeStatus("本地代理状态：测试失败", "error");
            statusNode.title = reason instanceof Error ? reason.message : "本地代理连接失败";
          } finally {
            testButton.disabled = wasDisabled;
            window.setTimeout(() => { void refresh(); }, 2200);
          }
        }, { capture: true });
      };
      cleanupCopy();
      placeStatus();
      installNativeProxyTest();
      if (!card.dataset.guanProxyCleanupObserver) {
        card.dataset.guanProxyCleanupObserver = "true";
        new MutationObserver(() => { cleanupCopy(); placeStatus(); installNativeProxyTest(); }).observe(card, { childList: true, subtree: true });
      }
      const setSwitchState = (enabled) => {
        if ("checked" in switchNode) switchNode.checked = enabled;
        switchNode.setAttribute("aria-checked", String(enabled));
      };
      const refresh = async () => {
        try {
          const response = await fetch("/local-proxy/status", { cache: "no-store" });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result?.error || "状态获取失败");
          const enabled = result?.relayEnabled !== false;
          const current = "checked" in switchNode
            ? Boolean(switchNode.checked)
            : switchNode.getAttribute("aria-checked") === "true";
          // Keep the native config store in sync as well as the visual state;
          // its address/test controls are rendered only while proxyEnabled is
          // true. The click is handled by the native component and the relay
          // bridge together, so reopening settings restores the full panel.
          if (current !== enabled) switchNode.click();
          setSwitchState(enabled);
          setNativeStatus(enabled ? "本地代理状态：已启用" : "本地代理状态：未启用", enabled ? "active" : (result?.lastError ? "error" : "inactive"));
          return result;
        } catch (reason) {
          setNativeStatus("本地代理状态：获取失败", "error");
          return null;
        }
      };
      if (!switchNode.dataset.guanNativeProxyStatusListener) {
        switchNode.dataset.guanNativeProxyStatusListener = "true";
        switchNode.addEventListener("click", () => {
          const current = "checked" in switchNode
            ? Boolean(switchNode.checked)
            : switchNode.getAttribute("aria-checked") === "true";
          setNativeStatus(current ? "本地代理状态：停止中…" : "本地代理状态：启动中…", "pending");
        });
      }
      window.__guanRefreshLocalProxyStatus = refresh;
      void refresh();
      return refresh;
    };
    const installLocalProxyToggleBridge = () => {
      if (window.__guanLocalProxyToggleBridgeInstalled) return;
      window.__guanLocalProxyToggleBridgeInstalled = true;
      const pending = new WeakSet();
      const isLocalProxySwitch = (target) => {
        if (!(target instanceof Element)) return false;
        const switchNode = target.closest('[role="switch"]');
        if (!(switchNode instanceof HTMLElement)) return false;
        const scope = switchNode.closest('[role="dialog"],[role="tabpanel"]') || switchNode.parentElement;
        return Boolean(scope && /本地代理/.test(scope.textContent || ""));
      };
      const currentSwitchState = (switchNode) => "checked" in switchNode
        ? Boolean(switchNode.checked)
        : switchNode.getAttribute("aria-checked") === "true";
      const syncToggle = (target) => {
        const switchNode = target instanceof Element ? target.closest('[role="switch"]') : null;
        if (!(switchNode instanceof HTMLElement) || !isLocalProxySwitch(switchNode) || pending.has(switchNode)) return;
        pending.add(switchNode);
        window.setTimeout(async () => {
          pending.delete(switchNode);
          if (!switchNode.isConnected) return;
          const enabled = currentSwitchState(switchNode);
          try {
            const response = await fetch("/local-proxy/toggle", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enabled, relay: true }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.relayEnabled !== enabled) throw new Error(result?.error || "代理状态同步失败");
            window.__guanRefreshLocalProxyStatus?.();
          } catch (error) {
            const message = error instanceof Error ? error.message : "代理状态切换失败";
            window.dispatchEvent(new CustomEvent("guan-local-proxy-toggle-error", { detail: { message } }));
          }
        }, 0);
      };
      document.addEventListener("click", (event) => {
        const switchNode = event.target instanceof Element ? event.target.closest('[role="switch"]') : null;
        if (!(switchNode instanceof HTMLElement) || !isLocalProxySwitch(switchNode)) return;
        syncToggle(switchNode);
      });
    };
    installLocalProxyToggleBridge();
    const makeFallbackPanel = () => {
      const panel = document.createElement("div");
      panel.className = "local-canvas-settings-tabpanel";
      panel.dataset.localCanvasPanel = "fallback";
      let activeCapability = "image";
      panel.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest("button[data-fallback-reset], button[data-up], button[data-down]");
        if (!(button instanceof HTMLButtonElement)) return;
        const group = button.closest(".local-canvas-fallback-group");
        const key = group?.dataset.fallbackKey;
        if (!key) return;
        const data = readRootSettings();
        const groupData = data.capabilities[key] || { enabled: false, entries: [] };
        const profileIndex = new Map((Array.isArray(data.settings.channels) ? data.settings.channels : []).map((profile, index) => [profile.id, index]));
        const modelVersion = (name) => ({ "gpt-image-2.5-sunburst": 5, "gpt-image-2.5-flare": 4, "gpt-image-2.5": 3, "gpt-image-2-4k": 2, "gpt-image-2": 1 }[String(name || "").trim().toLowerCase()] || 0);
        const modelPrice = (entry) => Number.isFinite(Number(entry.model?.price)) ? Number(entry.model.price) : Number.POSITIVE_INFINITY;
        const compareDefault = (a, b) => modelVersion(b.modelName) - modelVersion(a.modelName) || modelPrice(a) - modelPrice(b) || (profileIndex.get(a.profileId) ?? 0) - (profileIndex.get(b.profileId) ?? 0) || String(a.modelName || "").localeCompare(String(b.modelName || ""));
        let entries = groupData.entries.map((item) => ({ profileId: item.profileId, modelName: item.modelName, enabled: item.enabled }));
        if (button.matches("[data-fallback-reset]")) entries = [...groupData.entries].sort(compareDefault).map((item) => ({ profileId: item.profileId, modelName: item.modelName, enabled: item.enabled }));
        else {
          const rows = Array.from(group.querySelectorAll(".local-canvas-fallback-row"));
          const index = rows.indexOf(button.closest(".local-canvas-fallback-row"));
          const nextIndex = button.matches("[data-up]") ? index - 1 : index + 1;
          if (index < 0 || nextIndex < 0 || nextIndex >= entries.length) return;
          [entries[index], entries[nextIndex]] = [entries[nextIndex], entries[index]];
        }
        event.preventDefault();
        event.stopPropagation();
        const capabilities = { ...data.capabilities, [key]: { enabled: groupData.enabled, entries } };
        writeFallbackCapabilities(capabilities, data.enabled);
        render();
      });
      const render = () => {
        const data = readRootSettings();
        panel.innerHTML = '<section class="local-canvas-settings-card"><h4>失败自动切换</h4><p>按渠道模型能力分别配置生图、视频、文本和音频的 Fallback。名称、协议、地址和模型跟随渠道更新。</p><div class="local-canvas-fallback-group-head local-canvas-fallback-global"><input class="local-canvas-fallback-master" type="checkbox" /><label>启用 Fallback 自动切换</label><small>总开关</small></div><div class="local-canvas-fallback-switch" data-canvas-fallback-switch></div><div data-canvas-fallback-groups></div><div class="local-canvas-settings-note">总开关关闭时不会执行任何 Fallback；每种能力还可独立保存渠道勾选和切换顺序。</div></section>';
        const globalMaster = panel.querySelector(".local-canvas-fallback-global .local-canvas-fallback-master");
        if (globalMaster instanceof HTMLInputElement) globalMaster.id = "guan-fallback-global";
        const globalLabel = panel.querySelector(".local-canvas-fallback-global label");
        if (globalLabel instanceof HTMLLabelElement) globalLabel.htmlFor = "guan-fallback-global";
        globalMaster.checked = data.enabled === true;
        globalMaster.addEventListener("change", () => {
          const capabilities = {};
          FALLBACK_CAPABILITIES.forEach(({ key }) => {
            const group = data.capabilities[key] || { enabled: false, entries: [] };
            capabilities[key] = {
              enabled: globalMaster.checked && group.enabled === true,
              entries: group.entries.map((entry) => ({ profileId: entry.profileId, modelName: entry.modelName, enabled: globalMaster.checked && entry.enabled === true })),
            };
          });
          writeFallbackCapabilities(capabilities, globalMaster.checked);
          render();
        });
        const switcher = panel.querySelector("[data-canvas-fallback-switch]");
        FALLBACK_CAPABILITIES.forEach(({ key, label }) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.className = key === activeCapability ? "is-active" : "";
          button.setAttribute("aria-pressed", String(key === activeCapability));
          button.addEventListener("click", () => { activeCapability = key; render(); });
          switcher?.appendChild(button);
        });
        const groups = panel.querySelector("[data-canvas-fallback-groups]");
        FALLBACK_CAPABILITIES.forEach(({ key, label }) => {
          const groupData = data.capabilities[key] || { enabled: false, entries: [] };
          const group = document.createElement("div"); group.className = "local-canvas-fallback-group";
          group.dataset.fallbackKey = key;
          group.hidden = key !== activeCapability;
          group.innerHTML = '<div class="local-canvas-fallback-group-head"><input class="local-canvas-fallback-master" type="checkbox" /><label></label><button type="button" data-fallback-reset>恢复默认排序</button><small></small></div><div class="local-canvas-fallback-list"></div>';
          const master = group.querySelector(".local-canvas-fallback-master");
          if (master instanceof HTMLInputElement) {
            master.id = "guan-fallback-" + key;
            master.checked = groupData.enabled === true && groupData.entries.some((entry) => entry.enabled === true);
          }
          const headLabel = group.querySelector("label"); headLabel.textContent = "启用" + label + " Fallback 自动切换";
          if (headLabel instanceof HTMLLabelElement) headLabel.htmlFor = "guan-fallback-" + key;
          const count = group.querySelector("small"); count.textContent = groupData.entries.length + " 个可用模型";
          const profileIndex = new Map((Array.isArray(data.settings.channels) ? data.settings.channels : []).map((profile, index) => [profile.id, index]));
          const modelVersion = (name) => {
            const normalized = String(name || "").trim().toLowerCase();
            return ({ "gpt-image-2.5-sunburst": 5, "gpt-image-2.5-flare": 4, "gpt-image-2.5": 3, "gpt-image-2-4k": 2, "gpt-image-2": 1 }[normalized] || 0);
          };
          const modelPrice = (entry) => Number.isFinite(Number(entry.model?.price)) ? Number(entry.model.price) : Number.POSITIVE_INFINITY;
          const save = (next) => {
            const capabilities = { ...data.capabilities, [key]: { enabled: next.enabled, entries: next.entries.map((item) => ({ profileId: item.profileId, modelName: item.modelName, enabled: item.enabled })) } };
            writeFallbackCapabilities(capabilities, data.enabled);
            render();
          };
          const reorder = (compare) => {
            const next = [...groupData.entries].sort(compare).map((item) => ({ profileId: item.profileId, modelName: item.modelName, enabled: item.enabled }));
            save({ enabled: groupData.enabled, entries: next });
          };
          const list = group.querySelector(".local-canvas-fallback-list");
          master.addEventListener("change", () => {
            const enabled = master.checked;
            save({ enabled, entries: groupData.entries.map((item) => ({ profileId: item.profileId, modelName: item.modelName, enabled })) });
          });
          groupData.entries.forEach((entry, index) => {
            const profile = entry.profile;
            const row = document.createElement("div"); row.className = "local-canvas-fallback-row";
            row.innerHTML = '<input type="checkbox" /><label></label><button type="button" data-up>↑</button><button type="button" data-down>↓</button>';
            const checkbox = row.querySelector("input");
            const checkboxId = "guan-fallback-" + key + "-" + String(entry.profileId || index).replace(/[^a-z0-9_-]/gi, "_");
            if (checkbox instanceof HTMLInputElement) {
              checkbox.id = checkboxId;
              checkbox.checked = entry.enabled === true;
            }
            const rowLabel = row.querySelector("label"); rowLabel.textContent = (profile.name || profile.id) + " · " + (entry.modelName || entry.model?.name || "未命名模型");
            if (rowLabel instanceof HTMLLabelElement) rowLabel.htmlFor = checkboxId;
            const models = document.createElement("small"); models.textContent = (profile.apiFormat === "gemini" ? "Gemini" : "OpenAI") + " · " + (profile.baseUrl || "未设置地址") + (entry.model?.price == null ? "" : " · 价格 " + entry.model.price); rowLabel.appendChild(models);
            checkbox.addEventListener("change", () => {
              const entries = groupData.entries.map((item) => ({ profileId: item.profileId, modelName: item.modelName, enabled: item.profileId === entry.profileId && item.modelName === entry.modelName ? checkbox.checked : item.enabled }));
              save({ enabled: entries.some((item) => item.enabled), entries });
            });
            const up = row.querySelector("[data-up]"), down = row.querySelector("[data-down]"); up.disabled = index === 0; down.disabled = index === groupData.entries.length - 1;
            list?.appendChild(row);
          });
          if (!groupData.entries.length && list) list.textContent = "暂无匹配此能力的渠道模型。";
          groups?.appendChild(group);
        });
      };
      render();
      panel._renderFallback = render;
      return panel;
    };
    const install = () => {
      const fallbackHost = document.querySelector("[data-guan-fallback-host]");
      const dialog = fallbackHost?.closest("[role=dialog]");
      if (!(dialog instanceof HTMLElement)) return;
      installLocalProxyToggleBridge();
      const nav = dialog.querySelector(".ant-tabs-nav-list");
      const holder = dialog.querySelector(".ant-tabs-content-holder, .ant-tabs-body-holder");
      if (!(nav instanceof HTMLElement) || !(holder instanceof HTMLElement)) return;
      if (!(fallbackHost instanceof HTMLElement)) return;
      addStyle();
      let panels = installedDialogs.get(dialog);
      if (!panels) {
        const fallbackPanel = makeFallbackPanel();
        fallbackPanel.dataset.localCanvasPanel = "fallback";
        const networkPanel = makeNetworkPanel();
        networkPanel.classList.add("local-canvas-proxy-section");
        panels = { fallbackPanel, networkPanel };
        installedDialogs.set(dialog, panels);
      }
      const { fallbackPanel, networkPanel } = panels;
      if (!fallbackHost.contains(fallbackPanel)) fallbackHost.appendChild(fallbackPanel);
      const pane = holder.querySelector("[id$='-panel-local-proxy']");
      if (pane instanceof HTMLElement && !pane.contains(networkPanel)) {
        pane.appendChild(networkPanel);
        networkPanel._refreshStatus?.();
      }
      if (pane instanceof HTMLElement && !pane.querySelector("[data-local-canvas-native-proxy-status]")) {
        installNativeProxyStatus(holder);
      }
    };
    window.addEventListener("guan-config-panel-open", () => {
      install();
      document.querySelectorAll("[data-local-canvas-panel='fallback']").forEach((panel) => panel._renderFallback?.());
      const proxyPane = document.querySelector("[id$='-panel-local-proxy'].ant-tabs-tabpane-active");
      if (proxyPane) window.__guanRefreshLocalProxyStatus?.();
    });
    const hideNativeSettingsEntry = () => {
      document.querySelectorAll("button").forEach((button) => {
        if (!(button instanceof HTMLElement)) return;
        const label = (button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent || "").trim();
        if (label !== "配置") return;
        button.dataset.guanHiddenNativeSettings = "true";
        button.style.setProperty("display", "none", "important");
      });
    };
    hideNativeSettingsEntry();
    new MutationObserver(hideNativeSettingsEntry).observe(document.documentElement, { childList: true, subtree: true });
    new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
    install();
  })();
</script>`;

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
const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const explicitImageRelayProxySetting = process.env.IMAGE_RELAY_PROXY_URL?.trim() || "";
let imageRelayProxySetting = explicitImageRelayProxySetting || "http://127.0.0.1:7890";
const imageRelayProxyAgents = new Map();
// Route learning persists outside the version directory; no credentials belong here.
const transportPreferenceFile = privatePaths.transportsFile;
const imageRelayTransportPreferences = new Map();
try {
  for (const [key, value] of Object.entries(JSON.parse(readFileSync(transportPreferenceFile, "utf8")))) {
    if (value === "proxy" || value === "direct") imageRelayTransportPreferences.set(key, value);
  }
} catch {}
let runtimeImageProxySource = null;
let runtimeImageProxyLastError = "";
let savedProxyState = null;
let proxyStateReadFailed = false;
try { savedProxyState = await readProxyState(privatePaths.proxyStateFile); }
catch { proxyStateReadFailed = true; runtimeImageProxyLastError = "私人代理状态损坏，已保留原配置，请先备份后修复"; }
let runtimeProxyConfigName = basename(process.env.IMAGE_RELAY_MIHOMO_CONFIG_FILE || process.env.IMAGE_RELAY_SUBSCRIPTION_FILE || "") || (process.env.IMAGE_RELAY_SUBSCRIPTION_URL ? "远端订阅配置" : "default-proxy.yaml");
let runtimeProxyNodeInfo = null;
let runtimeProxyDelayResults = [];
// The canvas switch controls the same-origin image relay independently from
// the optional Mihomo/Clash transport proxy.
let imageRelayEnabled = savedProxyState?.relayEnabled ?? true;
// Keep the last runtime source in memory so the settings switch can stop and
// start the same local proxy without asking the user to upload the config again.
let lastRuntimeImageProxySourceOverride = savedProxyState?.source || null;
let lastKnownGoodProxyConfig = savedProxyState?.cachedConfig || null;
let lastRuntimeImageProxySourceKind = savedProxyState?.source ? savedProxyState.source.kind === "text" ? "uploaded" : "subscription" : null;
if (savedProxyState) runtimeProxyConfigName = savedProxyState.configName;

async function persistProxyState() {
  if (proxyStateReadFailed) throw new Error("私人代理状态损坏，未覆盖原文件，请先备份后修复");
  const state = { version: 1, enabled: Boolean(builtInImageProxy), relayEnabled: imageRelayEnabled,
    source: lastRuntimeImageProxySourceOverride, cachedConfig: lastKnownGoodProxyConfig, configName: runtimeProxyConfigName };
  if (Buffer.byteLength(JSON.stringify(state, null, 2)) > 24 * 1024 * 1024) throw new Error("私人代理状态超过安全大小限制，未覆盖旧配置");
  await writePrivateJson(privatePaths.proxyStateFile, state);
}

let proxyMutationQueue = Promise.resolve();
function mutateProxyState(change) {
  const operation = proxyMutationQueue.catch(() => undefined).then(async () => {
    if (shutdownStarted) throw new Error("服务正在停止，未更改代理配置");
    if (proxyStateReadFailed) throw new Error("私人代理状态损坏，未更改代理，请先备份后修复");
    const previous = { running: Boolean(builtInImageProxy), relay: imageRelayEnabled,
      source: lastRuntimeImageProxySourceOverride, cache: lastKnownGoodProxyConfig,
      kind: lastRuntimeImageProxySourceKind, name: runtimeProxyConfigName };
    try {
      await change();
      await persistProxyState();
      runtimeImageProxyLastError = "";
      return getLocalProxyStatus();
    } catch {
      // Never persist a rejected configuration; restore the known-good runtime.
      const restart = previous.running && (!builtInImageProxy || lastKnownGoodProxyConfig !== previous.cache);
      if (!previous.running || restart) await stopBuiltInImageProxy();
      imageRelayEnabled = previous.relay;
      lastRuntimeImageProxySourceOverride = previous.source;
      lastKnownGoodProxyConfig = previous.cache;
      lastRuntimeImageProxySourceKind = previous.kind;
      runtimeProxyConfigName = previous.name;
      if (restart) {
        try {
          await startRuntimeBuiltInImageProxy(previous.cache ? { kind: "text", value: previous.cache } : previous.source, previous.kind, previous.source);
        } catch {
          throw new Error("代理变更失败，原配置已保留，但旧代理重新启动失败，请检查端口和核心");
        }
      }
      throw new Error("代理变更或保存失败，已恢复原状态；请检查配置、端口和私人目录写入权限");
    }
  });
  proxyMutationQueue = operation;
  return operation;
}

function configureImageRelayProxyUrl(proxyUrl) {
  if (!explicitImageRelayProxySetting || process.env.IMAGE_RELAY_PROXY_MODE === "sidecar") {
    imageRelayProxySetting = proxyUrl;
  }
}

function getImageRelayProxyUrl() {
  if (!imageRelayProxySetting || /^(?:off|none|disabled)$/i.test(imageRelayProxySetting)) return null;
  try {
    const url = new URL(imageRelayProxySetting);
    // Clash Party's mixed port is an HTTP proxy. SOCKS-only endpoints are not
    // used implicitly because silently treating a SOCKS port as HTTP produces
    // confusing failures and could retry through an unintended service.
    if (url.protocol !== "http:") return null;
    return url;
  } catch {
    return null;
  }
}

function isLocalAppRequest(request) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  return localHosts.has(host) && (!origin || origin === `http://${host}`);
}

function getImageRelayTransportPreference(provider) {
  const value = imageRelayTransportPreferences.get(provider);
  return value === "proxy" || value === "direct" ? value : null;
}

async function setImageRelayTransportPreference(provider, transport) {
  if (transport === "proxy" || transport === "direct") {
    imageRelayTransportPreferences.set(provider, transport);
    await writePrivateJson(transportPreferenceFile, Object.fromEntries(imageRelayTransportPreferences))
      .catch(() => console.error("[image-relay] route persistence failed"));
  }
}

function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(value);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        request.destroy();
        finish(new Error("请求体超过本地中转层允许的大小"));
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => finish(null, Buffer.concat(chunks)));
    request.once("aborted", () => finish(new Error("客户端在上传请求体时中断连接")));
    request.once("error", (error) => finish(error));
  });
}

function getImageRelayProxyAgent(proxyUrl) {
  const key = proxyUrl.href;
  let agent = imageRelayProxyAgents.get(key);
  if (!agent) {
    agent = new ProxyAgent(key);
    imageRelayProxyAgents.set(key, agent);
  }
  return agent;
}

async function closeImageRelayProxyAgents() {
  await Promise.all([...imageRelayProxyAgents.values()].map((agent) => agent.close()));
  imageRelayProxyAgents.clear();
}

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
  // These filenames are stable while their contents change during local
  // upgrades. Only content-hashed build assets may be cached immutably.
  const mutableWorkbenchControls = path.startsWith(join(projectRoot, 'src', 'shared', 'data-contract'))
    || path.startsWith(join(assetRoot, 'local-canvas'));
  response.writeHead(200, {
    "content-type": contentTypes[extname(path).toLowerCase()] || "application/octet-stream",
    "cache-control": isHtml || mutableWorkbenchControls ? "no-store" : "public, max-age=31536000, immutable",
    "content-security-policy": staticOnlyCsp,
    "x-static-archive": "guan-detail-page-static",
  });
  if (method === "HEAD") return response.end();
  if (isHtml) {
    const document = await readFile(path, "utf8");
    // Native canvas has its own React providers and styles. Injecting the
    // archived workbench scripts here would create duplicate settings/UI.
    if (path !== pageFile) return response.end(document);
    const refreshedFavicon = (path === pageFile
      ? document.replace(/<title>[\s\S]*?<\/title>/i, "<title>AI生图工作台</title>")
      : document)
      // The archived page includes PixPix's locale-selection redirect, which
      // would turn this project's root entry point into /zh-CN at runtime.
      // The archived detail page itself is Chinese, so the redirect is neither
      // needed nor desirable in this single-page local MVP.
      .replace(/<script id="root-locale-redirect">[\s\S]*?<\/script>/, "")
      .replace(/href="\/_pixpix-assets\/www\.pixpix\.com\/favicon\.ico[^"]*"/g, 'href="/favicon.ico?g-brand-v4"')
      .replace(/href="\/favicon\.ico[^"]*"/g, 'href="/favicon.ico?g-brand-v4"')
      .replace(/\\\"href\\\":\\\"\/favicon\.ico[^\\\"]*/g, '\\\"href\\\":\\\"/favicon.ico?g-brand-v4')
      .replace(/href="\/zh-CN\/workbench"/g, 'href="/"');
    /*
     * Keep a single settings implementation. The archived page used to receive
     * a second, hand-written modal here; that modal shared the same button
     * class, event target and z-index namespace as the real React settings
     * application. It was hidden by the React capture listener, but its
     * MutationObserver and global styles could still race the live tree.
     * The original button injector only creates the trigger; the React bundle
     * owns the modal, focus scope, nested dialogs and persistence.
     */
      response.end(refreshedFavicon.replace("</head>", `${workbenchLogoStyle}${mvpNavigationStyle}${localThemeAndUiStyle}${localDocumentTitleScript}${localRootNavigationScript}${canvasSettingsEntryBridgeScript}${localThemeToggleScript}${localFixedFieldsScript}${localResolutionButtonsScript}${localAspectRatioButtonsScript}${localOfflineGuardsScript}${localGenerationButtonScript}${localResponsivePreviewScript}${localProxySetupScript}<script src="/_pixpix-assets/local-vendor/xlsx.full.min.js?sheetjs-local-0.18.5"></script><script src="/_pixpix-assets/local-vendor/fflate.umd.js?fflate-local-0.8.3"></script><script type="module" src="/data-contract/index.js?contract-v40-20261010-workbook-products"></script><link rel="stylesheet" href="/_pixpix-assets/local-canvas/canvas.css?canvas-v21"><script src="/_pixpix-assets/local-canvas/canvas.js?canvas-v20-20261010-workbook-products"></script></head>`));
    return;
  }
  createReadStream(path).pipe(response);
}

function shouldRetryImageRelayThroughProxy(provider, upstream) {
  if (!upstream) return true;
  // The tixyw gateway explicitly marks requests rejected by its regional
  // policy. A 403 from another compatible provider is also safe to retry:
  // authentication failures are returned as 401 by these APIs and do not
  // create a billed image task.
  return [403, 407, 408, 502, 503, 504].includes(upstream.status);
}

function fetchRelayHeaders(upstream, requestId, transport, bodyLength) {
  const contentLength = Number.isFinite(bodyLength)
    ? String(bodyLength)
    : upstream.headers.get("content-length");
  return {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
    connection: "close",
    "x-image-relay-request-id": requestId,
    "x-image-relay-transport": transport,
    ...(contentLength ? { "content-length": contentLength } : {}),
  };
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
  if (!imageRelayEnabled) {
    const body = JSON.stringify({ error: { code: "local_relay_disabled", message: "本地图片中转服务未启用" } });
    response.writeHead(503, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }
  if ((endpoint === "models" && request.method !== "GET") || (endpoint !== "models" && request.method !== "POST")) {
    response.writeHead(405, { allow: endpoint === "models" ? "GET" : "POST", "cache-control": "no-store" });
    response.end();
    return;
  }

  const maxBodyBytes = 100 * 1024 * 1024;
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > maxBodyBytes) {
    response.writeHead(413, { "cache-control": "no-store" });
    response.end();
    return;
  }

  let requestBody;
  if (request.method !== "GET") {
    try {
      requestBody = await readRequestBody(request, maxBodyBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取图片请求体";
      const body = JSON.stringify({ error: { code: "local_relay_request_body_error", message } });
      response.writeHead(message.includes("超过") ? 413 : 400, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
  }

  const headers = {
    accept: request.headers.accept || "application/json",
    "accept-encoding": "identity",
  };
  if (request.headers.authorization) headers.authorization = request.headers.authorization;
  if (request.headers["content-type"]) headers["content-type"] = request.headers["content-type"];
  if (request.headers["content-length"]) headers["content-length"] = request.headers["content-length"];
  if (requestBody && !headers["content-length"]) headers["content-length"] = String(requestBody.length);

  const upstreamUrl = `https://${imageRelayUpstreams[provider]}/v1/${endpoint}`;
  const requestId = randomUUID().replaceAll("-", "");
  const clientAbortController = new AbortController();
  const relayAbortController = new AbortController();
  // The settings panel owns the request timeout. The browser sends it to the
  // same-origin relay so an image generation can wait as long as configured;
  // the environment value is only a backwards-compatible fallback for older
  // clients that do not send the header.
  const configuredTimeoutMs = Number(request.headers["x-image-relay-timeout-ms"]);
  const fallbackTimeoutMs = Number(process.env.IMAGE_RELAY_UPSTREAM_TIMEOUT_MS || 30 * 60 * 1000);
  const relayTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? Math.max(1_000, configuredTimeoutMs)
    : Math.max(30_000, Number.isFinite(fallbackTimeoutMs) ? fallbackTimeoutMs : 30 * 60 * 1000);
  const relayTimeout = setTimeout(() => relayAbortController.abort(), relayTimeoutMs);
  response.once("close", () => {
    if (!response.writableEnded) {
      clientAbortController.abort();
      relayAbortController.abort();
    }
  });

  let directResponse = null;
  let directBody = null;
  let directError = null;
  let proxyResponse = null;
  let proxyBody = null;
  let proxyError = null;
  const proxyUrl = getImageRelayProxyUrl();
  const channelId = String(request.headers["x-image-relay-channel"] || "").slice(0, 128);
  const transportKey = channelId ? provider + ":" + channelId : provider;
  const preferredTransport = getImageRelayTransportPreference(transportKey);
  let proxyAttempted = false;
  let responseBodyError = null;

  const fetchAttempt = async (transport) => {
    const connectController = new AbortController();
    const upstreamTimeout = setTimeout(() => connectController.abort(), relayTimeoutMs);
    try {
      return await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" ? undefined : requestBody,
        redirect: "manual",
        ...(transport === "proxy" && proxyUrl
          ? { dispatcher: getImageRelayProxyAgent(proxyUrl) }
          : {}),
        signal: AbortSignal.any([relayAbortController.signal, clientAbortController.signal, connectController.signal]),
      });
    } catch (error) {
      return { error };
    } finally {
      // fetch() resolves only once response headers arrive. Keep the timer
      // active for the full upstream generation window; the relay lifetime
      // controller still bounds the body transfer as well.
      clearTimeout(upstreamTimeout);
    }
  };

  const sendUpstream = async (upstream, transport, body = null) => {
    // Learn a provider's preferred route only after the upstream actually
    // accepted the request.  A region/auth/policy error is still a transport
    // response, but it must never poison the direct-first/proxy-fallback
    // preference for the next request.
    // Image edits are consumed as one complete JSON response by the browser.
    // Buffering this endpoint in the local relay prevents a large Base64 body
    // from being cut off while a proxy connection is being switched or closed.
    let payload = body;
    if (payload === null && endpoint.startsWith("images/") && upstream.ok) {
      try {
        payload = Buffer.from(await upstream.arrayBuffer());
      } catch (error) {
        responseBodyError = error;
        throw error;
      }
    }
    if (upstream.ok && endpoint.startsWith("images/") && payload) {
      try {
        const result = JSON.parse(payload.toString("utf8"));
        if (Array.isArray(result.data) && result.data.some((image) => image.b64_json || image.url)) {
          await setImageRelayTransportPreference(transportKey, transport);
        }
      } catch {}
    }
    // Gateways often return an HTML 403/502 page instead of the JSON error
    // contract expected by the canvas. Normalize it so the UI can explain
    // the actual cause (region policy, proxy rejection, or upstream outage)
    // and fallback logic can make a useful decision.
    const contentType = upstream.headers.get("content-type") || "";
    if (upstream.status >= 400 && /text\/html/i.test(contentType) && (payload === null || Buffer.isBuffer(payload))) {
      if (payload === null) await upstream.text();
      const reason = upstream.status === 403
        ? "上游服务拒绝了请求（HTTP 403），可能是地区策略或渠道权限限制，请切换渠道或代理节点"
        : `上游服务返回了 HTML 错误页面（HTTP ${upstream.status}）`;
      const normalized = Buffer.from(JSON.stringify({ error: { code: "upstream_html_error", message: reason }, upstream_status: upstream.status, transport }));
      response.writeHead(upstream.status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": normalized.length,
        "cache-control": "no-store",
        connection: "close",
        "x-image-relay-request-id": requestId,
        "x-image-relay-transport": transport,
      });
      response.end(normalized);
      return;
    }
    response.writeHead(upstream.status, fetchRelayHeaders(upstream, requestId, transport, payload === null ? undefined : payload.length));
    if (payload !== null) {
      response.end(payload);
      return;
    }
    if (!upstream.body) {
      response.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body), response);
  };

  try {
    const tryProxy = async () => {
      if (!proxyUrl || clientAbortController.signal.aborted) return;
      if (proxyAttempted) return;
      proxyAttempted = true;
      const result = await fetchAttempt("proxy");
      if (result?.error) {
        proxyError = result.error;
        return;
      }
      proxyResponse = result;
    };
    const tryDirect = async () => {
      if (clientAbortController.signal.aborted) return;
      const result = await fetchAttempt("direct");
      if (result?.error) {
        directError = result.error;
        return;
      }
      directResponse = result;
    };

    // Once a provider succeeds through the proxy, use that route first for
    // subsequent requests. If it stops working, probe direct and relearn.
    if (preferredTransport === "proxy" && proxyUrl) {
      await tryProxy();
      if (proxyResponse) {
        await sendUpstream(proxyResponse, "proxy");
        return;
      }
      throw proxyError || new Error("已标记渠道的网络代理不可用");
    }

    await tryDirect();
    if (directResponse && !shouldRetryImageRelayThroughProxy(provider, directResponse)) {
      await sendUpstream(directResponse, "direct");
      return;
    }
    if (directResponse) directBody = Buffer.from(await directResponse.arrayBuffer());

    const shouldTryProxy = Boolean(proxyUrl) && !proxyAttempted && !clientAbortController.signal.aborted && (
      !proxyResponse || shouldRetryImageRelayThroughProxy(provider, proxyResponse) ||
      Boolean(directError) || shouldRetryImageRelayThroughProxy(provider, directResponse)
    );
    if (shouldTryProxy) {
      await tryProxy();
      if (proxyResponse && !shouldRetryImageRelayThroughProxy(provider, proxyResponse)) {
        await sendUpstream(proxyResponse, "proxy");
        return;
      }
      if (proxyResponse && !proxyBody) proxyBody = Buffer.from(await proxyResponse.arrayBuffer());
    }

    if (directResponse) {
      await sendUpstream(directResponse, "direct", directBody);
      return;
    }
    if (proxyResponse) {
      await sendUpstream(proxyResponse, "proxy", proxyBody);
      return;
    }

    throw directError || proxyError || new Error("本地图片中转请求失败");
  } catch {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const directState = directResponse ? `direct-${directResponse.status}` : directError ? "direct-network-error" : "direct-not-attempted";
    const proxyState = !proxyUrl
      ? "proxy-not-configured"
      : proxyResponse
        ? `proxy-${proxyResponse.status}`
        : proxyError
          ? "proxy-network-error"
          : "proxy-not-attempted";
    const bodyState = responseBodyError ? "response-body-error" : "response-body-ok";
    const body = JSON.stringify({
      error: {
        code: "local_relay_result_unknown",
        message: `图片请求未收到完整结果（${directState}，${proxyState}，${bodyState}）；上游可能已生成并扣费。当前指定渠道不会自动切换；只有选择 Fallback 自动选择时才会尝试下一渠道。`,
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
  } finally {
    clearTimeout(relayTimeout);
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

function getLocalProxyStatus() {
  const envConfigured = Boolean(
    process.env.IMAGE_RELAY_MIHOMO_CONFIG_FILE?.trim() ||
    process.env.IMAGE_RELAY_SUBSCRIPTION_FILE?.trim() ||
    process.env.IMAGE_RELAY_SUBSCRIPTION_URL?.trim() ||
    (process.env.IMAGE_RELAY_SUBSTORE_API_URL?.trim() && process.env.IMAGE_RELAY_SUBSCRIPTION_NAME?.trim()),
  );
  const explicitConfigured = Boolean(explicitImageRelayProxySetting);
  const configured = Boolean(builtInImageProxy || runtimeImageProxySource || lastRuntimeImageProxySourceOverride || lastRuntimeImageProxySourceKind || envConfigured || explicitConfigured || existsSync(builtInProxyConfigFile));
  return {
    configured,
    running: Boolean(builtInImageProxy),
    relayEnabled: imageRelayEnabled,
    firstRun: !configured,
    source: runtimeImageProxySource || lastRuntimeImageProxySourceKind || (builtInImageProxy ? "environment" : explicitConfigured ? "proxy-url" : envConfigured ? "environment" : existsSync(builtInProxyConfigFile) ? "builtin" : null),
    proxyAvailable: Boolean(getImageRelayProxyUrl()),
    lastError: runtimeImageProxyLastError || null,
    configName: runtimeProxyConfigName,
    currentNode: runtimeProxyNodeInfo,
    delayResults: runtimeProxyDelayResults,
  };
}

async function inspectProxyNodes(testAll = false) {
  if (!builtInImageProxy?.controllerUrl) throw new Error("网络代理尚未启动，无法读取节点");
  const base = builtInImageProxy.controllerUrl;
  const reply = await fetch(base + "/proxies", { signal: AbortSignal.timeout(5000) });
  if (!reply.ok) throw new Error(`无法读取代理节点（HTTP ${reply.status}）`);
  const { proxies = {} } = await reply.json();
  const modeResponse = await fetch(base + "/configs", { signal: AbortSignal.timeout(5000) });
  const mode = modeResponse.ok ? (await modeResponse.json()).mode : null;
  let name = mode === "global" ? proxies["GLOBAL"]?.now : proxies["IMAGE-RELAY"]?.now;
  if (mode === "rule" && !name) {
    const rulesResponse = await fetch(base + "/rules", { signal: AbortSignal.timeout(5000) });
    const rules = rulesResponse.ok ? (await rulesResponse.json()).rules || [] : [];
    name = rules.find((rule) => rule.type === "Match")?.proxy;
  }
  if (!name && mode === "direct") name = "DIRECT";
  // Observe a real request through the mixed-port. Rule mode can route each
  // destination differently; a selector's default is not an actual route.
  let observed = null;
  const proxyUrl = getImageRelayProxyUrl();
  if (proxyUrl && (!runtimeProxyNodeInfo?.testedAt || Date.now() - runtimeProxyNodeInfo.testedAt > 30000 || testAll)) {
    let settled = false;
    const probe = fetch("https://www.gstatic.com/generate_204", {
      dispatcher: getImageRelayProxyAgent(proxyUrl),
      signal: AbortSignal.timeout(6000),
    }).then(async (response) => { await response.arrayBuffer(); }).catch(() => {}).finally(() => { settled = true; });
    do {
      const connectionsReply = await fetch(base + "/connections", { signal: AbortSignal.timeout(2000) });
      const active = connectionsReply.ok ? (await connectionsReply.json()).connections || [] : [];
      observed = active.find((connection) => connection.metadata?.host === "www.gstatic.com" && connection.metadata?.type === "HTTP" ) || active.find((connection) => connection.metadata?.host === "www.gstatic.com");
      if (observed) break;
      if (!settled) await new Promise((resolve) => setTimeout(resolve, 50));
    } while (!settled);
    await probe;
    const actual = observed?.chains?.find((chain) => proxies[chain] && !proxies[chain].all);
    if (actual) name = actual;
    else if (!name && mode === "rule") {
      const rulesReply = await fetch(base + "/rules", { signal: AbortSignal.timeout(2000) });
      const rules = rulesReply.ok ? (await rulesReply.json()).rules || [] : [];
      if (!rules.length) name = "DIRECT";
    }
  } else if (!name && runtimeProxyNodeInfo?.name) name = runtimeProxyNodeInfo.name;
  const visited = new Set();
  while (name && proxies[name]?.now && !visited.has(name)) {
    visited.add(name);
    name = proxies[name].now;
  }
  const nodes = Object.values(proxies).filter((item) => item?.name && !item.all && !/^(Direct|Reject|Pass|Compatible)/i.test(item.type));
  const selected = proxies[name];
  if (!name) {
    runtimeProxyNodeInfo = { name: "未确认实际节点", latencyMs: null, error: "测试请求未捕获到路由，请点击测试连接重试" };
  } else if (runtimeProxyNodeInfo?.name !== name || !runtimeProxyNodeInfo?.testedAt || Date.now() - runtimeProxyNodeInfo.testedAt > 30000 || testAll) {
    const info = { name, type: selected?.type, latencyMs: null, testedAt: Date.now(), testUrl: "https://www.gstatic.com/generate_204", routeSource: observed ? "connection" : "config", rule: observed?.rule || null };
    try {
      const delayReply = await fetch(base + "/proxies/" + encodeURIComponent(name) + "/delay?timeout=5000&url=" + encodeURIComponent(info.testUrl), { signal: AbortSignal.timeout(6500) });
      const delay = await delayReply.json();
      if (delayReply.ok && delay.delay > 0) info.latencyMs = delay.delay;
      else info.error = "测试超时或不可用";
    } catch { info.error = "测试超时或不可用"; }
    runtimeProxyNodeInfo = info;
  }
  if (testAll) {
    runtimeProxyDelayResults = [];
    const automaticGroup = proxies["WORKBENCH-IMAGE-RELAY"] || proxies["IMAGE-RELAY"];
    if (automaticGroup?.type === "URLTest") {
      // A group health check also invalidates the automatic selection cache.
      // Individual node tests alone can leave the previous node selected.
      const delayReply = await fetch(base + "/group/" + encodeURIComponent(automaticGroup.name) + "/delay?timeout=5000&url=" + encodeURIComponent("https://www.gstatic.com/generate_204"), { signal: AbortSignal.timeout(15000) });
      if (!delayReply.ok) throw new Error(`自动节点测速失败（HTTP ${delayReply.status}）`);
      const delays = await delayReply.json();
      runtimeProxyDelayResults = nodes.map((node) => ({ name: node.name, type: node.type, latencyMs: delays[node.name] > 0 ? delays[node.name] : null, error: delays[node.name] > 0 ? null : "超时或不可用" }));
      const groupReply = await fetch(base + "/group/" + encodeURIComponent(automaticGroup.name), { signal: AbortSignal.timeout(5000) });
      if (!groupReply.ok) throw new Error("无法确认测速后的自动选择节点");
      const currentName = (await groupReply.json()).now;
      const current = runtimeProxyDelayResults.find((item) => item.name === currentName);
      runtimeProxyNodeInfo = current
        ? { ...current, testedAt: Date.now(), testUrl: "https://www.gstatic.com/generate_204", routeSource: "config", rule: "Match" }
        : { name: currentName || "无可用节点", latencyMs: null, error: "无可用测速结果", testedAt: Date.now() };
      return;
    }
    let index = 0;
    const results = new Array(nodes.length);
    const worker = async () => {
      while (index < nodes.length) {
        const slot = index++;
        const node = nodes[slot];
        try {
          const response = await fetch(base + "/proxies/" + encodeURIComponent(node.name) + "/delay?timeout=5000&url=" + encodeURIComponent("https://www.gstatic.com/generate_204"), { signal: AbortSignal.timeout(6500) });
          const data = await response.json();
          results[slot] = { name: node.name, type: node.type, latencyMs: response.ok && data.delay > 0 ? data.delay : null, error: response.ok && data.delay > 0 ? null : "超时或不可用" };
        } catch { results[slot] = { name: node.name, type: node.type, latencyMs: null, error: "超时或不可用" }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, nodes.length) }, worker));
    runtimeProxyDelayResults = results;
    const current = results.find((item) => item.name === runtimeProxyNodeInfo?.name);
    if (current) runtimeProxyNodeInfo = { ...runtimeProxyNodeInfo, ...current, testedAt: Date.now() };
  }
}

async function handleLocalProxyDiagnostics(request, response) {
  if (!isLocalAppRequest(request)) {
    response.writeHead(403, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET", "cache-control": "no-store" });
    response.end();
    return;
  }
  const proxyUrl = getImageRelayProxyUrl();
  const testUrl = "https://www.google.com/";
  let reachable = false;
  let error = null;
  if (!proxyUrl) {
    error = "未配置可用的 HTTP 网络代理";
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const upstream = await fetch(testUrl, {
        method: "HEAD",
        cache: "no-store",
        dispatcher: getImageRelayProxyAgent(proxyUrl),
        signal: controller.signal,
      });
      await upstream.body?.cancel();
      if (!upstream.ok) throw new Error(`Google 访问测试返回 HTTP ${upstream.status}`);
      reachable = true;
    } catch (diagnosticError) {
      error = diagnosticError instanceof Error ? diagnosticError.message : "网络代理检测失败";
      // Codes distinguish incompatible dispatchers from network/TLS failures
      // without returning URLs or credential-bearing exception messages.
      if (diagnosticError?.cause?.code) error += ` (${diagnosticError.cause.code})`;
    } finally {
      clearTimeout(timer);
    }
  }
  const status = getLocalProxyStatus();
  const body = JSON.stringify({
    ...status,
    proxyServer: proxyUrl?.host || null,
    reachable,
    testUrl,
    error,
  });
  response.writeHead(error ? 502 : 200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function handleLocalProxyToggle(request, response) {
  if (!isLocalAppRequest(request)) {
    response.writeHead(403, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
    response.end();
    return;
  }
  let payload;
  try {
    payload = JSON.parse((await readRequestBody(request, 16 * 1024)).toString("utf8"));
  } catch {
    payload = {};
  }
  const enabled = payload?.enabled === true;
  try {
    if (typeof payload?.enabled !== "boolean") throw new Error("请提供有效的代理开关状态");
    const status = await mutateProxyState(async () => {
    if (payload?.relay === true) {
      imageRelayEnabled = enabled;
      return;
    }
    if (enabled) {
      if (!builtInImageProxy) {
        if (lastRuntimeImageProxySourceOverride || lastKnownGoodProxyConfig) {
          await startRuntimeBuiltInImageProxy(lastKnownGoodProxyConfig ? { kind: "text", value: lastKnownGoodProxyConfig } : lastRuntimeImageProxySourceOverride,
            lastRuntimeImageProxySourceKind, lastRuntimeImageProxySourceOverride);
        } else {
          const proxy = await startBuiltInImageProxy({ projectRoot, privateConfigFile: builtInProxyConfigFile, privateCacheRoot: privatePaths.proxyCore, onProxyReady: configureImageRelayProxyUrl });
          if (!proxy) throw new Error("请先在网络代理设置中上传配置或填写订阅地址");
          builtInImageProxy = proxy;
          lastKnownGoodProxyConfig = proxy.sourceText || null;
          runtimeImageProxySource = lastRuntimeImageProxySourceKind || "environment";
        }
      }
    } else {
      await stopBuiltInImageProxy();
    }
    });
    const body = JSON.stringify(status);
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "代理状态切换失败";
    runtimeImageProxyLastError = detail;
    const body = JSON.stringify({ error: detail, ...getLocalProxyStatus() });
    response.writeHead(400, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  }
}

async function handleLocalProxyConfig(request, response) {
  if (!isLocalAppRequest(request)) {
    response.writeHead(403, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method === "GET") {
    const body = JSON.stringify(getLocalProxyStatus());
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" });
    response.end();
    return;
  }

  let payload;
  try {
    const body = await readRequestBody(request, 12 * 1024 * 1024);
    payload = JSON.parse(body.toString("utf8"));
  } catch (error) {
    // JSON parser messages can contain excerpts of credential-bearing input.
    const message = "配置内容无效或超过大小限制，请检查后重试";
    const body = JSON.stringify({ error: message });
    response.writeHead(400, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }

  const configText = typeof payload?.configText === "string" ? payload.configText : "";
  const subscriptionUrl = typeof payload?.subscriptionUrl === "string" ? payload.subscriptionUrl.trim() : "";
  const sourceOverride = configText.trim()
    ? { kind: "text", value: configText }
    : subscriptionUrl
      ? { kind: "url", value: subscriptionUrl }
      : null;
  if (!sourceOverride) {
    const body = JSON.stringify({ error: "请上传代理配置文件或填写订阅地址" });
    response.writeHead(400, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }

  try {
    const status = await mutateProxyState(async () => {
      await startRuntimeBuiltInImageProxy(sourceOverride, sourceOverride.kind === "text" ? "uploaded" : "subscription");
      runtimeProxyConfigName = configText.trim() ? String(payload.fileName || "上传的代理配置.yaml").slice(0, 200) : "远端订阅配置";
    });
    const body = JSON.stringify(status);
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "代理启动失败";
    runtimeImageProxyLastError = detail;
    // Do not echo subscription URLs, node credentials, or Mihomo command lines.
    const body = JSON.stringify({ error: `代理启动失败：${detail}` });
    response.writeHead(400, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  }
}

let builtInImageProxy;

async function stopBuiltInImageProxy() {
  if (builtInImageProxy) await builtInImageProxy.stop();
  builtInImageProxy = null;
  runtimeImageProxySource = null;
  await closeImageRelayProxyAgents();
}

async function startRuntimeBuiltInImageProxy(sourceOverride, sourceKind, originalSource = sourceOverride) {
  if (proxyStateReadFailed) throw new Error("私人代理状态损坏，未更改代理，请先备份后修复");
  await stopBuiltInImageProxy();
  runtimeImageProxyLastError = "";
  const proxy = await startBuiltInImageProxy({
    projectRoot,
    privateConfigFile: builtInProxyConfigFile,
    privateCacheRoot: privatePaths.proxyCore,
    sourceOverride,
    onProxyReady: (proxyUrl) => {
      imageRelayProxySetting = proxyUrl;
    },
  });
  if (!proxy) throw new Error("没有找到代理配置内容");
  builtInImageProxy = proxy;
  runtimeImageProxySource = sourceKind || "environment";
  lastRuntimeImageProxySourceOverride = originalSource || null;
  lastKnownGoodProxyConfig = proxy.sourceText || null;
  lastRuntimeImageProxySourceKind = sourceKind || "environment";
  return proxy;
}

async function activityRequest(category, response, operation) {
  let release;
  try { release = activityGate.acquire(category); }
  catch {
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "5" });
    response.end(JSON.stringify({ error: "工作台正在等待安全更新，请稍后重试" }));
    return;
  }
  // Keep the lease until upstream work settles, not merely until socket close.
  try { return await operation(); }
  finally { release(); }
}

const backendControl = createBackendControl({ gate: activityGate, ledger: updateTaskLedger, ready: updateTaskLedgerReady,
  instance: applicationInstanceId, version: applicationVersion, writes: privateWriteStatus, flushWrites: flushPrivateWrites,
  backgroundBusy: () => Boolean(softwareUpdates.inFlight || softwareUpdates.staging || softwareUpdates.downloader?.pending),
  pauseBackground: () => softwareUpdates.stop(),
  resumeBackground: () => { if (!updateStartup.quarantined()) softwareUpdates.start(); } });
const updateStartup = createUpdateStartup({ onActivate: () => softwareUpdates.start(), backendControl, instance: applicationInstanceId });
const server = createServer(async (request, response) => {
  const method = request.method || "GET";
  // One canonical Origin shares browser storage and Keychain proxy bindings.
  if (request.headers.host === `localhost:${port}` && (method === "GET" || method === "HEAD")) {
    const target = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (target.origin !== `http://127.0.0.1:${port}`) { response.writeHead(400); response.end(); return; }
    response.writeHead(307, { location: target.href, "cache-control": "no-store" }); response.end(); return;
  }
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname.replace(/\/$/, "") || "/";
  if (pathname === "/local-app/port-migration" && (method === "GET" || method === "HEAD")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    response.end(method === "HEAD" ? undefined : portMigrationPage); return;
  }
  if (updateStartup.reject(request, response, pathname)) return;
  if (await updateTaskHttp(request, response)) return;
  if (await credentialHttp(request, response)) return;
  if (await updateHttp(request, response)) return;
  if (pathname === "/local-app/activity/report") {
    // Require exact browser Origin for writes; no CORS or command capability.
    if (!isLocalAppRequest(request) || request.headers.origin !== `http://${request.headers.host}`) { response.writeHead(403); response.end(); return; }
    if (method !== "POST") { response.writeHead(405, { allow: "POST" }); response.end(); return; }
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") { response.writeHead(415); response.end(); return; }
    try {
      browserActivityReports.accept(JSON.parse((await readRequestBody(request, 2048)).toString("utf8")));
      response.writeHead(204, { "cache-control": "no-store" }); response.end();
    } catch {
      if (!response.destroyed) { response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ error: "Invalid activity observation" })); }
    }
    return;
  }
  if (pathname === "/local-app/activity") {
    if (!isLocalAppRequest(request)) { response.writeHead(403); response.end(); return; }
    if (method !== "GET") { response.writeHead(405, { allow: "GET" }); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ...activityGate.status(), observedBrowser: browserActivityReports.status() }));
    return;
  }
  if (pathname === "/local-app/health") {
    if (method !== "GET" || !isLocalAppRequest(request)) { response.writeHead(403); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ app: "guan-ai-workbench", version: applicationVersion, buildId: applicationBuildId,
      instanceId: applicationInstanceId, pid: process.pid, ready: !shutdownStarted, maintenance: updateStartup.quarantined(), origin: `http://127.0.0.1:${port}`, dataLayout: 1,
      taskEvidenceProtocol: updateTaskLedgerReady ? 1 : 0,
      backendControlProtocol: 1,
      proxy: { running: Boolean(builtInImageProxy), stateReadable: !proxyStateReadFailed } }));
    return;
  }
  if (pathname === "/local-proxy/toggle") {
    return activityRequest("proxy", response, () => handleLocalProxyToggle(request, response));
  }
  if (pathname === "/local-proxy/channel-transports") {
    if (method !== "GET" || !isLocalAppRequest(request)) {
      response.writeHead(403); response.end(); return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(Object.fromEntries(imageRelayTransportPreferences)));
    return;
  }
  if (pathname === "/local-proxy/diagnostics") {
    return activityRequest("proxy", response, () => handleLocalProxyDiagnostics(request, response));
  }
  if (pathname === "/local-proxy/nodes" || pathname === "/local-proxy/test-all") {
    if (!isLocalAppRequest(request) || method !== (pathname.endsWith("test-all") ? "POST" : "GET")) { response.writeHead(403); response.end(); return; }
    try {
      await activityRequest("proxy", response, () => inspectProxyNodes(pathname.endsWith("test-all")));
      if (response.writableEnded) return;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(getLocalProxyStatus()));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ...getLocalProxyStatus(), error: error.message }));
    }
    return;
  }
  if (pathname === "/local-proxy/status" || pathname === "/local-proxy/config") {
    return method === "POST" ? activityRequest("proxy", response, () => handleLocalProxyConfig(request, response)) : handleLocalProxyConfig(request, response);
  }
  if (pathname.startsWith("/local-image-api/")) {
    if (!["GET", "POST"].includes(method)) {
      response.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" });
      response.end();
      return;
    }
    return activityRequest("relay", response, () => relayImageApi(request, response, pathname));
  }
  if (!["GET", "HEAD"].includes(method)) {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  if (pathname.startsWith("/data-contract/")) {
    const file = safeFile(join(projectRoot, "src", "shared", "data-contract"), pathname.slice("/data-contract/".length));
    if (file && await existingFile(file)) return send(response, file, method);
    return notFound(response);
  }

  // The canvas source is bundled from the reference infinite-canvas project.
  // Keep its SPA routes and absolute Vite asset paths working from this app.
  if (pathname === "/canvas" || pathname.startsWith("/canvas/")) {
    // The standalone canvas library is not part of the workbench workflow.
    // Embedded product canvases use /canvas/:productId and continue to load;
    // opening the library root returns to the workbench instead of exposing
    // the unrelated source application's canvas list.
    if (pathname === "/canvas") {
      response.writeHead(302, { location: "/", "cache-control": "no-store" });
      response.end();
      return;
    }
    if (pathname === "/canvas/excel-prompts-bridge.js") {
      const bridge = safeFile(infiniteCanvasRoot, "excel-prompts-bridge.js");
      if (bridge && await existingFile(bridge)) return send(response, bridge, method);
    }
    if (pathname.startsWith("/canvas/assets/") || pathname.startsWith("/canvas/icons/") || pathname.startsWith("/canvas/plugins/")) {
      const relative = pathname.slice("/canvas/".length);
      const file = safeFile(infiniteCanvasRoot, relative);
      if (file && await existingFile(file)) {
        if (relative.endsWith(".css")) {
          const source = await readFile(file, "utf8");
          const patched = `${source}\n.absolute.bottom-24.right-6{left:auto!important;right:1.5rem!important}`;
          response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
          return method === "HEAD" ? response.end() : response.end(patched);
        }
        return send(response, file, method);
      }
    }
    const canvasIndex = safeFile(infiniteCanvasRoot, "index.html");
    if (canvasIndex && await existingFile(canvasIndex)) {
      if (method === "HEAD") return send(response, canvasIndex, method);
      const source = await readFile(canvasIndex, "utf8");
      const patched = source.includes("</head>") ? source.replace("</head>", `${localCanvasImageRelayScript}${localCanvasSettingsBridgeScript}${localCanvasSettingsEntryBootstrapScript}</head>`) : source;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(patched);
      return;
    }
    return notFound(response);
  }
  if (pathname === "/logo.svg" || pathname.startsWith("/assets/") || pathname.startsWith("/icons/") || pathname.startsWith("/plugins/")) {
    const file = safeFile(infiniteCanvasRoot, pathname.slice(1));
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

let shutdownStarted = false;
const shutdown = async (exitCode = 0) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  softwareUpdates.stop();
  await proxyMutationQueue.catch(() => undefined);
  await flushPrivateWrites().catch(() => console.error("私人运行状态未完成保存，已保留原文件"));
  await stopAllProxyProcesses();
  await stopBuiltInImageProxy();
  server.close(() => process.exit(exitCode));
  server.closeAllConnections();
  setTimeout(() => process.exit(exitCode), 2000).unref();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void shutdown());
process.once("uncaughtException", () => {
  console.error("服务异常退出，正在清理内置代理");
  void shutdown(1);
});

try {
  if (proxyStateReadFailed) throw new Error("Private proxy state unavailable");
  builtInImageProxy = savedProxyState?.enabled === false ? null : await startBuiltInImageProxy({
    projectRoot,
    sourceOverride: lastKnownGoodProxyConfig ? { kind: "text", value: lastKnownGoodProxyConfig } : lastRuntimeImageProxySourceOverride,
    privateConfigFile: builtInProxyConfigFile,
    privateCacheRoot: privatePaths.proxyCore,
    onProxyReady: configureImageRelayProxyUrl,
  });
  if (builtInImageProxy) {
    lastKnownGoodProxyConfig = builtInImageProxy.sourceText || lastKnownGoodProxyConfig;
    runtimeImageProxySource = lastRuntimeImageProxySourceKind || "environment";
    console.log("Guan 图片代理已内置启动（直连优先，失败后使用本地代理）");
  }
} catch (error) {
  // The detail page remains usable without a sidecar. A missing binary or
  // malformed private subscription is reported without echoing its contents.
  runtimeImageProxyLastError ||= "代理启动失败";
  console.warn("Guan 图片代理未启动，请检查 Mihomo 二进制和私有订阅配置");
}

server.listen(port, "127.0.0.1", () => {
  if (!updateStartup.quarantined()) softwareUpdates.start();
  console.log("Guan AI 生图工作台运行在 http://127.0.0.1:" + port);
});
