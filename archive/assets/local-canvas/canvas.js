(() => {
  "use strict";

  const STORAGE_KEY = "guan-ai-workbench-canvas-v1";
  const MAX_SCALE = 1.45;
  const MIN_SCALE = 0.45;
  const state = {
    root: null,
    viewport: null,
    world: null,
    links: null,
    empty: null,
    zoomValue: null,
    toast: null,
    nodes: [],
    nodeElements: new Map(),
    imageUrls: new Map(),
    productId: "",
    originalPreview: null,
    canvasHost: null,
    canvasLayoutHost: null,
    view: { x: 34, y: 30, scale: 0.86 },
    loaded: false,
    pan: null,
    drag: null,
    toastTimer: 0,
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
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "工作画布");

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

    const toolbar = document.createElement("div");
    toolbar.className = "guan-canvas-toolbar";
    toolbar.append(
      createButton("＋ 图片", "add-image", "guan-canvas-button primary"),
      createButton("＋ 提示词", "add-prompt"),
      document.createElement("span"),
      createButton("适应画布", "fit"),
      createButton("清空", "clear"),
    );
    toolbar.children[2].className = "guan-canvas-toolbar-divider";
    const zoom = document.createElement("span");
    zoom.className = "guan-canvas-zoom";
    zoom.append(
      createButton("−", "zoom-out", "guan-canvas-icon-button"),
      Object.assign(document.createElement("span"), { className: "guan-canvas-zoom-value", textContent: "86%" }),
      createButton("＋", "zoom-in", "guan-canvas-icon-button"),
    );
    toolbar.append(zoom);
    header.append(title, toolbar);

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

    const toast = document.createElement("div");
    toast.className = "guan-canvas-toast";
    toast.setAttribute("role", "status");
    viewport.append(toast);

    root.append(header, viewport);
    state.root = root;
    state.viewport = viewport;
    state.world = world;
    state.links = links;
    state.empty = empty;
    state.zoomValue = zoom.querySelector(".guan-canvas-zoom-value");
    state.toast = toast;
    state.title = title;
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

  const setWorldTransform = () => {
    if (!state.world) return;
    state.world.style.transform = `translate3d(${state.view.x}px, ${state.view.y}px, 0) scale(${state.view.scale})`;
    if (state.zoomValue) state.zoomValue.textContent = `${Math.round(state.view.scale * 100)}%`;
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

    element.addEventListener("click", () => {
      state.nodeElements.forEach((candidate, id) => candidate.classList.toggle("is-selected", id === node.id));
      element.classList.add("is-selected");
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
    persist();
    renderNodes();
    state.nodeElements.get(node.id)?.classList.add("is-selected");
    state.nodeElements.get(node.id)?.querySelector("textarea")?.focus();
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
      renderNodes();
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
    if (event.button !== 0 || event.target.closest("button, textarea, input, select")) return;
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
    root.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
      if (!button) return;
      const action = button.dataset.action;
      if (action === "add-image") triggerUpload();
      if (action === "add-prompt") addPromptNode();
      if (action === "fit") fitView();
      if (action === "zoom-in") changeZoom(1.12);
      if (action === "zoom-out") changeZoom(.89);
      if (action === "clear") {
        if (!state.nodes.length || window.confirm("清空画布上的全部节点吗？已上传图片不会被删除。")) {
          state.nodes = [];
          persist();
          renderNodes();
          showToast("画布已清空");
        }
      }
    });

    const viewport = state.viewport;
    viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".guan-canvas-node")) return;
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
    }, { passive: true });
    window.addEventListener("local-workbench-images-change", syncFiles);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.drag) state.drag = null;
      if ((event.metaKey || event.ctrlKey) && event.key === "0") {
        event.preventDefault();
        fitView();
      }
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
    state.toast = null;
    state.title = null;
    state.productId = "";
    state.canvasHost?.classList.remove("guan-canvas-host");
    state.canvasLayoutHost?.classList.remove("guan-canvas-layout-host");
    state.canvasHost = null;
    state.canvasLayoutHost = null;
    state.nodes = [];
    state.nodeElements.clear();
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
      state.canvasHost.classList.add("guan-canvas-host");
      state.canvasLayoutHost?.classList.add("guan-canvas-layout-host");
      state.productId = activeProduct.id;
      state.nodes = loadNodes();
      const root = buildRoot();
      preview.replaceWith(root);
      syncFiles();
      renderNodes();
      if (state.nodes.length) fitView();
      setWorldTransform();
      return true;
    }

    if (state.productId !== activeProduct.id) {
      state.productId = activeProduct.id;
      state.view = { x: 34, y: 30, scale: 0.86 };
      state.nodes = loadNodes();
      syncProductHeading();
      syncFiles();
      renderNodes();
      if (state.nodes.length) fitView();
      else setWorldTransform();
    } else {
      syncProductHeading();
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
