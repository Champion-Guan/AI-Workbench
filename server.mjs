import { createReadStream, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent } from "undici";
import { startBuiltInImageProxy } from "./proxy-service.mjs";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));

function loadLocalEnvFile(path) {
  try {
    const source = readFileSync(path, "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z\d_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[1] in process.env) continue;
      let value = match[2];
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {
    // .env.local is optional and intentionally ignored by Git.
  }
}

loadLocalEnvFile(join(projectRoot, ".env.local"));
const archiveRoot = join(projectRoot, "archive");
const pageFile = join(archiveRoot, "index.html");
const assetRoot = join(archiveRoot, "assets");
const infiniteCanvasRoot = join(archiveRoot, "infinite-canvas");
const port = Number(process.env.PORT || 5174);
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
    const isExcelUploaded = () => {
      const picker = document.querySelector('[role="dialog"] button[aria-label="选择已上传的 Excel 文件"]');
      return Boolean(picker && picker.textContent && !/暂无已上传 Excel|暂无已上传Excel/i.test(picker.textContent));
    };

    const syncEmptyWorkspaceChrome = () => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      const hasExcel = isExcelUploaded();
      const toggle = dialog.querySelector('.local-settings-toggle');
      if (toggle) toggle.hidden = !hasExcel;
      for (const button of document.querySelectorAll('button')) {
        if (button.textContent?.trim() === '数据') button.hidden = true;
      }
      let hint = dialog.querySelector('.local-upload-step-hint');
      if (!hasExcel) {
        if (!hint) {
          hint = document.createElement('div');
          hint.className = 'local-upload-step-hint';
          hint.setAttribute('role', 'status');
          hint.textContent = '第一步：先上传你的 Excel 文件';
          dialog.append(hint);
        }
        hint.hidden = false;
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
    top: 104px !important;
    right: 76px !important;
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
  .local-upload-step-hint[hidden],
  .local-settings-toggle[hidden] {
    display: none !important;
  }
  /*
   * The settings app is mounted inside the archived dialog. Keep its
   * top-level overlay above the Excel controls and make the modal backdrop
   * visibly blur the workbench behind it.
   */
  #playground-settings-root > [class*="fixed"][class*="inset-0"] {
    z-index: 70 !important;
  }
  #playground-settings-root > [class*="fixed"][class*="inset-0"] > [class*="absolute"][class*="inset-0"] {
    background: rgba(0, 0, 0, .22) !important;
    -webkit-backdrop-filter: blur(12px) !important;
    backdrop-filter: blur(12px) !important;
  }
  html.dark #playground-settings-root > [class*="fixed"][class*="inset-0"] > [class*="absolute"][class*="inset-0"] {
    background: rgba(0, 0, 0, .42) !important;
  }
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
  @media (max-width: 799px) {
    .local-settings-toggle {
      display: none !important;
    }
  }
</style>`;

const localProxySetupScript = `<script id="local-proxy-setup-script">
  (() => {
    const SESSION_KEY = "guan-workbench:proxy-setup-dismissed";
    let modal = null;

    const addStyles = () => {
      if (document.getElementById("local-proxy-setup-style")) return;
      const style = document.createElement("style");
      style.id = "local-proxy-setup-style";
      style.textContent = [
        ".local-proxy-setup{position:fixed;inset:0;z-index:3200;display:grid;place-items:center;padding:20px;background:rgba(15,17,22,.32);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
        ".local-proxy-setup-card{width:min(520px,calc(100vw - 32px));border:1px solid rgba(0,0,0,.08);border-radius:24px;background:#fff;color:#17181a;box-shadow:0 30px 100px rgba(0,0,0,.24);padding:26px}",
        ".local-proxy-setup-card h2{margin:0 0 8px;font-size:22px;line-height:1.3}.local-proxy-setup-card p{margin:0;color:#686d76;font-size:13px;line-height:1.6}",
        ".local-proxy-setup-field{display:grid;gap:7px;margin-top:18px}.local-proxy-setup-field label{font-size:13px;font-weight:650}.local-proxy-setup-field input{width:100%;box-sizing:border-box;border:1px solid #d9dce2;border-radius:12px;padding:11px 12px;font:13px inherit;outline:none;background:#fff}.local-proxy-setup-field input:focus{border-color:#3478f6;box-shadow:0 0 0 3px rgba(52,120,246,.14)}",
        ".local-proxy-setup-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:22px}.local-proxy-setup-actions button{border:1px solid #d9dce2;border-radius:12px;padding:10px 15px;background:#fff;color:#24262a;font:13px inherit;cursor:pointer}.local-proxy-setup-actions button.primary{border-color:#111;background:#111;color:#fff}.local-proxy-setup-actions button:disabled{cursor:wait;opacity:.55}",
        ".local-proxy-setup-error{min-height:20px;margin-top:12px;color:#c53030;font-size:12px;line-height:1.5}.local-proxy-setup-hint{margin-top:15px!important;font-size:12px!important;color:#8a9099!important}",
        "html[data-workbench-theme='dark'] .local-proxy-setup-card{border-color:rgba(255,255,255,.1);background:#1e2024;color:#f4f4f5}html[data-workbench-theme='dark'] .local-proxy-setup-field input,html[data-workbench-theme='dark'] .local-proxy-setup-actions button{border-color:rgba(255,255,255,.14);background:#26292e;color:#f4f4f5}",
      ].join("");
      document.head.append(style);
    };

    const close = () => { modal?.remove(); modal = null; };
    const open = (status) => {
      if (modal) return;
      addStyles();
      modal = document.createElement("div");
      modal.className = "local-proxy-setup";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.innerHTML = '<section class="local-proxy-setup-card"><h2>设置网络代理</h2><p>本项目会先尝试直连。若服务商无法直连，再使用这里配置的临时代理节点。代理配置只在本次服务运行期间使用，关闭服务后自动清除。</p><div class="local-proxy-setup-field"><label>上传 Mihomo / Clash 配置文件</label><input data-proxy-file type="file" accept=".yaml,.yml,.txt,text/plain,application/yaml" /></div><div class="local-proxy-setup-field"><label>或填写远端订阅地址</label><input data-proxy-url type="url" placeholder="https://example.com/your-subscription" autocomplete="off" /></div><p class="local-proxy-setup-hint">没有代理也可以先跳过，直连仍然可用。首次配置成功后不会再次提示。</p><div class="local-proxy-setup-error" role="alert"></div><div class="local-proxy-setup-actions"><button type="button" data-proxy-skip>稍后配置</button><button type="button" class="primary" data-proxy-save>保存并启动代理</button></div></section>';
      document.body.append(modal);
      const error = modal.querySelector('.local-proxy-setup-error');
      const fileInput = modal.querySelector('[data-proxy-file]');
      const urlInput = modal.querySelector('[data-proxy-url]');
      const save = modal.querySelector('[data-proxy-save]');
      modal.querySelector('[data-proxy-skip]')?.addEventListener('click', () => {
        try { sessionStorage.setItem(SESSION_KEY, 'true'); } catch {}
        close();
      });
      save?.addEventListener('click', async () => {
        if (!(save instanceof HTMLButtonElement)) return;
        save.disabled = true;
        if (error) error.textContent = '';
        try {
          const file = fileInput instanceof HTMLInputElement ? fileInput.files?.[0] : null;
          const subscriptionUrl = urlInput instanceof HTMLInputElement ? urlInput.value.trim() : '';
          const configText = file ? await file.text() : '';
          if (!configText.trim() && !subscriptionUrl) throw new Error('请先选择配置文件或填写订阅地址');
          const response = await fetch('/local-proxy/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ configText, subscriptionUrl }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || '代理启动失败');
          try { sessionStorage.setItem(SESSION_KEY, 'true'); } catch {}
          close();
        } catch (requestError) {
          if (error) error.textContent = requestError instanceof Error ? requestError.message : String(requestError);
          save.disabled = false;
        }
      });
      modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
      modal.querySelector('[data-proxy-file]')?.focus();
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
// Transport preference is deliberately kept in memory. It learns only from
// successful requests during this service run, so no provider credentials or
// private proxy details are written to the repository or browser storage.
const imageRelayTransportPreferences = new Map();
let runtimeImageProxySource = null;
let runtimeImageProxyLastError = "";

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

function setImageRelayTransportPreference(provider, transport) {
  if (transport === "proxy" || transport === "direct") {
    imageRelayTransportPreferences.set(provider, transport);
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
  response.writeHead(200, {
    "content-type": contentTypes[extname(path).toLowerCase()] || "application/octet-stream",
    "cache-control": isHtml ? "no-store" : "public, max-age=31536000, immutable",
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
      response.end(refreshedFavicon.replace("</head>", `${workbenchLogoStyle}${mvpNavigationStyle}${localThemeAndUiStyle}${localDocumentTitleScript}${localRootNavigationScript}${localSettingsPanelScript}${originalPlaygroundSettingsButtonScript}${localThemeToggleScript}${localFixedFieldsScript}${localResolutionButtonsScript}${localAspectRatioButtonsScript}${localOfflineGuardsScript}${localGenerationButtonScript}${localResponsivePreviewScript}${localProxySetupScript}<link rel="stylesheet" href="/playground-settings/assets/index.css?v=background-removal-timeout-20260928-v2"><script type="module" src="/playground-settings/assets/index.js?v=background-removal-timeout-20260928-v2"></script><script src="/_pixpix-assets/local-vendor/xlsx.full.min.js?sheetjs-local-0.18.5"></script><script src="/_pixpix-assets/local-vendor/fflate.umd.js?fflate-local-0.8.3"></script><script type="module" src="/data-contract/index.js?contract-v35-20260927"></script><link rel="stylesheet" href="/_pixpix-assets/local-canvas/canvas.css?canvas-v16"><script src="/_pixpix-assets/local-canvas/canvas.js?canvas-v16"></script></head>`));
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
  return upstream.status === 403 || upstream.status === 407;
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
  const preferredTransport = getImageRelayTransportPreference(provider);
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
    setImageRelayTransportPreference(provider, transport);
    // Image edits are consumed as one complete JSON response by the browser.
    // Buffering this endpoint in the local relay prevents a large Base64 body
    // from being cut off while a proxy connection is being switched or closed.
    let payload = body;
    if (payload === null && endpoint === "images/edits") {
      try {
        payload = Buffer.from(await upstream.arrayBuffer());
      } catch (error) {
        responseBodyError = error;
        throw error;
      }
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
      if (proxyResponse && !shouldRetryImageRelayThroughProxy(provider, proxyResponse)) {
        await sendUpstream(proxyResponse, "proxy");
        return;
      }
      if (proxyResponse) proxyBody = Buffer.from(await proxyResponse.arrayBuffer());
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
        message: `图片请求未收到完整结果（${directState}，${proxyState}，${bodyState}）；上游可能已生成并扣费。将按失败处理并自动切换下一站。`,
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
  const configured = Boolean(builtInImageProxy || runtimeImageProxySource || envConfigured || explicitConfigured);
  return {
    configured,
    running: Boolean(builtInImageProxy),
    firstRun: !configured,
    source: runtimeImageProxySource || (builtInImageProxy ? "environment" : explicitConfigured ? "proxy-url" : envConfigured ? "environment" : null),
    proxyAvailable: Boolean(getImageRelayProxyUrl()),
    lastError: runtimeImageProxyLastError || null,
  };
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
    const message = error instanceof Error ? error.message : "配置内容无效";
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
    await startRuntimeBuiltInImageProxy(sourceOverride, sourceOverride.kind === "text" ? "uploaded" : "subscription");
    const body = JSON.stringify(getLocalProxyStatus());
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    runtimeImageProxyLastError = "代理启动失败";
    // Do not echo subscription URLs, node credentials, or Mihomo command lines.
    const body = JSON.stringify({ error: "代理启动失败，请检查配置格式、节点可用性和 Mihomo 运行环境" });
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

async function startRuntimeBuiltInImageProxy(sourceOverride, sourceKind) {
  await stopBuiltInImageProxy();
  runtimeImageProxyLastError = "";
  const proxy = await startBuiltInImageProxy({
    projectRoot,
    sourceOverride,
    onProxyReady: (proxyUrl) => {
      imageRelayProxySetting = proxyUrl;
    },
  });
  if (!proxy) throw new Error("没有找到代理配置内容");
  builtInImageProxy = proxy;
  runtimeImageProxySource = sourceKind || "environment";
  return proxy;
}

const server = createServer(async (request, response) => {
  const method = request.method || "GET";
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname.replace(/\/$/, "") || "/";
  if (pathname === "/local-proxy/status" || pathname === "/local-proxy/config") {
    return handleLocalProxyConfig(request, response);
  }
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
  if (pathname.startsWith("/data-contract/")) {
    const file = safeFile(join(projectRoot, "data-contract"), pathname.slice("/data-contract/".length));
    if (file && await existingFile(file)) return send(response, file, method);
    return notFound(response);
  }

  // The canvas source is bundled from the reference infinite-canvas project.
  // Keep its SPA routes and absolute Vite asset paths working from this app.
  if (pathname === "/canvas" || pathname.startsWith("/canvas/")) {
    if (pathname.startsWith("/canvas/assets/") || pathname.startsWith("/canvas/icons/") || pathname.startsWith("/canvas/plugins/")) {
      const relative = pathname.slice("/canvas/".length);
      const file = safeFile(infiniteCanvasRoot, relative);
      if (file && await existingFile(file)) return send(response, file, method);
    }
    const canvasIndex = safeFile(infiniteCanvasRoot, "index.html");
    if (canvasIndex && await existingFile(canvasIndex)) return send(response, canvasIndex, method);
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

const shutdown = async () => {
  await stopBuiltInImageProxy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  builtInImageProxy = await startBuiltInImageProxy({
    projectRoot,
    onProxyReady: configureImageRelayProxyUrl,
  });
  if (builtInImageProxy) {
    runtimeImageProxySource = "environment";
    console.log("Guan 图片代理已内置启动（直连优先，失败后使用本地代理）");
  }
} catch (error) {
  // The detail page remains usable without a sidecar. A missing binary or
  // malformed private subscription is reported without echoing its contents.
  runtimeImageProxyLastError = "代理启动失败";
  console.warn("Guan 图片代理未启动，请检查 Mihomo 二进制和私有订阅配置");
}

server.listen(port, "127.0.0.1", () => {
  console.log("Guan A+ 详情页工作台运行在 http://127.0.0.1:" + port);
});
