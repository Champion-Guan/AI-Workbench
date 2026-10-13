(() => {
  "use strict";

  // The canvas is served from the same origin as the workbench, so it can
  // prepare the native prompt-source store before the React app hydrates.
  // This keeps the source app's search, expand, details and insert actions
  // intact while replacing its built-in remote prompt registry with the
  // prompts recognized from the active Excel workbook.
  const STORE_KEY = "infinite-canvas:prompt_source_store_v2";
  const SOURCE_ID = "guan-excel-prompts";
  const SOURCE_CACHE_VERSION = "v3";
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
  const VIDEO_IMPORT_KEY = "guan-excel-import-video-prompts-v2";
  const includeVideoPrompts = () => {
    try { return localStorage.getItem(VIDEO_IMPORT_KEY) === "true"; } catch { return false; }
  };
  const shouldImportPrompt = (key, includeVideo) => includeVideo || !/^Video Prompt(?:\s|$)/i.test(clean(key));

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

  const localizeTheme = (value) => {
    const theme = String(value ?? "").trim();
    const normalize = (text) => text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[._-]+/g, " ").replace(/\s*([/+&])\s*/g, " $1 ").replace(/\s+/g, " ").trim();
    const aliases = {
        "full product hero": "完整产品主图", "product hero": "产品主图", "main prompt": "主图提示词",
        "detail image": "详情页图片", "detail prompt": "详情页提示词", "rich content": "富内容",
        "rich prompt": "富内容提示词", "video prompt": "视频提示词",
        "flat lay included contents": "平铺收纳与配件", "cropped functional part": "局部功能特写",
        "cropped storage structure": "收纳结构特写", "hands in use": "手部使用场景",
        "usage sequence": "使用流程", "macro material / finish": "材质与表面细节",
        "scale / dimension visual": "尺寸规格展示", "care / storage": "保养与收纳",
        "overview + contents narrative": "全貌与配件说明", "component selection guide": "配件选择指南",
        "hands in use sequence": "手部使用流程", "checklist / package audit": "清单与包装核对",
        "installation / assembly sequence": "安装与组装流程", "installation / assembly steps": "安装与组装步骤",
        "checklist / use boundary": "使用清单与适用边界", "selection guide narrative": "选购指南",
        "technical macro narrative": "技术细节微距展示", "assembly / structural proof": "组装与结构验证",
        "hands in use narrative": "手部使用演示", "checklist / care storage": "清单与保养收纳",
        "compatibility / selection guide": "兼容性与选购指南", "compatibility / selection": "兼容性与选型",
        "material / finish": "材质与表面细节", "material / surface detail": "材质与表面细节",
        "size / specification": "尺寸与规格", "dimensions / specifications": "尺寸与规格",
        "before / after": "前后对比", "before and after": "前后对比",
        "exploded view": "拆解展示", "cross section": "剖面结构", "cutaway view": "剖面展示",
        "top view": "俯视图", "front view": "正面图", "side view": "侧面图", "rear view": "背面图",
        "back view": "背面图", "three quarter view": "四分之三角度图", "45 degree view": "45度视角",
        "close up": "近距离特写", "extreme close up": "超近距离特写", "macro shot": "微距特写",
        "flat lay": "平铺展示", "white background": "白底展示", "lifestyle scene": "生活场景",
        "in use": "使用中展示", "product in use": "产品使用展示", "step by step": "分步演示",
        "how to use": "使用方法", "package contents": "包装内容", "included accessories": "随附配件",
        "key features": "核心功能", "core features": "核心卖点", "selling points": "产品卖点",
        "benefit demonstration": "优势演示", "function demonstration": "功能演示",
        "scale reference": "尺寸参照", "size comparison": "尺寸对比", "performance comparison": "性能对比",
        "texture detail": "纹理细节", "surface texture": "表面纹理", "material detail": "材质细节",
        "quality proof": "品质验证", "durability test": "耐用性测试", "safety features": "安全设计",
        "care instructions": "保养说明", "storage solution": "收纳方案", "installation guide": "安装指南",
        "assembly guide": "组装指南", "compatibility guide": "兼容性指南", "selection guide": "选购指南",
        "dimension display": "尺寸展示", "measurement guide": "尺寸测量指南", "size chart": "尺寸表",
        "isometric view": "等轴测视图", "perspective view": "透视角度", "low angle": "低机位视角",
        "high angle": "高机位视角", "eye level": "平视角度", "bird eye view": "鸟瞰视图",
        "hero shot": "产品主视觉", "detail shot": "细节特写", "macro view": "微距展示",
        "color options": "颜色选择", "color variants": "颜色款式", "product comparison": "产品对比",
        "space saving": "节省空间", "ergonomic design": "人体工学设计", "water resistance": "防水展示",
        "load capacity": "承重能力", "weight capacity": "承重能力", "use scenario": "使用场景",
        "dimension overview": "尺寸全貌", "dimensions and weight": "尺寸与重量",
    };
    const words = {
        installation: "安装", assembly: "组装", sequence: "流程", steps: "步骤", checklist: "清单",
        "use boundary": "适用边界", "care storage": "保养收纳", care: "保养", storage: "收纳",
        "selection guide": "选购指南", selection: "选型", compatibility: "兼容性",
        "technical macro": "技术微距细节", technical: "技术细节", macro: "微距细节",
        "structural proof": "结构验证", structural: "结构", proof: "验证", evidence: "验证依据",
        "hands in use": "手部使用", narrative: "展示说明", demonstration: "演示", guide: "指南",
        product: "产品", overview: "全貌", contents: "内容", accessories: "配件", quantity: "数量",
        material: "材质", finish: "表面处理", texture: "纹理", detail: "细节", details: "细节",
        dimension: "尺寸", dimensions: "尺寸", scale: "比例", specification: "规格", specifications: "规格",
        functional: "功能", function: "功能", features: "功能", package: "包装", audit: "核对",
        performance: "性能", comparison: "对比", benefit: "优势", benefits: "优势", safety: "安全",
        cleaning: "清洁", maintenance: "维护", portable: "便携", portability: "便携性",
        folding: "折叠", folded: "折叠状态", unfolded: "展开状态", adjustment: "调节",
        size: "尺寸", measurement: "测量", measurements: "测量", width: "宽度", height: "高度",
        length: "长度", depth: "深度", diameter: "直径", weight: "重量", capacity: "容量",
        view: "视图", angle: "角度", shot: "拍摄", display: "展示", ergonomic: "人体工学",
        color: "颜色", options: "选择", variants: "款式", design: "设计", resistance: "防护能力",
        "/": "与", "+": "与", "&": "与", and: "与", visual: "展示", scene: "场景",
    };
    const normalized = normalize(theme);
    if (aliases[normalized]) return aliases[normalized];
    if (/[\u3400-\u9fff]/.test(theme)) return theme;
    const parts = normalized.split(" ");
    const result = [];
    for (let i = 0; i < parts.length;) {
        let matched = false;
        for (let length = Math.min(4, parts.length - i); length > 0; length--) {
            const phrase = parts.slice(i, i + length).join(" ");
            const translated = aliases[phrase] || words[phrase];
            if (!translated) continue;
            result.push(translated);
            i += length;
            matched = true;
            break;
        }
        if (!matched) return theme;
    }
    return result.join("") || theme;
  };

  const promptTokens = (value) => {
    const omitted = [/^\[\d+\s*[-–—]\s*\d+秒/i, /^\[FILL WITH VERIFIED PRODUCT DATA\]$/i, /^\[PRODUCT PHOTO\/CAD\]$/i, /^\[待填写\]$/i, /^\[我的产品变量\]$/i, /^\[node:/i, /^\[\d+\]$/i];
    const seen = new Set();
    return (clean(value).match(/\[[^\]\r\n]{1,160}\]/g) || []).map((token) => token.trim()).filter((token) => token && !omitted.some((pattern) => pattern.test(token)) && !seen.has(token) && (seen.add(token), true));
  };

  const promptSpec = (key, value) => {
    const text = clean(value);
    const compositionLock = text.match(/COMPOSITION LOCK:\s*([^\.\n]+)/i)?.[1]?.trim() || "";
    const explicitTheme = text.match(/(?:主题(?:\/角度)?|Theme|核心视觉|Core visual|Visual focus|画面重点|重点)\s*[：:]\s*([^\.\n]+)/i)?.[1]?.trim() || compositionLock;
    const themeRules = [
      ["收纳/折叠", /fold|storage|case|portable|compact|收纳|折叠|便携/i],
      ["角度/调节", /angle|degree|tilt|viewing angle|倾角|角度|调节|截止线/i],
      ["安装/兼容", /install|installation|fitment|compatib|adapter|安装|兼容|适配/i],
      ["尺寸/规格", /dimension|size|specification|measurement|尺寸|规格|参数/i],
      ["材质/结构", /material|structure|heat dissipation|散热|材质|结构/i],
      ["配件/数量", /accessor|contents|quantity|kit|included|配件|套装|数量|清单/i],
      ["使用场景", /scene|use case|scenario|workbench|桌面|场景|使用/i],
      ["核心功能/卖点", /core feature|key selling|selling point|功能|卖点|优势/i],
    ];
    const scored = themeRules.map(([label, pattern]) => [label, (text.match(new RegExp(pattern.source, `${pattern.flags}g`)) || []).length]).sort((a, b) => b[1] - a[1]);
    const kindFallback = /^Main/i.test(key) ? "主图｜产品全貌与核心卖点" : /^Rich/i.test(key) ? "富内容｜模块化信息与证据" : /^Video/i.test(key) ? "视频｜使用场景与功能演示" : `详情图${key.match(/(\d+)/)?.[1] || ""}｜单一卖点`;
    const theme = localizeTheme(explicitTheme || (scored[0]?.[1] > 0 ? scored[0][0] : kindFallback));
    const purpose = text.match(/(?:Module purpose|模块)\s*[：:]\s*([^\.\n]+)/i)?.[1]?.trim() || "";
    return { key, label: promptLabel(key), theme, compositionLock, purpose, tokens: promptTokens(text) };
  };

  const readTemplates = (state) => {
    if (!state) return { fileName: "", templates: [] };
    const canvasProductId = new URLSearchParams(window.location.search).get("workbenchProductId");
    const canvasProduct = state.products?.find((product) => product.id === canvasProductId);
    const activeSetId = canvasProduct?.productSetId || state.workspace?.activeProductSetId || state.productSets?.[0]?.id || "";
    const activeSet = state.productSets?.find((item) => item.id === activeSetId)
      || state.productSets?.[state.productSets.length - 1]
      || null;
    const source = activeSet?.source || {};
    const templates = Array.isArray(source.promptTemplates) ? source.promptTemplates : [];
    // Names are display labels, not identities: same-name products can have
    // different price/material routes in separate Excel rows.
    let activeProductName = "";
    try {
      activeProductName = canvasProduct
        ? productName(canvasProduct.identity?.titleZh || canvasProduct.identity?.sku, 0)
        : clean(new URLSearchParams(window.location.search).get("productTitle"));
    } catch {
      activeProductName = "";
    }
    if (!activeProductName) {
      const activeProductId = state.workspace?.activeProductId;
      const activeProduct = state.products?.find((product) => product.id === activeProductId);
      activeProductName = productName(activeProduct?.identity?.titleZh || activeProduct?.identity?.sku, 0);
    }
    const selectedProduct = canvasProduct || state.products?.find((product) => product.id === state.workspace?.activeProductId && product.productSetId === activeSetId);
    const fullRoute = clean(selectedProduct?.identity?.titleZh || new URLSearchParams(window.location.search).get("productTitle"));
    const exact = fullRoute ? templates.filter((template) => clean(template?.route) === fullRoute) : [];
    const sameRow = (candidates) => candidates.find((template) => template.sourceRowNumber != null && Number(template.sourceRowNumber) === Number(selectedProduct?.sourceRowNumber));
    let scopedTemplates;
    if (exact.length) {
      scopedTemplates = [sameRow(exact) || exact[0]];
    } else if (selectedProduct && source.role === "prompt-products") {
      // Do not borrow another product's prompts when this row was removed.
      scopedTemplates = [];
    } else if (activeProductName) {
      const named = templates.filter((template) => productName(template?.route, 0) === activeProductName);
      const match = sameRow(named);
      scopedTemplates = match ? [match] : named.length === 1 ? named : [];
    } else {
      scopedTemplates = templates;
    }
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
        title: `${name} · ${promptLabel(key)}${promptSpec(key, value).theme ? ` · ${promptSpec(key, value).theme}` : ""}`,
        prompt: value,
        description: `来自 Excel · ${name}`,
        coverUrl: "",
        referenceImageUrls: [],
        tags: ["Excel", name, promptLabel(key)].filter(Boolean),
        preview: [promptSpec(key, value).theme && `主题/角度：${promptSpec(key, value).theme}`, promptSpec(key, value).purpose && `画面任务：${promptSpec(key, value).purpose}`].filter(Boolean).join("\n"),
        createdAt: clean(template?.createdAt),
        updatedAt: clean(template?.updatedAt),
        sourceUrl: "",
        excelPrompt: {
          templateId: clean(template?.id) || `${SOURCE_ID}-${templateIndex + 1}`,
          key: clean(key),
          ...promptSpec(key, value),
        },
      }));
  });

  const makePromptContext = (fileName, activeProductName, templates) => ({
    fileName,
    activeProductName,
    templates: templates.map((template, templateIndex) => ({
      id: clean(template?.id) || `${SOURCE_ID}-${templateIndex + 1}`,
      route: clean(template?.route),
      prompts: Object.fromEntries(Object.entries(template?.prompts || {}).map(([key, value]) => [key, clean(value)]).filter(([, value]) => value)),
    })).filter((template) => Object.keys(template.prompts).length),
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
        // Appearance controls share labels with the removed top-nav toggle.
        // Keep the React-owned light/dark controls inside the canvas panel.
        if (element.hasAttribute("data-canvas-appearance-theme")) {
          element.classList.remove("guan-hidden-canvas-header-item");
          return;
        }
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

  // The workbook picker is rendered by the host shell rather than the canvas
  // bundle. Keep its popover behaving like a normal click-away menu so it
  // never remains over the canvas after the user chooses another tool.
  const installWorkbookMenuClickAway = () => {
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const findWorkbookPopover = () => [...document.querySelectorAll("[role=menu], [role=listbox], [data-radix-popper-content-wrapper], [class*=popover], [class*=dropdown]")]
      .find((element) => isVisible(element) && /上传\s*Excel/.test(clean(element.textContent)));
    const findWorkbookTrigger = () => {
      const expanded = [...document.querySelectorAll("button, [role=button], [aria-expanded='true']")]
        .find((element) => isVisible(element) && /(?:\.xlsx|暂无已上传\s*Excel)/i.test(clean(element.textContent)));
      if (expanded) return expanded;
      const label = [...document.querySelectorAll("button, [role=button], [aria-expanded]")]
        .find((element) => isVisible(element) && /(?:\.xlsx|暂无已上传\s*Excel)/i.test(clean(element.textContent)));
      return label?.closest("button, [role=button]") || label || null;
    };
    document.addEventListener("pointerdown", (event) => {
      const popover = findWorkbookPopover();
      if (!popover || popover.contains(event.target)) return;
      const trigger = findWorkbookTrigger();
      if (trigger && trigger !== event.target && !trigger.contains(event.target)) {
        trigger.click();
      } else if (!trigger) {
        // Ant Design and Radix both close their menus on Escape. This is a
        // safe fallback for host-shell versions whose trigger is not a button.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    }, true);
  };

  // Theme synchronization is owned by app-providers.tsx.

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
        // Batch-import every prompt in this product group. The native canvas
        // listens for the follow-up event and links the inserted prompts to
        // the product-parameter node when one exists.
        let batchButton = content.querySelector(".guan-excel-batch-import");
        if (!batchButton) {
          batchButton = document.createElement("button");
          batchButton.type = "button";
          batchButton.className = "guan-excel-batch-import";
          batchButton.textContent = "一键导入";
          batchButton.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:auto;margin:0 4px 0 6px;padding:3px 6px;border:1px solid rgba(120,113,108,.35);border-radius:5px;background:rgba(255,255,255,.55);color:inherit;font-size:10px;line-height:1.2;cursor:pointer;text-align:center";
          batchButton.addEventListener("click", () => {
            if (batchButton.dataset.busy === "true") return;
            batchButton.dataset.busy = "true";
            batchButton.textContent = "检查并导入中…";
            const includeVideo = content.querySelector(".guan-excel-video-import-toggle input")?.checked ?? includeVideoPrompts();
            const buttons = [...rowContainer.querySelectorAll("button")].filter((button) => {
              const label = `${clean(button.textContent)} ${clean(button.getAttribute("aria-label"))} ${clean(button.title)}`;
              const row = button.closest("[data-canvas-prompt-drag]");
              const key = row?.getAttribute("data-excel-prompt-key") || "";
              return label.includes("插入画布") && shouldImportPrompt(key, includeVideo);
            });
            buttons.forEach((button, index) => window.setTimeout(() => button.click(), index * 80));
            window.setTimeout(() => {
              batchButton.dataset.busy = "false";
              batchButton.textContent = "一键导入";
              window.dispatchEvent(new CustomEvent("guan-excel-batch-imported", { detail: { productName } }));
            }, buttons.length * 80 + 220);
          });
          const toolbar = document.createElement("div");
          toolbar.className = "guan-excel-product-toolbar";
          toolbar.style.cssText = "display:flex;align-items:center;width:100%;gap:4px";
          content.insertBefore(toolbar, productButton);
          toolbar.appendChild(productButton);
          const videoLabel = document.createElement("label");
          videoLabel.className = "guan-excel-video-import-toggle";
          videoLabel.style.cssText = "display:inline-flex;position:relative;align-items:center;flex:0 0 auto;width:28px;height:16px;margin:0 2px;cursor:pointer";
          const videoToggle = document.createElement("input");
          videoToggle.type = "checkbox";
          videoToggle.setAttribute("role", "switch");
          videoToggle.setAttribute("aria-label", "是否导入视频提示词");
          videoToggle.checked = includeVideoPrompts();
          videoToggle.style.cssText = "position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;z-index:1;cursor:pointer";
          const track = document.createElement("span");
          track.setAttribute("aria-hidden", "true");
          track.style.cssText = "display:block;width:28px;height:16px;border-radius:999px;transition:background .15s ease";
          const thumb = document.createElement("span");
          thumb.style.cssText = "display:block;width:12px;height:12px;margin:2px;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s ease,background .15s ease";
          track.appendChild(thumb);
          const updateVideoSwitch = () => {
            const dark = document.documentElement.classList.contains("dark");
            track.style.background = dark ? (videoToggle.checked ? "#f5f5f4" : "#57534e") : (videoToggle.checked ? "#18181b" : "#b8b8b8");
            thumb.style.background = dark && videoToggle.checked ? "#18181b" : "#fff";
            thumb.style.transform = videoToggle.checked ? "translateX(12px)" : "translateX(0)";
            videoLabel.title = `是否导入视频提示词：${videoToggle.checked ? "已开启，一键导入时包含视频提示词" : "已关闭，一键导入时跳过视频提示词"}`;
          };
          updateVideoSwitch();
          new MutationObserver(updateVideoSwitch).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
          videoToggle.addEventListener("focus", () => { track.style.outline = "2px solid #3b82f6"; track.style.outlineOffset = "2px"; });
          videoToggle.addEventListener("blur", () => { track.style.outline = ""; });
          videoToggle.addEventListener("change", () => {
            updateVideoSwitch();
            try { localStorage.setItem(VIDEO_IMPORT_KEY, String(videoToggle.checked)); } catch { /* Optional preference persistence. */ }
          });
          videoLabel.append(videoToggle, track);
          toolbar.appendChild(videoLabel);
          toolbar.appendChild(batchButton);
          productButton.style.width = "auto";
          productButton.style.flex = "1 1 auto";
          productButton.style.minWidth = "0";
          productButton.style.margin = "2px 0";
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

  let appliedSignature = "";
  const applyPromptSource = () => {
    const contractState = parentContractState();
    const { fileName, templates, activeProductName } = readTemplates(contractState);
    const items = makeItems(templates);
    const signature = JSON.stringify([fileName, activeProductName, items]);
    if (signature === appliedSignature) return;
    appliedSignature = signature;
    window.__guanExcelPromptContext = makePromptContext(fileName, activeProductName, templates);
    // The native source app caches prompt records by source id. Scope that id
    // to the active product so a product switch cannot briefly show another
    // product's cached prompts while the new source is loading.
    const scopedSourceId = `${SOURCE_ID}-${SOURCE_CACHE_VERSION}-${hash(activeProductName || "all")}-${hash(signature)}`;
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
    window.dispatchEvent(new CustomEvent("guan-excel-prompts-updated", { detail: { sources, schedule: { intervalMinutes: 0, lastFetchedAt: "" } } }));
  };

  installCanvasHeaderCleanup();
  installFitAllButtonLabel();
  installWorkbookMenuClickAway();
  installPromptMenuEnhancement();
  applyPromptSource();
  // Parent and same-origin iframe do not receive each other's storage events.
  const host = window.parent && window.parent !== window ? window.parent : window;
  host.addEventListener("guan-data-contract-change", applyPromptSource);
  host.addEventListener("guan-active-product-set-change", applyPromptSource);
  window.addEventListener("storage", (event) => {
    if (event.key === "guan-workbench:data-contract:v1") applyPromptSource();
  });
  window.addEventListener("pagehide", () => {
    host.removeEventListener("guan-data-contract-change", applyPromptSource);
    host.removeEventListener("guan-active-product-set-change", applyPromptSource);
  }, { once: true });
})();
