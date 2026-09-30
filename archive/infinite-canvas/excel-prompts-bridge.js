(() => {
  "use strict";

  // The canvas is served from the same origin as the workbench, so it can
  // prepare the native prompt-source store before the React app hydrates.
  // This keeps the source app's search, expand, details and insert actions
  // intact while replacing its built-in remote prompt registry with the
  // prompts recognized from the active Excel workbook.
  const STORE_KEY = "infinite-canvas:prompt_source_store_v2";
  const SOURCE_ID = "guan-excel-prompts";
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
    if (detail) return `详情图提示词 ${detail[1].padStart(2, "0")}`;
    const rich = value.match(/^Rich Prompt (\d+)$/i);
    if (rich) return `富内容提示词 ${rich[1].padStart(2, "0")}`;
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

  const applyPromptSource = () => {
    const contractState = parentContractState();
    const { fileName, templates, activeProductName } = readTemplates(contractState);
    const items = makeItems(templates);
    // The native source app caches prompt records by source id. Scope that id
    // to the active product so a product switch cannot briefly show another
    // product's cached prompts while the new source is loading.
    const scopedSourceId = `${SOURCE_ID}-${hash(activeProductName || "all")}`;
    const activeSetId = contractState?.workspace?.activeProductSetId || "none";
    const fileSha = clean(contractState?.productSets?.find((item) => item.id === activeSetId)?.source?.fileSha256);
    const sourcePath = `/canvas/__guan_excel_prompts__.json?source=${encodeURIComponent(`${fileSha || hash(JSON.stringify(items))}-${hash(activeProductName || "all")}`)}`;
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

  applyPromptSource();
})();
