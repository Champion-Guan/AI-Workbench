(() => {
  "use strict";

  const STORAGE_KEY = "guan-ai-workbench-canvas-v1";
  const MAX_SCALE = 5;
  const MIN_SCALE = 0.05;
  const state = {
    root: null,
    viewport: null,
    world: null,
    links: null,
    empty: null,
    zoomValue: null,
    zoomDockValue: null,
    zoomRange: null,
    toast: null,
    nodes: [],
    nodeElements: new Map(),
    imageUrls: new Map(),
    productId: "",
    originalPreview: null,
    canvasHost: null,
    canvasLayoutHost: null,
    canvasLayoutParent: null,
    canvasLayoutNextSibling: null,
    canvasSidePanel: null,
    canvasIntro: null,
    carouselNav: null,
    chromeHeader: null,
    uiLayers: [],
    view: { x: 34, y: 30, scale: 0.86 },
    gridMode: "dots",
    panMode: false,
    loaded: false,
    pan: null,
    drag: null,
    toastTimer: 0,
    sidePanelOpen: true,
    sidePanelTab: "canvas",
    sidePanelSearch: "",
    canvasTool: "select",
    selectedNodeIds: new Set(),
    history: [],
    historyIndex: -1,
    menuOpen: false,
    appearanceOpen: false,
    imageInfo: true,
  };

  const getImageFiles = () => Array.isArray(window.__localWorkbenchImageFiles)
    ? window.__localWorkbenchImageFiles
    : [];

  const getContractState = () => {
    try {
      return window.GuanWorkbenchData?.getState?.() || null;
    } catch {
      return null;
    }
  };

  const getActiveProduct = () => {
    const contractState = getContractState();
    if (!contractState?.products?.length) return null;
    const activeSetId = contractState.workspace?.activeProductSetId
      || contractState.productSets?.[0]?.id
      || "";
    const products = contractState.products
      .filter((product) => product.productSetId === activeSetId)
      .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
    const activeId = contractState.workspace?.activeProductId;
    return products.find((product) => product.id === activeId) || products[0] || null;
  };

  const productDisplayName = (product) => {
    const raw = product?.identity?.titleZh || product?.identity?.sku || "未命名产品";
    return String(raw).split(/[|｜]/, 1)[0].trim() || "未命名产品";
  };

  const storageKey = () => `${STORAGE_KEY}:${state.productId || "unassigned"}`;

  const fileKey = (file) => [file?.name || "image", file?.size || 0, file?.lastModified || 0].join(":");

  const newId = (kind) => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const escapeText = (value) => String(value == null ? "" : value);

  const icon = (name, size = 17) => {
    const paths = {
      hand: '<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V9m0-2.5a1.5 1.5 0 0 1 3 0V10m0-1a1.5 1.5 0 0 1 3 0v4.5A5.5 5.5 0 0 1 10.5 19h-1A5.5 5.5 0 0 1 4 13.5V11a1.5 1.5 0 0 1 3 0v1"/><path d="M7 9V7.5a1.5 1.5 0 0 1 3 0"/>',
      select: '<path d="m5 3 5 13 2-6 6-2L5 3Z"/><path d="m12 12 5 5"/>',
      undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a5 5 0 0 1 0 10h-1"/>',
      redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a5 5 0 0 0 0 10h1"/>',
      text: '<path d="M4 6V4h16v2M12 4v16M8 20h8"/>',
      image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/>',
      video: '<rect x="3" y="5" width="15" height="14" rx="2"/><path d="m18 10 3-2v8l-3-2"/>',
      audio: '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
      settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="m19.4 15 .1.1a2 2 0 1 1-2.8 2.8l-.1-.1M4.6 9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1M15 4.6l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1M9 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1"/>',
      group: '<rect x="4" y="4" width="8" height="8" rx="1"/><rect x="12" y="12" width="8" height="8" rx="1"/>',
      upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 16v3h16v-3"/>',
      palette: '<path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h3a6 6 0 0 0 0-12h-3Z"/><circle cx="7" cy="10" r="1"/><circle cx="9" cy="6.5" r="1"/><circle cx="14" cy="6.5" r="1"/>',
      trash: '<path d="M4 7h16M10 11v5m4-5v5M6 7l1 13h10l1-13M9 7V4h6v3"/>',
      menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
      panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16m4-11 3 3-3 3"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
      compass: '<circle cx="12" cy="12" r="9"/><path d="m15 9-2 4-4 2 2-4 4-2Z"/>',
      focus: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="12" cy="12" r="3"/>',
    };
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.settings}</svg>`;
  };

  const loadNodes = () => {
    try {
      const raw = localStorage.getItem(storageKey());
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || !Array.isArray(parsed.nodes)) return [];
      return parsed.nodes
        .filter((node) => node && ["image", "prompt", "output"].includes(node.kind))
        .map((node) => ({
          id: typeof node.id === "string" ? node.id : newId(node.kind),
          kind: node.kind,
          x: Number.isFinite(node.x) ? node.x : 100,
          y: Number.isFinite(node.y) ? node.y : 100,
          text: typeof node.text === "string" ? node.text : "",
          fileKey: typeof node.fileKey === "string" ? node.fileKey : "",
          fileName: typeof node.fileName === "string" ? node.fileName : "",
        }));
    } catch {
      return [];
    }
  };

  const persist = () => {
    try {
      localStorage.setItem(storageKey(), JSON.stringify({
        version: 1,
        nodes: state.nodes.map((node) => ({
          id: node.id,
          kind: node.kind,
          x: node.x,
          y: node.y,
          text: node.text || "",
          fileKey: node.fileKey || "",
          fileName: node.fileName || "",
        })),
      }));
    } catch {
      // Canvas interaction remains available when localStorage is unavailable.
    }
  };

  const showToast = (message) => {
    if (!state.toast) return;
    state.toast.textContent = message;
    state.toast.classList.add("is-visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => state.toast?.classList.remove("is-visible"), 2200);
  };

  const nodeSize = (node) => {
    if (node.kind === "prompt") return { width: 310, height: 224 };
    if (node.kind === "output") return { width: 284, height: 170 };
    return { width: 260, height: 230 };
  };

  const createButton = (label, action, className = "guan-canvas-button") => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset.action = action;
    button.textContent = label;
    return button;
  };

  const buildRoot = () => {
    const root = document.createElement("div");
    root.className = "guan-canvas-root";
    root.dataset.localCanvasV1 = "true";
    root.dataset.gridMode = state.gridMode;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "工作画布");

    const sourceTop = document.createElement("div");
    sourceTop.className = "guan-canvas-source-topbar";
    const panelToggle = createButton("", "toggle-side-panel", "guan-canvas-source-icon");
    panelToggle.innerHTML = icon("panel"); panelToggle.title = "显示/隐藏侧边栏";
    const menuButton = createButton("", "toggle-menu", "guan-canvas-source-icon");
    menuButton.innerHTML = icon("menu"); menuButton.title = "画布菜单";
    const sourceTitle = document.createElement("strong");
    sourceTitle.className = "guan-canvas-source-title";
    sourceTitle.textContent = "无限画布 2";
    const sourceStatus = document.createElement("span");
    sourceStatus.className = "guan-canvas-source-status";
    sourceStatus.textContent = "● Codex 未连接";
    const sourceMenu = document.createElement("div");
    sourceMenu.className = "guan-canvas-source-menu";
    sourceMenu.hidden = true;
    sourceMenu.innerHTML = '<button type="button" data-action="add-prompt">添加提示词</button><button type="button" data-action="add-image">添加图片</button><button type="button" data-action="fit">适应画布</button><button type="button" data-action="export-canvas">导出画布</button><button type="button" data-action="clear">清空画布</button>';
    sourceTop.append(panelToggle, menuButton, sourceTitle, sourceStatus, sourceMenu);

    const sourcePanel = document.createElement("aside");
    sourcePanel.className = "guan-canvas-source-panel";
    const panelTabs = document.createElement("div");
    panelTabs.className = "guan-canvas-panel-tabs";
    ["canvas", "assets", "prompts"].forEach((tab) => {
      const button = createButton(tab === "canvas" ? "画布" : tab === "assets" ? "资产" : "提示词库", "switch-panel-tab", "guan-canvas-panel-tab");
      button.dataset.tab = tab;
      panelTabs.append(button);
    });
    const panelBody = document.createElement("div");
    panelBody.className = "guan-canvas-panel-body";
    sourcePanel.append(panelTabs, panelBody);
    const appearance = document.createElement("div");
    appearance.className = "guan-canvas-appearance-popover";
    appearance.hidden = true;
    appearance.innerHTML = '<strong>画布外观</strong><span>主题</span><div class="guan-canvas-appearance-row"><button type="button" data-action="theme-light">浅色</button><button type="button" data-action="theme-dark">深色</button></div><span>背景网格</span><div class="guan-canvas-appearance-row"><button type="button" data-action="grid-dots">点</button><button type="button" data-action="grid-lines">线</button><button type="button" data-action="grid-blank">空白</button></div><label><input type="checkbox" data-action="image-info" checked> 显示图片信息</label>';

    // Keep the product title in the DOM for accessibility and state syncing,
    // but let the canvas itself follow the compact reference layout.
    const header = document.createElement("header");
    header.className = "guan-canvas-header";
    const title = document.createElement("div");
    title.className = "guan-canvas-title";
    const activeProduct = getActiveProduct();
    title.innerHTML = '<span class="guan-canvas-title-mark">✦</span><span class="guan-canvas-title-copy"><strong></strong><span></span></span>';
    title.querySelector("strong").textContent = activeProduct ? `${productDisplayName(activeProduct)} · 画布` : "商品生图画布";
    title.querySelector(".guan-canvas-title-copy span").textContent = activeProduct
      ? "独立产品画布 · 拖动节点，组合生图流程"
      : "拖动节点，组合你的生图流程";
    header.append(title);

    const viewport = document.createElement("div");
    viewport.className = "guan-canvas-viewport";
    viewport.setAttribute("aria-label", "画布视口");

    const world = document.createElement("div");
    world.className = "guan-canvas-world";
    const links = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    links.classList.add("guan-canvas-links");
    links.setAttribute("viewBox", "0 0 3600 2400");
    links.setAttribute("aria-hidden", "true");
    world.append(links);
    viewport.append(world);

    const empty = document.createElement("div");
    empty.className = "guan-canvas-empty";
    empty.innerHTML = '<strong>从一个节点开始</strong><span>上传商品原图，或先添加提示词节点。画布会自动保存节点位置。</span>';
    const emptyActions = document.createElement("div");
    emptyActions.className = "guan-canvas-prompt-actions";
    emptyActions.append(createButton("上传图片", "add-image", "guan-canvas-button primary"), createButton("添加提示词", "add-prompt"));
    empty.append(emptyActions);
    viewport.append(empty);

    const hint = document.createElement("div");
    hint.className = "guan-canvas-hint";
    hint.innerHTML = "拖动画布 · 滚轮缩放 · 节点可拖动";
    viewport.append(hint);

    const makeDockButton = (iconName, action, label, extraClass = "") => {
      const button = createButton("", action, `guan-canvas-dock-button ${extraClass}`.trim());
      button.innerHTML = icon(iconName);
      button.setAttribute("aria-label", label);
      button.title = label;
      return button;
    };

    const toolDockWrap = document.createElement("div");
    toolDockWrap.className = "guan-canvas-tool-dock-wrap";
    const toolDock = document.createElement("div");
    toolDock.className = "guan-canvas-tool-dock";
    toolDock.append(
      makeDockButton("hand", "toggle-pan", "平移画布"),
      makeDockButton("undo", "undo", "撤销"),
      makeDockButton("redo", "redo", "重做"),
      Object.assign(document.createElement("span"), { className: "guan-canvas-dock-divider" }),
      makeDockButton("text", "add-prompt", "添加提示词"),
      makeDockButton("image", "add-image", "添加图片"),
      makeDockButton("video", "unsupported", "添加视频"),
      makeDockButton("audio", "unsupported", "添加音频"),
      makeDockButton("settings", "unsupported", "画布设置"),
      makeDockButton("group", "unsupported", "组合节点"),
      makeDockButton("upload", "upload", "导入画布"),
      makeDockButton("palette", "toggle-appearance", "外观"),
      makeDockButton("trash", "clear", "清空画布"),
    );
    toolDockWrap.append(toolDock);
    viewport.append(toolDockWrap);

    const zoomDock = document.createElement("div");
    zoomDock.className = "guan-canvas-zoom-dock";
    const zoomRange = document.createElement("input");
    zoomRange.type = "range";
    zoomRange.min = String(MIN_SCALE * 100);
    zoomRange.max = String(MAX_SCALE * 100);
    zoomRange.step = "1";
    zoomRange.value = String(Math.round(state.view.scale * 100));
    zoomRange.className = "guan-canvas-zoom-range";
    zoomRange.setAttribute("aria-label", "画布缩放");
    const zoomDockValue = document.createElement("span");
    zoomDockValue.className = "guan-canvas-zoom-value";
    zoomDockValue.textContent = `${Math.round(state.view.scale * 100)}%`;
    zoomDock.append(
      makeDockButton("compass", "reset-view", "重置视图", "guan-canvas-zoom-button"),
      makeDockButton("focus", "fit", "适应画布", "guan-canvas-zoom-button"),
      zoomRange,
      zoomDockValue,
      makeDockButton("settings", "shortcuts", "快捷键", "guan-canvas-zoom-button"),
    );
    viewport.append(zoomDock);

    const toast = document.createElement("div");
    toast.className = "guan-canvas-toast";
    toast.setAttribute("role", "status");
    viewport.append(toast);

    root.append(header, viewport, sourceTop, sourcePanel, appearance);
    state.root = root;
    state.viewport = viewport;
    state.world = world;
    state.links = links;
    state.empty = empty;
    state.zoomValue = zoomDockValue;
    state.zoomDockValue = zoomDockValue;
    state.zoomRange = zoomRange;
    state.toast = toast;
    state.title = title;
    state.sourceTop = sourceTop;
    state.sourcePanel = sourcePanel;
    state.sourcePanelBody = panelBody;
    state.sourceMenu = sourceMenu;
    state.appearance = appearance;
    zoomRange.addEventListener("input", () => {
      const nextScale = clamp(Number(zoomRange.value) / 100, MIN_SCALE, MAX_SCALE);
      const factor = nextScale / state.view.scale;
      changeZoom(factor);
    });
    bindRootEvents(root);
    return root;
  };

  const syncProductHeading = () => {
    const product = getActiveProduct();
    const strong = state.title?.querySelector("strong");
    const subtitle = state.title?.querySelector(".guan-canvas-title-copy span");
    if (!strong || !subtitle) return;
    const nextTitle = product ? `${productDisplayName(product)} · 画布` : "商品生图画布";
    const nextSubtitle = product ? "独立产品画布 · 拖动节点，组合生图流程" : "拖动节点，组合你的生图流程";
    if (strong.textContent !== nextTitle) strong.textContent = nextTitle;
    if (subtitle.textContent !== nextSubtitle) subtitle.textContent = nextSubtitle;
  };

  const snapshot = () => JSON.stringify(state.nodes.map((node) => ({ ...node })));
  const resetHistory = () => { state.history = [snapshot()]; state.historyIndex = 0; };
  const pushHistory = () => {
    const next = snapshot();
    if (state.history[state.historyIndex] === next) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(next);
    state.historyIndex = state.history.length - 1;
    syncToolState();
  };
  const restoreHistory = (index) => {
    const raw = state.history[index];
    if (!raw) return;
    try { state.nodes = JSON.parse(raw); } catch { return; }
    state.historyIndex = index;
    persist(); renderNodes(); syncToolState();
  };
  const undo = () => { if (state.historyIndex > 0) restoreHistory(state.historyIndex - 1); else showToast("没有可撤销的操作"); };
  const redo = () => { if (state.historyIndex < state.history.length - 1) restoreHistory(state.historyIndex + 1); else showToast("没有可重做的操作"); };

  const focusNode = (node) => {
    if (!node || !state.viewport) return;
    state.selectedNodeIds = new Set([node.id]);
    const size = nodeSize(node);
    state.view.x = state.viewport.clientWidth / 2 - (node.x + size.width / 2) * state.view.scale;
    state.view.y = state.viewport.clientHeight / 2 - (node.y + size.height / 2) * state.view.scale;
    setWorldTransform(); syncToolState();
  };

  const renderSourcePanel = () => {
    const panel = state.sourcePanel;
    const body = state.sourcePanelBody;
    if (!panel || !body) return;
    panel.classList.toggle("is-closed", !state.sidePanelOpen);
    state.root?.style.setProperty("--guan-canvas-panel-width", state.sidePanelOpen ? "310px" : "0px");
    panel.querySelectorAll(".guan-canvas-panel-tab").forEach((button) => button.classList.toggle("is-active", button.dataset.tab === state.sidePanelTab));
    body.replaceChildren();
    const search = document.createElement("input");
    search.className = "guan-canvas-panel-search";
    search.placeholder = "搜索节点";
    search.value = state.sidePanelSearch;
    search.addEventListener("input", () => { state.sidePanelSearch = search.value; renderSourcePanel(); });
    body.append(search);
    if (state.sidePanelTab === "canvas") {
      const controls = document.createElement("div"); controls.className = "guan-canvas-panel-controls";
      controls.innerHTML = '<strong>画布元素</strong><span>选择</span><button type="button" data-action="select-all">全部</button>';
      body.append(controls);
      const list = document.createElement("div"); list.className = "guan-canvas-panel-list";
      const query = state.sidePanelSearch.trim().toLowerCase();
      state.nodes.filter((node) => !query || `${node.kind} ${node.text} ${node.fileName}`.toLowerCase().includes(query)).forEach((node) => {
        const item = document.createElement("button"); item.type = "button"; item.className = "guan-canvas-panel-item";
        item.classList.toggle("is-selected", state.selectedNodeIds.has(node.id));
        const label = node.kind === "image" ? node.fileName || "商品原图" : node.kind === "prompt" ? (node.text || "提示词") : "生成结果";
        item.innerHTML = `<span class="guan-canvas-panel-item-icon">${icon(node.kind === "image" ? "image" : node.kind === "prompt" ? "text" : "focus", 15)}</span><span>${escapeText(label).slice(0, 34)}</span>`;
        item.addEventListener("click", () => { focusNode(node); state.nodeElements.get(node.id)?.classList.add("is-selected"); });
        list.append(item);
      });
      if (!list.children.length) { const empty = document.createElement("div"); empty.className = "guan-canvas-panel-empty"; empty.textContent = "画布暂无节点"; list.append(empty); }
      body.append(list);
    } else if (state.sidePanelTab === "assets") {
      const list = document.createElement("div"); list.className = "guan-canvas-panel-list";
      getImageFiles().filter((file) => !state.sidePanelSearch || file.name.toLowerCase().includes(state.sidePanelSearch.toLowerCase())).forEach((file) => {
        const item = document.createElement("button"); item.type = "button"; item.className = "guan-canvas-panel-item";
        item.innerHTML = `<span class="guan-canvas-panel-thumb"></span><span>${escapeText(file.name).slice(0, 34)}</span>`;
        const thumb = item.querySelector(".guan-canvas-panel-thumb"); thumb.style.backgroundImage = `url(${state.imageUrls.get(fileKey(file)) || URL.createObjectURL(file)})`;
        item.addEventListener("click", () => { const node = state.nodes.find((candidate) => candidate.fileKey === fileKey(file)); if (node) focusNode(node); else { syncFiles(); showToast("图片已加入画布"); } });
        list.append(item);
      });
      if (!list.children.length) { const empty = document.createElement("div"); empty.className = "guan-canvas-panel-empty"; empty.textContent = "暂无资产"; list.append(empty); }
      body.append(list);
    } else {
      const list = document.createElement("div"); list.className = "guan-canvas-panel-list";
      state.nodes.filter((node) => node.kind === "prompt" && (!state.sidePanelSearch || node.text.toLowerCase().includes(state.sidePanelSearch.toLowerCase()))).forEach((node) => {
        const item = document.createElement("button"); item.type = "button"; item.className = "guan-canvas-panel-item"; item.textContent = node.text || "未命名提示词"; item.addEventListener("click", () => focusNode(node)); list.append(item);
      });
      if (!list.children.length) { const empty = document.createElement("div"); empty.className = "guan-canvas-panel-empty"; empty.textContent = "暂无提示词"; list.append(empty); }
      body.append(list);
    }
    syncToolState();
  };

  const syncToolState = () => {
    if (!state.root) return;
    state.root.classList.toggle("is-pan-mode", state.canvasTool === "pan");
    state.root.querySelectorAll('[data-action="toggle-pan"]').forEach((button) => { button.classList.toggle("is-active", state.canvasTool === "pan"); button.innerHTML = icon(state.canvasTool === "pan" ? "hand" : "select"); });
    state.root.querySelectorAll('[data-action="undo"]').forEach((button) => { button.disabled = state.historyIndex <= 0; });
    state.root.querySelectorAll('[data-action="redo"]').forEach((button) => { button.disabled = state.historyIndex >= state.history.length - 1; });
    state.root.querySelectorAll(".guan-canvas-node").forEach((element) => element.classList.toggle("is-selected", state.selectedNodeIds.has(element.dataset.id)));
  };

  const setWorldTransform = () => {
    if (!state.world) return;
    state.world.style.transform = `translate3d(${state.view.x}px, ${state.view.y}px, 0) scale(${state.view.scale})`;
    const percent = Math.round(state.view.scale * 100);
    if (state.zoomValue) state.zoomValue.textContent = `${percent}%`;
    if (state.zoomDockValue) state.zoomDockValue.textContent = `${percent}%`;
    if (state.zoomRange) state.zoomRange.value = String(percent);
  };

  const setNodeTransform = (element, node) => {
    element.style.transform = `translate3d(${node.x}px, ${node.y}px, 0)`;
  };

  const syncLinks = () => {
    if (!state.links) return;
    state.links.replaceChildren();
    const sources = state.nodes.filter((node) => node.kind === "image");
    const destination = state.nodes.find((node) => node.kind === "prompt") || state.nodes.find((node) => node.kind === "output");
    if (!destination) return;
    const target = nodeSize(destination);
    for (const source of sources) {
      const size = nodeSize(source);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const x1 = source.x + size.width;
      const y1 = source.y + size.height / 2;
      const x2 = destination.x;
      const y2 = destination.y + target.height / 2;
      const bend = Math.max(48, Math.abs(x2 - x1) * .42);
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
      state.links.append(path);
    }
  };

  const applyPromptToGenerationPanel = (node, generate) => {
    const textarea = Array.from(document.querySelectorAll('[role="dialog"] textarea'))
      .find((candidate) => !candidate.closest(".guan-canvas-node")
        && (candidate.getAttribute("aria-label") === "商品卖点 & 要求"
          || /建议提供以下信息/.test(candidate.getAttribute("placeholder") || "")))
      || Array.from(document.querySelectorAll('[role="dialog"] textarea'))
        .find((candidate) => !candidate.closest(".guan-canvas-node"));
    if (!textarea) {
      showToast("右侧生成面板尚未加载");
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(textarea, node.text || "");
    else textarea.value = node.text || "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    showToast(generate ? "提示词已应用，开始生成" : "提示词已应用到右侧面板");
    if (generate) {
      const button = Array.from(document.querySelectorAll('[role="dialog"] button[type="submit"]'))
        .find((candidate) => /生成详情页/.test(candidate.textContent || ""));
      button?.click();
    }
  };

  const removeNode = (nodeId) => {
    const index = state.nodes.findIndex((node) => node.id === nodeId);
    if (index < 0) return;
    state.nodes.splice(index, 1);
    const element = state.nodeElements.get(nodeId);
    element?.remove();
    state.nodeElements.delete(nodeId);
    state.selectedNodeIds.delete(nodeId);
    pushHistory();
    persist();
    syncLinks();
    updateEmptyState();
    showToast("节点已移除");
  };

  const createNodeElement = (node) => {
    const element = document.createElement("article");
    element.className = "guan-canvas-node";
    element.dataset.id = node.id;
    element.dataset.kind = node.kind;
    element.tabIndex = 0;
    setNodeTransform(element, node);

    const head = document.createElement("div");
    head.className = "guan-canvas-node-head";
    const title = document.createElement("div");
    title.className = "guan-canvas-node-title";
    const type = document.createElement("span");
    type.className = "guan-canvas-node-type";
    type.textContent = node.kind === "image" ? "▧" : node.kind === "prompt" ? "✦" : "◈";
    const label = document.createElement("span");
    label.textContent = node.kind === "image" ? "商品原图" : node.kind === "prompt" ? "提示词" : "生成结果";
    title.append(type, label);
    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "guan-canvas-node-menu";
    menu.setAttribute("aria-label", "移除节点");
    menu.title = "移除节点";
    menu.textContent = "⋯";
    menu.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeNode(node.id);
    });
    head.append(title, menu);
    element.append(head);

    const body = document.createElement("div");
    body.className = "guan-canvas-node-body";
    if (node.kind === "image") {
      const preview = document.createElement("div");
      preview.className = "guan-canvas-image-preview";
      const file = getImageFiles().find((candidate) => fileKey(candidate) === node.fileKey);
      if (file) {
        const image = document.createElement("img");
        image.src = state.imageUrls.get(node.fileKey) || URL.createObjectURL(file);
        if (!state.imageUrls.has(node.fileKey)) state.imageUrls.set(node.fileKey, image.src);
        image.alt = file.name;
        preview.append(image);
      } else {
        preview.textContent = "等待图片";
      }
      const meta = document.createElement("div");
      meta.className = "guan-canvas-image-meta";
      const name = document.createElement("span");
      name.textContent = node.fileName || "未选择图片";
      name.title = node.fileName || "未选择图片";
      const chip = document.createElement("span");
      chip.className = "guan-canvas-chip";
      chip.textContent = "输入";
      meta.append(name, chip);
      body.append(preview, meta);
    } else if (node.kind === "prompt") {
      const textarea = document.createElement("textarea");
      textarea.value = node.text || "";
      textarea.placeholder = "描述产品、场景和画面要求…";
      textarea.setAttribute("aria-label", "画布提示词");
      textarea.addEventListener("input", () => {
        node.text = textarea.value;
        persist();
      });
      const actions = document.createElement("div");
      actions.className = "guan-canvas-prompt-actions";
      const apply = createButton("应用到面板", "apply-prompt");
      apply.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyPromptToGenerationPanel(node, false);
      });
      const generate = createButton("生成", "generate", "guan-canvas-button primary");
      generate.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyPromptToGenerationPanel(node, true);
      });
      actions.append(apply, generate);
      body.append(textarea, actions);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "guan-canvas-output-placeholder";
      placeholder.textContent = "生成结果会显示在这里";
      const meta = document.createElement("div");
      meta.className = "guan-canvas-output-meta";
      meta.innerHTML = "<span>等待生成</span><span class=\"guan-canvas-chip\">输出</span>";
      body.append(placeholder, meta);
    }
    element.append(body);

    element.addEventListener("click", (event) => {
      if (!event.shiftKey && !event.metaKey && !event.ctrlKey) state.selectedNodeIds.clear();
      state.selectedNodeIds.add(node.id);
      syncToolState();
    });
    element.addEventListener("pointerdown", (event) => startNodeDrag(event, node, element));
    element.addEventListener("keydown", (event) => {
      if (event.key === "Delete" || event.key === "Backspace") {
        if (event.target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        removeNode(node.id);
      }
    });
    return element;
  };

  const renderNodes = () => {
    if (!state.world) return;
    state.nodeElements.forEach((element) => element.remove());
    state.nodeElements.clear();
    for (const node of state.nodes) {
      const element = createNodeElement(node);
      state.world.append(element);
      state.nodeElements.set(node.id, element);
    }
    setWorldTransform();
    syncLinks();
    updateEmptyState();
  };

  const updateEmptyState = () => {
    if (state.empty) state.empty.hidden = state.nodes.length > 0;
  };

  const addPromptNode = () => {
    const imageCount = state.nodes.filter((node) => node.kind === "image").length;
    const node = {
      id: newId("prompt"),
      kind: "prompt",
      x: imageCount ? 390 : 160,
      y: 145 + Math.min(imageCount, 3) * 18,
      text: "",
      fileKey: "",
      fileName: "",
    };
    state.nodes.push(node);
    pushHistory();
    persist();
    renderNodes();
    state.nodeElements.get(node.id)?.classList.add("is-selected");
    state.nodeElements.get(node.id)?.querySelector("textarea")?.focus();
    renderSourcePanel();
    showToast("已添加提示词节点");
  };

  const triggerUpload = () => {
    const input = document.querySelector('[role="dialog"] input[type="file"][aria-label="上传图片"]');
    if (!input) {
      showToast("上传入口尚未加载");
      return;
    }
    input.click();
  };

  const syncFiles = () => {
    const files = getImageFiles();
    const keys = new Set(files.map(fileKey));
    const imageNodes = state.nodes.filter((node) => node.kind === "image");
    const hadImages = imageNodes.length > 0;
    for (const node of imageNodes) {
      if (!keys.has(node.fileKey)) {
        state.imageUrls.get(node.fileKey) && URL.revokeObjectURL(state.imageUrls.get(node.fileKey));
        state.imageUrls.delete(node.fileKey);
        state.nodes = state.nodes.filter((candidate) => candidate.id !== node.id);
      }
    }
    const existing = new Set(state.nodes.filter((node) => node.kind === "image").map((node) => node.fileKey));
    files.forEach((file, index) => {
      const key = fileKey(file);
      if (existing.has(key)) {
        const node = state.nodes.find((candidate) => candidate.kind === "image" && candidate.fileKey === key);
        if (node) node.fileName = file.name;
        return;
      }
      state.nodes.unshift({
        id: newId("image"),
        kind: "image",
        fileKey: key,
        fileName: file.name,
        x: 62 + (index % 2) * 292,
        y: 86 + Math.floor(index / 2) * 272,
        text: "",
      });
    });
    if (files.length || hadImages) {
      persist();
      if (!hadImages && files.length) pushHistory();
      renderNodes();
      renderSourcePanel();
    }
  };

  const fitView = () => {
    if (!state.viewport) return;
    if (!state.nodes.length) {
      state.view = { x: 34, y: 30, scale: .86 };
      setWorldTransform();
      return;
    }
    const bounds = state.nodes.reduce((result, node) => {
      const size = nodeSize(node);
      result.minX = Math.min(result.minX, node.x);
      result.minY = Math.min(result.minY, node.y);
      result.maxX = Math.max(result.maxX, node.x + size.width);
      result.maxY = Math.max(result.maxY, node.y + size.height);
      return result;
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const availableWidth = Math.max(280, state.viewport.clientWidth - 90);
    const availableHeight = Math.max(240, state.viewport.clientHeight - 90);
    const scale = clamp(Math.min(1.12, availableWidth / width, availableHeight / height), MIN_SCALE, 1.12);
    state.view.scale = scale;
    state.view.x = (state.viewport.clientWidth - width * scale) / 2 - bounds.minX * scale;
    state.view.y = (state.viewport.clientHeight - height * scale) / 2 - bounds.minY * scale;
    setWorldTransform();
  };

  const changeZoom = (factor, clientX, clientY) => {
    if (!state.viewport) return;
    const rect = state.viewport.getBoundingClientRect();
    const px = Number.isFinite(clientX) ? clientX - rect.left : state.viewport.clientWidth / 2;
    const py = Number.isFinite(clientY) ? clientY - rect.top : state.viewport.clientHeight / 2;
    const worldX = (px - state.view.x) / state.view.scale;
    const worldY = (py - state.view.y) / state.view.scale;
    const scale = clamp(state.view.scale * factor, MIN_SCALE, MAX_SCALE);
    state.view.scale = scale;
    state.view.x = px - worldX * scale;
    state.view.y = py - worldY * scale;
    setWorldTransform();
  };

  const startNodeDrag = (event, node, element) => {
    if (state.panMode || event.button !== 0 || event.target.closest("button, textarea, input, select")) return;
    event.preventDefault();
    event.stopPropagation();
    element.setPointerCapture?.(event.pointerId);
    element.classList.add("is-dragging", "is-selected");
    state.nodeElements.forEach((candidate, id) => candidate.classList.toggle("is-selected", id === node.id));
    state.drag = {
      node,
      element,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
    };
    const move = (moveEvent) => {
      const drag = state.drag;
      if (!drag || moveEvent.pointerId !== drag.pointerId) return;
      node.x = drag.nodeX + (moveEvent.clientX - drag.startX) / state.view.scale;
      node.y = drag.nodeY + (moveEvent.clientY - drag.startY) / state.view.scale;
      setNodeTransform(element, node);
      syncLinks();
    };
    const stop = (stopEvent) => {
      if (!state.drag || stopEvent.pointerId !== state.drag.pointerId) return;
      element.releasePointerCapture?.(stopEvent.pointerId);
      element.classList.remove("is-dragging");
      state.drag = null;
      pushHistory();
      persist();
      syncLinks();
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", stop);
      element.removeEventListener("pointercancel", stop);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", stop);
    element.addEventListener("pointercancel", stop);
  };

  const bindRootEvents = (root) => {
    root.addEventListener("change", (event) => {
      const input = event.target instanceof HTMLInputElement ? event.target : null;
      if (input?.dataset.action === "image-info") state.imageInfo = input.checked;
    });
    root.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
      if (!button) return;
      const action = button.dataset.action;
      if (action === "add-image" || action === "upload") triggerUpload();
      if (action === "add-prompt") addPromptNode();
      if (action === "toggle-side-panel") { state.sidePanelOpen = !state.sidePanelOpen; renderSourcePanel(); syncCanvasChrome(); }
      if (action === "toggle-menu") { state.menuOpen = !state.menuOpen; if (state.sourceMenu) state.sourceMenu.hidden = !state.menuOpen; }
      if (action === "switch-panel-tab") { state.sidePanelTab = button.dataset.tab || "canvas"; renderSourcePanel(); }
      if (action === "select-all") { state.selectedNodeIds = new Set(state.nodes.map((node) => node.id)); syncToolState(); }
      if (action === "export-canvas") {
        const blob = new Blob([JSON.stringify({ version: 1, nodes: state.nodes }, null, 2)], { type: "application/json" });
        const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${state.productId || "canvas"}.json`; link.click(); URL.revokeObjectURL(link.href); showToast("画布已导出");
      }
      if (action === "fit") fitView();
      if (action === "reset-view") {
        state.view = { x: 34, y: 30, scale: .86 };
        setWorldTransform();
      }
      if (action === "zoom-in") changeZoom(1.12);
      if (action === "zoom-out") changeZoom(.89);
      if (action === "toggle-pan") {
        state.canvasTool = state.canvasTool === "pan" ? "select" : "pan";
        state.panMode = state.canvasTool === "pan";
        syncToolState();
        showToast(state.canvasTool === "pan" ? "已切换平移工具" : "已切换选择工具");
      }
      if (action === "toggle-appearance") {
        state.appearanceOpen = !state.appearanceOpen;
        root.classList.toggle("is-appearance-open", state.appearanceOpen);
        if (state.appearance) state.appearance.hidden = !state.appearanceOpen;
        if (state.appearanceOpen) showToast("外观：再次点击切换网格");
      }
      if (action === "theme-light") document.querySelector(".local-workbench-theme-button")?.click();
      if (action === "theme-dark") document.querySelector(".local-workbench-theme-button")?.click();
      if (action === "grid-dots" || action === "grid-lines" || action === "grid-blank") {
        state.gridMode = action.replace("grid-", ""); root.dataset.gridMode = state.gridMode;
      }
      if (action === "image-info" && button instanceof HTMLInputElement) state.imageInfo = button.checked;
      if (action === "toggle-grid") {
        const modes = ["dots", "lines", "blank"];
        state.gridMode = modes[(modes.indexOf(state.gridMode) + 1) % modes.length];
        root.dataset.gridMode = state.gridMode;
        showToast(state.gridMode === "dots" ? "网格：点" : state.gridMode === "lines" ? "网格：线" : "网格：空白");
      }
      if (action === "shortcuts") showToast("空格 + 拖动平移，滚轮缩放，⌘/Ctrl + 0 适应画布");
      if (action === "undo") undo();
      if (action === "redo") redo();
      if (action === "unsupported") showToast("该工具将在后续版本开放");
      if (action === "clear") {
        if (!state.nodes.length || window.confirm("清空画布上的全部节点吗？已上传图片不会被删除。")) {
          state.nodes = [];
          state.selectedNodeIds.clear();
          pushHistory();
          persist();
          renderNodes();
          renderSourcePanel();
          showToast("画布已清空");
        }
      }
    });

    const viewport = state.viewport;
    viewport.addEventListener("pointerdown", (event) => {
      const temporaryPan = event.ctrlKey || event.metaKey || event.code === "Space" || state.panMode;
      if ((event.button !== 0 && event.button !== 1)
        || event.target.closest(".guan-canvas-node, .guan-canvas-tool-dock, .guan-canvas-zoom-dock, button, input, textarea, select")) return;
      if (event.button === 0 && !temporaryPan) {
        state.selectedNodeIds.clear();
        syncToolState();
        return;
      }
      event.preventDefault();
      viewport.setPointerCapture?.(event.pointerId);
      viewport.classList.add("is-panning");
      state.pan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewX: state.view.x,
        viewY: state.view.y,
      };
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!state.pan || event.pointerId !== state.pan.pointerId) return;
      state.view.x = state.pan.viewX + event.clientX - state.pan.startX;
      state.view.y = state.pan.viewY + event.clientY - state.pan.startY;
      setWorldTransform();
    });
    const stopPan = (event) => {
      if (!state.pan || event.pointerId !== state.pan.pointerId) return;
      viewport.releasePointerCapture?.(event.pointerId);
      viewport.classList.remove("is-panning");
      state.pan = null;
    };
    viewport.addEventListener("pointerup", stopPan);
    viewport.addEventListener("pointercancel", stopPan);
    viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.08 : .925;
      changeZoom(factor, event.clientX, event.clientY);
    }, { passive: false });
    window.addEventListener("resize", () => {
      if (state.nodes.length === 0) setWorldTransform();
      syncCanvasChrome();
    }, { passive: true });
    window.addEventListener("local-workbench-images-change", syncFiles);
      window.addEventListener("keydown", (event) => {
      if (event.code === "Space" && !event.repeat && !event.target.matches("input,textarea")) { state.panMode = true; }
      if (event.key === "Escape" && state.drag) state.drag = null;
      if ((event.metaKey || event.ctrlKey) && event.key === "0") {
        event.preventDefault();
        fitView();
      }
    });
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space") { state.panMode = state.canvasTool === "pan"; }
    });
  };

  const unmount = () => {
    if (!state.root) return;
    if (state.originalPreview?.parentElement == null && state.root.parentElement) {
      state.root.replaceWith(state.originalPreview || document.createElement("div"));
    } else if (state.originalPreview && state.root.parentElement) {
      state.root.replaceWith(state.originalPreview);
    }
    state.root = null;
    state.viewport = null;
    state.world = null;
    state.links = null;
    state.empty = null;
    state.zoomValue = null;
    state.zoomDockValue = null;
    state.zoomRange = null;
    state.toast = null;
    state.title = null;
    state.productId = "";
    state.canvasIntro?.classList.remove("guan-canvas-intro");
    state.carouselNav?.classList.remove("guan-canvas-carousel-nav");
    state.chromeHeader?.classList.remove("guan-canvas-ui-layer");
    state.uiLayers.forEach((element) => element.classList.remove("guan-canvas-ui-layer"));
    state.canvasIntro = null;
    state.carouselNav = null;
    state.chromeHeader = null;
    state.uiLayers = [];
    state.canvasHost?.classList.remove("guan-canvas-host");
    state.canvasLayoutHost?.classList.remove("guan-canvas-layout-host");
    if (state.canvasLayoutHost && state.canvasLayoutParent && state.canvasLayoutHost.parentElement !== state.canvasLayoutParent) {
      const nextSibling = state.canvasLayoutNextSibling;
      if (nextSibling?.parentElement === state.canvasLayoutParent) {
        state.canvasLayoutParent.insertBefore(state.canvasLayoutHost, nextSibling);
      } else {
        state.canvasLayoutParent.appendChild(state.canvasLayoutHost);
      }
    }
    state.canvasHost = null;
    state.canvasLayoutHost = null;
    state.canvasLayoutParent = null;
    state.canvasLayoutNextSibling = null;
    state.canvasSidePanel = null;
    state.panMode = false;
    state.canvasTool = "select";
    state.selectedNodeIds.clear();
    state.history = [];
    state.historyIndex = -1;
    state.gridMode = "dots";
    document.body.classList.remove("guan-canvas-mode");
    document.documentElement.style.removeProperty("--guan-canvas-top");
    state.nodes = [];
    state.nodeElements.clear();
    state.originalPreview = null;
  };

  const canvasRow = () => {
    let element = state.root;
    for (let depth = 0; element && depth < 8; depth += 1, element = element.parentElement) {
      if (String(element.className || "").includes("flex-row")) return element;
    }
    return null;
  };

  const syncCanvasChrome = () => {
    if (!state.root) return;
    document.body.classList.add("guan-canvas-mode");
    const dialog = document.querySelector('[role="dialog"]');
    const appShell = dialog?.children?.[2];
    const header = appShell?.children?.[0] || null;
    const headerRect = header?.getBoundingClientRect?.();
    const top = Math.max(0, Math.round(headerRect?.bottom || 84));
    const currentTop = document.documentElement.style.getPropertyValue("--guan-canvas-top");
    if (currentTop !== `${top}px`) document.documentElement.style.setProperty("--guan-canvas-top", `${top}px`);

    if (header && state.chromeHeader !== header) {
      state.chromeHeader?.classList.remove("guan-canvas-ui-layer");
      state.chromeHeader = header;
      header.classList.add("guan-canvas-ui-layer");
    }

    const heading = Array.from(document.querySelectorAll("h1, h2, h3"))
      .find((candidate) => candidate.textContent?.trim() === "A+ 详情页");
    const intro = heading?.parentElement || null;
    if (intro && state.canvasIntro !== intro) {
      state.canvasIntro?.classList.remove("guan-canvas-intro");
      state.canvasIntro = intro;
      intro.classList.add("guan-canvas-intro");
    }

    const carouselNav = document.querySelector('[aria-label="轮播图导航"]');
    if (carouselNav && state.carouselNav !== carouselNav) {
      state.carouselNav?.classList.remove("guan-canvas-carousel-nav");
      state.carouselNav = carouselNav;
      carouselNav.classList.add("guan-canvas-carousel-nav");
    }

    const row = canvasRow();
    const sidePanel = state.canvasSidePanel || row?.children?.[1] || null;
    const sideRect = sidePanel?.getBoundingClientRect?.();
    const sideOffset = sideRect && sideRect.width > 0 && sideRect.left < window.innerWidth
      ? Math.max(0, window.innerWidth - sideRect.left)
      : 0;
    state.root.style.setProperty("--guan-canvas-side-offset", `${Math.round(sideOffset)}px`);
    state.root.style.setProperty("--guan-canvas-panel-width", state.sidePanelOpen ? "310px" : "0px");
    const fixedControls = Array.from(document.querySelectorAll(
      '[data-local-fixed="true"], .local-workbench-theme-button, .local-workbench-settings-button',
    ));
    const nextLayers = [sidePanel, ...fixedControls].filter(Boolean);
    state.uiLayers.forEach((element) => {
      if (!nextLayers.includes(element)) element.classList.remove("guan-canvas-ui-layer");
    });
    nextLayers.forEach((element) => element.classList.add("guan-canvas-ui-layer"));
    state.uiLayers = nextLayers;
    state.canvasSidePanel?.classList.add("guan-canvas-ui-layer");
  };

  const refreshMode = () => {
    const activeProduct = getActiveProduct();
    if (!activeProduct) {
      unmount();
      return false;
    }

    const existingCanvas = document.querySelector('[data-local-canvas-v1="true"]');
    if (existingCanvas && state.root !== existingCanvas) state.root = existingCanvas;
    if (!state.root || !document.contains(state.root)) {
      const preview = document.querySelector('[aria-label="轮播模板预览"]');
      if (!preview || !preview.parentElement) return false;
      state.originalPreview ||= preview;
      state.canvasHost = preview.parentElement;
      state.canvasLayoutHost = state.canvasHost.parentElement;
      state.canvasLayoutParent = state.canvasLayoutHost?.parentElement || null;
      state.canvasLayoutNextSibling = state.canvasLayoutHost?.nextSibling || null;
      state.canvasSidePanel = canvasRow()?.children?.[1] || null;
      state.canvasHost.classList.add("guan-canvas-host");
      state.canvasLayoutHost?.classList.add("guan-canvas-layout-host");
      state.productId = activeProduct.id;
      state.nodes = loadNodes();
      const root = buildRoot();
      preview.replaceWith(root);
      state.canvasSidePanel = canvasRow()?.children?.[1] || state.canvasSidePanel;
      const dialog = document.querySelector('[role="dialog"]');
      if (state.canvasLayoutHost && dialog && state.canvasLayoutHost.parentElement !== dialog) {
        dialog.appendChild(state.canvasLayoutHost);
      }
      syncCanvasChrome();
      syncFiles();
      renderNodes();
      resetHistory();
      renderSourcePanel();
      if (state.nodes.length) fitView();
      setWorldTransform();
      return true;
    }

    if (state.productId !== activeProduct.id) {
      state.productId = activeProduct.id;
      state.view = { x: 34, y: 30, scale: 0.86 };
      state.nodes = loadNodes();
      syncProductHeading();
      syncCanvasChrome();
      syncFiles();
      renderNodes();
      resetHistory();
      renderSourcePanel();
      if (state.nodes.length) fitView();
      else setWorldTransform();
    } else {
      syncProductHeading();
      syncCanvasChrome();
    }
    return true;
  };

  const observer = new MutationObserver(() => {
    refreshMode();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("guan-data-contract-change", () => window.requestAnimationFrame(refreshMode));
  window.addEventListener("guan-active-product-set-change", () => window.requestAnimationFrame(refreshMode));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refreshMode, { once: true });
  else refreshMode();

  window.__guanCanvas = {
    addPrompt: addPromptNode,
    fit: fitView,
    reset: () => {
      state.nodes = [];
      persist();
      renderNodes();
    },
  };
})();
