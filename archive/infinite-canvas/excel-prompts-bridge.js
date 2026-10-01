(() => {
  "use strict";

  // The canvas is served from the same origin as the workbench, so it can
  // prepare the native prompt-source store before the React app hydrates.
  // This keeps the source app's search, expand, details and insert actions
  // intact while replacing its built-in remote prompt registry with the
  // prompts recognized from the active Excel workbook.
  const STORE_KEY = "infinite-canvas:prompt_source_store_v2";
  const SOURCE_ID = "guan-excel-prompts";
  const SOURCE_CACHE_VERSION = "v2";
  const BUILT_IN_SOURCES = [
    ["banana-prompt-quicker", "Banana Prompt Quicker", "https://glidea.github.io/banana-prompt-quicker/", "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/banana-prompt-quicker.json"],
    ["davidwu-gpt-image2-prompts", "DavidWu GPT Image 2", "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts", "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/davidwu-gpt-image2-prompts.json"],
    ["freestylefly-gpt-image-2", "Freestylefly GPT Image 2", "https://github.com/freestylefly/awesome-gpt-image-2", "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/freestylefly-gpt-image-2.json"],
    ["awesome-gpt-image", "Awesome GPT Image", "https://github.com/ZeroLu/awesome-gpt-image", "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/awesome-gpt-image.json"],
    ["awesome-gpt4o-image-prompts", "Awesome GPT-4o", "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts", "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/awesome-gpt4o-image-prompts.json"],
    ["youmind-gpt-image-2", "YouMind GPT Image 2", "https://github.com/YouMind-OpenLab/awesome-gpt-image-2", "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/youmind-gpt-image-2.json"],
    ["youmind-nano-banana-pro", "YouMind Nano Banana Pro", "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts", "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/youmind-nano-banana-pro.json"],
  ];

  const clean = (value) => String(value == null ? "" : value).trim();

  const parentContractState = () => {
    try {
      const host = window.parent && window.parent !== window ? window.parent : window;
      return host.GuanWorkbenchData?.getState?.() || null;
    } catch {
      return null;
    }
  };

  const productName = (route, index) => {
    const value = clean(route).split(/[|｜]/, 1)[0].trim();
    return value || `提示词产品 ${index + 1}`;
  };

  const promptLabel = (key) => {
    const value = clean(key);
    if (value === "Main Prompt") return "主图提示词";
    if (value === "Video Prompt") return "视频提示词";
    const detail = value.match(/^Detail Prompt (\d+)$/i);
    if (detail) return `详情页提示词${detail[1].padStart(2, "0")}`;
    const rich = value.match(/^Rich Prompt (\d+)$/i);
    if (rich) return `富内容提示词${rich[1].padStart(2, "0")}`;
    return value || "Excel 提示词";
  };

  const readTemplates = (state) => {
    if (!state) return { fileName: "", templates: [] };
    const activeSetId = state.workspace?.activeProductSetId || state.productSets?.[0]?.id || "";
    const activeSet = state.productSets?.find((item) => item.id === activeSetId)
      || state.productSets?.[state.productSets.length - 1]
      || null;
    const source = activeSet?.source || {};
    const templates = Array.isArray(source.promptTemplates) ? source.promptTemplates : [];
    // The host opens one native canvas per Excel product and passes the
    // product name in the iframe query string. Keep the prompt source scoped
    // to that canvas so the prompt library never mixes products together.
    let activeProductName = "";
    try {
      activeProductName = clean(new URLSearchParams(window.location.search).get("productTitle"));
    } catch {
      activeProductName = "";
    }
    if (!activeProductName) {
      const activeProductId = state.workspace?.activeProductId;
      const activeProduct = state.products?.find((product) => product.id === activeProductId);
      activeProductName = productName(activeProduct?.identity?.titleZh || activeProduct?.identity?.sku, 0);
    }
    const scopedTemplates = activeProductName
      ? templates.filter((template) => productName(template?.route, 0) === activeProductName)
      : templates;
    return { fileName: clean(source.fileName), templates: scopedTemplates, activeProductName };
  };

  const makeItems = (templates) => templates.flatMap((template, templateIndex) => {
    const name = productName(template?.route, templateIndex);
    const prompts = template?.prompts && typeof template.prompts === "object" ? template.prompts : {};
    return Object.entries(prompts)
      .map(([key, value], promptIndex) => ({ key, value: clean(value), promptIndex }))
      .filter(({ value }) => value)
      .map(({ key, value, promptIndex }) => ({
        id: `${SOURCE_ID}-${template?.id || templateIndex + 1}-${promptIndex + 1}`,
        title: `${name} · ${promptLabel(key)}`,
        prompt: value,
        description: `来自 Excel · ${name}`,
        coverUrl: "",
        referenceImageUrls: [],
        tags: ["Excel", name, clean(key)].filter(Boolean),
        preview: value.slice(0, 160),
        createdAt: clean(template?.createdAt),
        updatedAt: clean(template?.updatedAt),
        sourceUrl: "",
      }));
  });

  const hash = (value) => {
    let result = 0;
    for (let index = 0; index < value.length; index += 1) result = ((result << 5) - result + value.charCodeAt(index)) | 0;
    return Math.abs(result).toString(36);
  };

  const installCanvasHeaderCleanup = () => {
    const style = document.createElement("style");
    style.textContent = ".guan-hidden-canvas-header-item{display:none!important}";
    (document.head || document.documentElement).append(style);
    const hide = () => {
      document.querySelectorAll("button, a").forEach((element) => {
        const label = clean(element.getAttribute("aria-label") || element.textContent);
        const hideItem = label === "节点插件" || label === "文档" || label === "切换到 English" || label === "切换到中文" || label === "GitHub" || label === "切换到浅色主题" || label === "切换到深色主题" || /^\d+\.\d+\.\d+$/.test(label);
        if (hideItem && !element.classList.contains("guan-hidden-canvas-header-item")) {
          element.classList.add("guan-hidden-canvas-header-item");
        }
      });
    };
    const start = () => {
      hide();
      new MutationObserver(hide).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  };

  const installFitAllButtonLabel = () => {
    const update = () => {
      document.querySelectorAll('button[aria-label="重置视图"]').forEach((button) => {
        button.setAttribute("aria-label", "定位全部内容");
        button.setAttribute("title", "定位全部内容");
      });
    };
    update();
    new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true });
  };

  const syncCanvasTheme = (theme) => {
    const nextTheme = theme === "dark" ? "dark" : "light";
    const targetLabel = nextTheme === "dark" ? "切换到深色主题" : "切换到浅色主题";
    const button = [...document.querySelectorAll("button")].find((candidate) => {
      return clean(candidate.getAttribute("aria-label")) === targetLabel;
    });
    if (button) {
      button.click();
      return;
    }
    try {
      const key = "infinite-canvas:theme_store";
      const current = JSON.parse(localStorage.getItem(key) || "{}");
      localStorage.setItem(key, JSON.stringify({ ...current, state: { ...(current.state || {}), theme: nextTheme } }));
    } catch {}
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    document.documentElement.style.colorScheme = nextTheme;
  };

  window.addEventListener("message", (event) => {
    if (event.data?.type === "guan-theme-sync") syncCanvasTheme(event.data.theme);
  });

  const installPromptMenuEnhancement = () => {
    const enhance = () => {
      const sourceButtons = [...document.querySelectorAll("button")].filter((button) => clean(button.textContent).startsWith("Excel 提示词"));
      sourceButtons.forEach((sourceButton) => {
        const sourceGroup = sourceButton.parentElement;
        if (!sourceGroup) return;
        const content = [...sourceGroup.children].find((child) => child !== sourceButton && child.querySelector?.("button"));
        if (!content) return;
        const insertButtons = [...content.querySelectorAll("button")].filter((button) => {
          const label = `${clean(button.textContent)} ${clean(button.getAttribute("aria-label"))} ${clean(button.title)}`;
          return label.includes("插入画布");
        });
        if (!insertButtons.length) return;
        const rows = [...new Set(insertButtons.map((button) => button.closest(".group") || button.parentElement?.parentElement).filter(Boolean))];
        if (!rows.length) return;
        const firstTitle = clean(rows[0].querySelector("button")?.textContent);
        const existingProductButton = content.querySelector(".guan-excel-product-menu");
        const productName = existingProductButton
          ? clean(existingProductButton.textContent).replace(/^›\s*/, "")
          : (firstTitle.split(" · ", 1)[0] || "当前产品");
        const productButton = existingProductButton || document.createElement("button");
        const rowContainer = rows[0].parentElement;
        if (!rowContainer) return;
        let chevron = productButton.querySelector("span");
        if (!existingProductButton) {
          productButton.type = "button";
          productButton.className = "guan-excel-product-menu";
          productButton.textContent = productName;
          productButton.setAttribute("aria-expanded", "true");
          productButton.style.cssText = "display:flex;align-items:center;width:100%;gap:6px;padding:6px 8px 6px 20px;margin:2px 0;border:0;border-radius:6px;background:transparent;color:inherit;font-size:12px;font-weight:600;text-align:left;cursor:pointer;opacity:.82";
          chevron = document.createElement("span");
          chevron.textContent = "›";
          chevron.style.cssText = "display:inline-block;width:12px;font-size:16px;line-height:12px;transform:rotate(90deg);transition:transform .15s ease";
          productButton.prepend(chevron);
          productButton.addEventListener("click", () => {
            const expanded = productButton.getAttribute("aria-expanded") === "true";
            productButton.setAttribute("aria-expanded", String(!expanded));
            rowContainer.style.display = expanded ? "none" : "";
            chevron.style.transform = expanded ? "rotate(0deg)" : "rotate(90deg)";
          });
          content.insertBefore(productButton, rowContainer);
        }
        const searchInput = document.querySelector('input[placeholder="搜索提示词"]');
        if (searchInput && searchInput.dataset.guanExcelSearchBridge !== "true") {
          searchInput.addEventListener("input", () => {
            if (clean(searchInput.value)) {
              rowContainer.style.display = "";
              productButton.setAttribute("aria-expanded", "true");
              if (chevron) chevron.style.transform = "rotate(90deg)";
            }
          });
          searchInput.dataset.guanExcelSearchBridge = "true";
        }
        rows.forEach((row) => {
          const titleButton = [...row.querySelectorAll("button")].find((button) => {
            const label = `${clean(button.textContent)} ${clean(button.getAttribute("aria-label"))} ${clean(button.title)}`;
            return !label.includes("查看详情") && !label.includes("插入画布");
          });
          const title = titleButton?.querySelector("div");
          if (title) {
            const nextTitle = clean(title.textContent).replace(`${productName} · `, "");
            if (title.textContent !== nextTitle) title.textContent = nextTitle;
          }
        });
        if (sourceGroup.dataset.guanExcelPromptMenu !== "true") sourceGroup.dataset.guanExcelPromptMenu = "true";
      });
    };
    const start = () => {
      let scheduled = false;
      const scheduleEnhance = () => {
        if (scheduled) return;
        scheduled = true;
        const run = () => {
          scheduled = false;
          enhance();
        };
        if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
        else window.setTimeout(run, 0);
      };
      scheduleEnhance();
      new MutationObserver(scheduleEnhance).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  };

  const applyPromptSource = () => {
    const contractState = parentContractState();
    const { fileName, templates, activeProductName } = readTemplates(contractState);
    const items = makeItems(templates);
    // The native source app caches prompt records by source id. Scope that id
    // to the active product so a product switch cannot briefly show another
    // product's cached prompts while the new source is loading.
    const scopedSourceId = `${SOURCE_ID}-${SOURCE_CACHE_VERSION}-${hash(activeProductName || "all")}`;
    const activeSetId = contractState?.workspace?.activeProductSetId || "none";
    const fileSha = clean(contractState?.productSets?.find((item) => item.id === activeSetId)?.source?.fileSha256);
    const sourcePath = `/canvas/__guan_excel_prompts__.json?source=${encodeURIComponent(`${SOURCE_CACHE_VERSION}-${fileSha || hash(JSON.stringify(items))}-${hash(activeProductName || "all")}`)}`;
    window.__guanExcelPromptItems = items;
    if (!window.__guanExcelPromptFetchInstalled) {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        try {
          const requestUrl = new URL(input instanceof Request ? input.url : String(input), window.location.href);
          if (requestUrl.pathname === "/canvas/__guan_excel_prompts__.json") {
            return Promise.resolve(new Response(JSON.stringify(window.__guanExcelPromptItems || []), {
              status: 200,
              headers: { "content-type": "application/json" },
            }));
          }
        } catch {
          // Let the native fetch handle malformed or unrelated requests.
        }
        return nativeFetch(input, init);
      };
      window.__guanExcelPromptFetchInstalled = true;
    }
    const customSource = {
      id: scopedSourceId,
      name: activeProductName
        ? `Excel 提示词 · ${activeProductName}`
        : (fileName ? `Excel 提示词 · ${fileName}` : "Excel 提示词"),
      url: sourcePath,
      homepage: "",
      enabled: true,
      builtIn: false,
    };
    const sources = BUILT_IN_SOURCES.map(([id, name, homepage, url]) => ({ id, name, homepage, url, enabled: false, builtIn: true }));
    sources.push(customSource);
    const next = JSON.stringify({ state: { sources, schedule: { intervalMinutes: 0, lastFetchedAt: "" } }, version: 0 });
    try {
      if (localStorage.getItem(STORE_KEY) !== next) localStorage.setItem(STORE_KEY, next);
    } catch {
      // The canvas still works if storage is unavailable; the source app will
      // simply show its own fallback state.
    }
  };

  installCanvasHeaderCleanup();
  installFitAllButtonLabel();
  installPromptMenuEnhancement();
  applyPromptSource();
})();
