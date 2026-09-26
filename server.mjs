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
    position: fixed !important;
    left: 76px !important;
    bottom: 18px !important;
    z-index: 40 !important;
    margin: 0 !important;
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
      response.end(refreshedFavicon.replace("</head>", `${workbenchLogoStyle}${mvpNavigationStyle}${localThemeAndUiStyle}${localDocumentTitleScript}${localRootNavigationScript}${localSettingsPanelScript}${originalPlaygroundSettingsButtonScript}${localThemeToggleScript}${localFixedFieldsScript}${localResolutionButtonsScript}${localAspectRatioButtonsScript}${localOfflineGuardsScript}${localResponsivePreviewScript}<link rel="stylesheet" href="/playground-settings/assets/index.css?v=settings-toggle-backdrop-fix-20260926-v2"><script type="module" src="/playground-settings/assets/index.js?v=settings-toggle-backdrop-fix-20260926-v2"></script><script src="/_pixpix-assets/local-vendor/xlsx.full.min.js?sheetjs-local-0.18.5"></script><script type="module" src="/data-contract/index.js?contract-v21-20260926"></script></head>`));
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
  if (pathname.startsWith("/data-contract/")) {
    const file = safeFile(join(projectRoot, "data-contract"), pathname.slice("/data-contract/".length));
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
