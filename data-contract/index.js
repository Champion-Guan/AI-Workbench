const STORAGE_KEY = "guan-workbench:data-contract:v1";
const CHANGE_EVENT = "guan-data-contract-change";
const ACTIVE_PRODUCT_SET_EVENT = "guan-active-product-set-change";
const CONTRACT_SCHEMA = "guan-workbench.v1";
const PURPOSE_ORDER = ["product-main", "product-secondary", "product-detail", "product-a-plus", "product-video", "custom"];
const DEFAULT_SLOT_COUNTS = { main: 1, secondary: 10, detail: 6 };
const MAX_IMPORT_ROWS = 10000;
const MAX_IMPORT_COLUMNS = 200;
// The real product workbooks used by the operators include embedded images
// and are commonly larger than 25 MiB. Keep a generous client-side guard so
// import remains local while still preventing accidental multi-hundred-MiB
// files from exhausting the browser tab.
const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;
const COMPRESSED_STORAGE_PREFIX = "guan-workbench-compressed-v1:";
let pendingExcelImport = null;
let activeExcelDeleteDialog = null;

function timestamp() {
  return new Date().toISOString();
}

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeStoredState(state) {
  const json = JSON.stringify(state);
  const compressor = globalThis.fflate;
  if (json.length < 50000 || !compressor?.compressSync || !compressor?.strToU8) return json;
  const compressed = compressor.compressSync(compressor.strToU8(json), { level: 6 });
  return `${COMPRESSED_STORAGE_PREFIX}${bytesToBase64(compressed)}`;
}

function decodeStoredState(stored) {
  if (!stored.startsWith(COMPRESSED_STORAGE_PREFIX)) return JSON.parse(stored);
  const compressor = globalThis.fflate;
  if (!compressor?.decompressSync || !compressor?.strFromU8) {
    throw new Error("本地合同数据已压缩，但压缩解码器没有加载。请刷新页面后重试。");
  }
  const encoded = stored.slice(COMPRESSED_STORAGE_PREFIX.length);
  return JSON.parse(compressor.strFromU8(compressor.decompressSync(base64ToBytes(encoded))));
}

function createEmptyState() {
  const now = timestamp();
  return {
    schema: CONTRACT_SCHEMA,
    version: 1,
    workspace: {
      id: createId("ws"),
      name: "AI 生图工作台",
      locale: "zh-CN",
      platform: "Wildberries",
      language: "ru",
      storageMode: "local-only",
      activeProductSetId: null,
      createdAt: now,
      updatedAt: now,
    },
    productSets: [],
    products: [],
    importRecords: [],
    slots: [],
    prompts: [],
    tasks: [],
    runs: [],
    providerAttempts: [],
    assets: [],
  };
}

function assertOptionalRecord(value, label) {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error(`${label} 必须是对象，未覆盖原始数据`);
  }
}

function normalizeState(value) {
  const empty = createEmptyState();
  if (!value || typeof value !== "object") throw new Error("合同数据必须是对象，未写入任何内容");
  const source = clone(value);
  if (source.schema !== CONTRACT_SCHEMA) throw new Error(`不支持的数据合同版本：${String(source.schema || "未知")}。为保护原数据，本次操作已停止。`);
  assertOptionalRecord(source.workspace, "Workspace");
  const collectionNames = [
    "productSets",
    "products",
    "importRecords",
    "slots",
    "prompts",
    "tasks",
    "runs",
    "providerAttempts",
    "assets",
  ];
  for (const name of collectionNames) {
    if (Object.hasOwn(source, name) && !Array.isArray(source[name])) {
      throw new Error(`${name} 必须是数组，未覆盖原始数据`);
    }
    for (const [index, item] of (source[name] || []).entries()) {
      assertOptionalRecord(item, `${name}[${index}]`);
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`${name}[${index}] 必须是对象，未覆盖原始数据`);
      }
    }
  }
  const normalized = {
    ...empty,
    ...source,
    workspace: { ...empty.workspace, ...(source.workspace || {}) },
    productSets: Array.isArray(source.productSets) ? source.productSets : [],
    products: Array.isArray(source.products) ? source.products : [],
    importRecords: Array.isArray(source.importRecords) ? source.importRecords : [],
    slots: Array.isArray(source.slots) ? source.slots : [],
    prompts: Array.isArray(source.prompts) ? source.prompts : [],
    tasks: Array.isArray(source.tasks) ? source.tasks : [],
    runs: Array.isArray(source.runs) ? source.runs : [],
    providerAttempts: Array.isArray(source.providerAttempts) ? source.providerAttempts : [],
    assets: Array.isArray(source.assets) ? source.assets : [],
  };

  normalized.workspace.id ||= createId("ws");
  for (const set of normalized.productSets) {
    set.id ||= createId("set");
    set.workspaceId ||= normalized.workspace.id;
    assertOptionalRecord(set.source, `ProductSet ${set.id}.source`);
    set.source = set.source && typeof set.source === "object" ? set.source : {};
    set.source.fileName ||= "未命名产品表";
    set.productIds = Array.isArray(set.productIds) ? set.productIds : [];
    set.createdAt ||= timestamp();
    set.updatedAt ||= set.createdAt;
  }
  for (const product of normalized.products) {
    product.id ||= createId("prod");
    product.workspaceId ||= normalized.workspace.id;
    assertOptionalRecord(product.identity, `Product ${product.id}.identity`);
    assertOptionalRecord(product.attributes, `Product ${product.id}.attributes`);
    assertOptionalRecord(product.subjectLock, `Product ${product.id}.subjectLock`);
    product.identity = product.identity && typeof product.identity === "object" ? product.identity : {};
    product.attributes = product.attributes && typeof product.attributes === "object" ? product.attributes : {};
    product.sourceAssets = Array.isArray(product.sourceAssets) ? product.sourceAssets : [];
    product.subjectLock = product.subjectLock && typeof product.subjectLock === "object"
      ? product.subjectLock
      : { enabled: false, referenceAssetIds: [], instruction: "preserve-product-identity" };
    product.subjectLock.referenceAssetIds = Array.isArray(product.subjectLock.referenceAssetIds)
      ? product.subjectLock.referenceAssetIds
      : [];
    product.taskGroupIds = Array.isArray(product.taskGroupIds) ? product.taskGroupIds : [];
    product.order = Number(product.order || 1);
    product.status ||= "draft";
    product.createdAt ||= timestamp();
    product.updatedAt ||= product.createdAt;
  }
  for (const record of normalized.importRecords) {
    record.id ||= createId("imp");
    assertOptionalRecord(record.rawValues, `ImportRecord ${record.id}.rawValues`);
    assertOptionalRecord(record.headerMap, `ImportRecord ${record.id}.headerMap`);
    record.rawValues = record.rawValues && typeof record.rawValues === "object" ? record.rawValues : {};
    record.headerMap = record.headerMap && typeof record.headerMap === "object" ? record.headerMap : {};
    record.importedAt ||= timestamp();
  }
  for (const slot of normalized.slots) {
    slot.id ||= createId("slot");
    slot.sequence = Number(slot.sequence || 1);
    slot.kind = slot.kind === "video" ? "video" : "image";
    slot.purpose = normalizePurpose(slot.purpose);
    slot.displayName ||= slot.slotId || "未命名任务位";
    slot.required = slot.required !== false;
    slot.ratio ||= "1:1";
    slot.resolution = ["1k", "2k", "4k"].includes(slot.resolution) ? slot.resolution : "2k";
  }
  for (const task of normalized.tasks) {
    task.id ||= createId("task");
    task.workspaceId ||= normalized.workspace.id;
    assertOptionalRecord(task.order, `Task ${task.id}.order`);
    assertOptionalRecord(task.settings, `Task ${task.id}.settings`);
    task.order = task.order && typeof task.order === "object" ? task.order : {};
    task.order.productOrder = Number(task.order.productOrder || 1);
    task.order.slotOrder = Number(task.order.slotOrder || 1);
    task.kind = task.kind === "video" ? "video" : "image";
    task.inputAssetIds = Array.isArray(task.inputAssetIds) ? task.inputAssetIds : [];
    task.outputAssetIds = Array.isArray(task.outputAssetIds) ? task.outputAssetIds : [];
    task.settings = task.settings && typeof task.settings === "object" ? task.settings : {};
    task.settings.ratio ||= "1:1";
    task.settings.resolution = ["1k", "2k", "4k"].includes(task.settings.resolution) ? task.settings.resolution : "2k";
    task.settings.count = Math.max(1, Math.floor(Number(task.settings.count) || 1));
    task.settings.format = ["png", "jpeg", "webp"].includes(task.settings.format) ? task.settings.format : "png";
    task.status ||= "draft";
    task.createdAt ||= timestamp();
    task.updatedAt ||= task.createdAt;
  }
  for (const run of normalized.runs) {
    run.id ||= createId("run");
    run.outputAssetIds = Array.isArray(run.outputAssetIds) ? run.outputAssetIds : [];
    run.status ||= "queued";
  }
  for (const attempt of normalized.providerAttempts) {
    attempt.id ||= createId("att");
    attempt.status ||= "queued";
  }
  for (const asset of normalized.assets) {
    asset.id ||= createId("asset");
    asset.workspaceId ||= normalized.workspace.id;
    asset.kind = ["image", "video", "audio", "psd", "zip", "mask", "other"].includes(asset.kind) ? asset.kind : "other";
    assertOptionalRecord(asset.file, `Asset ${asset.id}.file`);
    assertOptionalRecord(asset.lineage, `Asset ${asset.id}.lineage`);
    asset.file = asset.file && typeof asset.file === "object" ? asset.file : {};
    asset.file.storageKey ||= `asset:${asset.id}`;
    asset.file.downloadName ||= asset.file.originalName || asset.id;
    asset.file.mimeType ||= asset.kind === "video" ? "video/mp4" : "image/png";
    asset.lineage = asset.lineage && typeof asset.lineage === "object"
      ? asset.lineage
      : { parentAssetIds: [], sourceTaskId: asset.taskId, operation: "generate" };
    asset.lineage.parentAssetIds = Array.isArray(asset.lineage.parentAssetIds) ? asset.lineage.parentAssetIds : [];
    asset.lineage.operation ||= "generate";
    asset.status ||= "available";
    asset.createdAt ||= timestamp();
    asset.updatedAt ||= asset.createdAt;
  }

  const productById = new Map(normalized.products.map((product) => [product.id, product]));
  const productSetById = new Map(normalized.productSets.map((set) => [set.id, set]));
  const importRecordById = new Map(normalized.importRecords.map((record) => [record.id, record]));
  if (normalized.workspace.activeProductSetId && !productSetById.has(normalized.workspace.activeProductSetId)) {
    normalized.workspace.activeProductSetId = null;
  }
  if (!normalized.workspace.activeProductSetId && normalized.productSets.length) {
    normalized.workspace.activeProductSetId = normalized.productSets
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0].id;
  }

  // ProductSet.productIds is a derived index; rebuild it from each Product's
  // authoritative productSetId so stale index entries cannot break migration.
  for (const set of normalized.productSets) set.productIds = [];
  for (const product of normalized.products) {
    const set = productSetById.get(product.productSetId);
    if (!product.importRecordId || !importRecordById.has(product.importRecordId)) {
      const record = {
        id: product.importRecordId || createId("imp"),
        productSetId: product.productSetId,
        sourceRowNumber: Number(product.sourceRowNumber || product.order + 1),
        sourceRowKey: `${product.productSetId}:row:${Number(product.sourceRowNumber || product.order + 1)}`,
        headerMap: {},
        rawValues: product.attributes && typeof product.attributes === "object" ? clone(product.attributes) : {},
        importedAt: product.createdAt || timestamp(),
      };
      normalized.importRecords.push(record);
      product.importRecordId = record.id;
      importRecordById.set(record.id, record);
    }
    if (set) set.productIds.push(product.id);
  }

  // Older contract drafts stored attempts inline on each run. Promote those
  // objects to the normalized workspace-level ProviderAttempt collection.
  for (const run of normalized.runs) {
    if (!Array.isArray(run.attemptIds)) {
      const inlineAttempts = Array.isArray(run.attempts) ? run.attempts : [];
      run.attemptIds = inlineAttempts.map((attempt) => typeof attempt === "string" ? attempt : attempt?.id).filter(Boolean);
      for (const inlineAttempt of inlineAttempts) {
        if (!inlineAttempt || typeof inlineAttempt !== "object" || !inlineAttempt.id) continue;
        const existing = normalized.providerAttempts.find((attempt) => attempt.id === inlineAttempt.id);
        if (!existing) normalized.providerAttempts.push({ ...inlineAttempt, runId: run.id });
      }
    }
  }

  const slotByTaskKey = new Map(normalized.slots.map((slot) => [`${slot.productId}:${slot.slotId}`, slot]));
  for (const task of normalized.tasks) {
    if (!task.taskGroupId) {
      const product = productById.get(task.productId);
      task.taskGroupId = product?.taskGroupIds[0] || createId("group");
      if (product && !product.taskGroupIds.includes(task.taskGroupId)) product.taskGroupIds.push(task.taskGroupId);
    }
    if (!slotByTaskKey.has(`${task.productId}:${task.slotId}`)) {
      const slotId = task.slotId || "custom-01";
      task.slotId = slotId;
      const migratedSlot = {
        id: createId("slot"),
        slotId,
        productId: task.productId,
        kind: task.kind === "video" ? "video" : "image",
        purpose: normalizePurpose(task.kind === "video" ? "product-video" : "custom"),
        sequence: Number(task.order?.slotOrder || 1),
        displayName: task.slotId,
        required: true,
        ratio: task.settings.ratio || "1:1",
        resolution: task.settings.resolution || "2k",
        createdAt: task.createdAt || timestamp(),
        updatedAt: task.updatedAt || timestamp(),
      };
      normalized.slots.push(migratedSlot);
      slotByTaskKey.set(`${migratedSlot.productId}:${migratedSlot.slotId}`, migratedSlot);
    }
  }
  const runById = new Map(normalized.runs.map((run) => [run.id, run]));
  for (const asset of normalized.assets) {
    const task = normalized.tasks.find((candidate) => candidate.id === asset.taskId);
    if (!asset.slotId && task) asset.slotId = task.slotId;
    if (!asset.runId && task?.activeRunId && runById.has(task.activeRunId)) asset.runId = task.activeRunId;
    if (task && !task.outputAssetIds.includes(asset.id)) task.outputAssetIds.push(asset.id);
    const run = asset.runId ? runById.get(asset.runId) : null;
    if (run && !run.outputAssetIds.includes(asset.id)) run.outputAssetIds.push(asset.id);
  }
  for (const attempt of normalized.providerAttempts) {
    const run = runById.get(attempt.runId);
    if (run && !run.attemptIds.includes(attempt.id)) run.attemptIds.push(attempt.id);
  }
  return normalized;
}

function validateState(state) {
  const uniqueIds = (items, label) => {
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) throw new Error(`${label} 存在重复 ID`);
  };
  for (const [items, label] of [
    [state.productSets, "ProductSet"],
    [state.products, "Product"],
    [state.importRecords, "ImportRecord"],
    [state.slots, "ProductSlot"],
    [state.prompts, "PromptSpec"],
    [state.tasks, "GenerationTask"],
    [state.runs, "GenerationRun"],
    [state.providerAttempts, "ProviderAttempt"],
    [state.assets, "Asset"],
  ]) uniqueIds(items, label);

  const find = (items, id) => items.find((item) => item.id === id);
  for (const set of state.productSets) {
    if (set.workspaceId !== state.workspace.id) throw new Error(`ProductSet ${set.id} 不属于当前 Workspace`);
    for (const productId of set.productIds) {
      if (find(state.products, productId)?.productSetId !== set.id) throw new Error(`ProductSet ${set.id} 的产品关联无效：${productId}`);
    }
  }
  for (const product of state.products) {
    const set = find(state.productSets, product.productSetId);
    const record = find(state.importRecords, product.importRecordId);
    if (product.workspaceId !== state.workspace.id) throw new Error(`Product ${product.id} 不属于当前 Workspace`);
    if (!set || !set.productIds.includes(product.id)) throw new Error(`Product ${product.id} 未正确关联 ProductSet`);
    if (!record || record.productSetId !== set.id) throw new Error(`Product ${product.id} 未正确关联 ImportRecord`);
    if (product.sourceAssets.some((assetId) => !find(state.assets, assetId))) {
      throw new Error(`Product ${product.id} 的来源素材引用无效`);
    }
  }
  for (const slot of state.slots) {
    if (!find(state.products, slot.productId)) throw new Error(`ProductSlot ${slot.slotId} 的 Product 不存在`);
    if (state.slots.some((other) => other !== slot && other.productId === slot.productId && other.slotId === slot.slotId)) {
      throw new Error(`Product ${slot.productId} 存在重复任务位：${slot.slotId}`);
    }
  }
  for (const task of state.tasks) {
    const slot = state.slots.find((candidate) => candidate.productId === task.productId && candidate.slotId === task.slotId);
    const prompt = find(state.prompts, task.promptId);
    const product = find(state.products, task.productId);
    if (!product || product.workspaceId !== task.workspaceId || !slot) throw new Error(`Task ${task.id} 未正确关联 Workspace/Product/Slot`);
    if (!prompt || prompt.productId !== task.productId || prompt.slotId !== task.slotId) throw new Error(`Task ${task.id} 的 PromptSpec 关联无效`);
    if (task.inputAssetIds.some((assetId) => find(state.assets, assetId)?.productId !== task.productId)) {
      throw new Error(`Task ${task.id} 的输入素材必须属于同一个 Product`);
    }
    if (state.tasks.some((other) => other !== task && other.productId === task.productId && other.slotId === task.slotId)) {
      throw new Error(`Product ${task.productId} 的 Slot ${task.slotId} 存在重复 Task`);
    }
    if (task.outputAssetIds.some((assetId) => find(state.assets, assetId)?.taskId !== task.id)) {
      throw new Error(`Task ${task.id} 的 Asset 关联无效`);
    }
    if (task.activeRunId && find(state.runs, task.activeRunId)?.taskId !== task.id) {
      throw new Error(`Task ${task.id} 的 activeRun 关联无效`);
    }
  }
  for (const run of state.runs) {
    const task = find(state.tasks, run.taskId);
    if (!task || task.productId !== run.productId) throw new Error(`Run ${run.id} 未正确关联 Task/Product`);
    if (run.attemptIds.some((attemptId) => find(state.providerAttempts, attemptId)?.runId !== run.id)) {
      throw new Error(`Run ${run.id} 的 ProviderAttempt 关联无效`);
    }
    if (run.outputAssetIds.some((assetId) => find(state.assets, assetId)?.runId !== run.id)) {
      throw new Error(`Run ${run.id} 的 Asset 关联无效`);
    }
  }
  for (const attempt of state.providerAttempts) {
    const run = find(state.runs, attempt.runId);
    if (!run || !run.attemptIds.includes(attempt.id)) throw new Error(`ProviderAttempt ${attempt.id} 的 Run 关联无效`);
  }
  for (const asset of state.assets) {
    const task = find(state.tasks, asset.taskId);
    const run = asset.runId ? find(state.runs, asset.runId) : null;
    if (!task || task.workspaceId !== asset.workspaceId || task.productId !== asset.productId || task.slotId !== asset.slotId) {
      throw new Error(`Asset ${asset.id} 未正确关联 Product/Slot/Task`);
    }
    if (asset.runId && (!run || run.taskId !== task.id || !run.outputAssetIds.includes(asset.id))) {
      throw new Error(`Asset ${asset.id} 的 Run 关联无效`);
    }
    if (!task.outputAssetIds.includes(asset.id)) throw new Error(`Task ${task.id} 未登记 Asset ${asset.id}`);
    if (asset.lineage.parentAssetIds.some((parentId) => !find(state.assets, parentId))) {
      throw new Error(`Asset ${asset.id} 的父素材引用无效`);
    }
  }
  return state;
}

function readState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return createEmptyState();
  let parsed;
  try {
    parsed = decodeStoredState(stored);
  } catch {
    const recoveryKey = quarantineStoredData(stored, "invalid-json");
    throw new Error(`本地合同数据无法解析，原文${recoveryKey ? `已备份到 ${recoveryKey}` : "仍保留在原存储位置"}。为保护原数据，本次操作已停止。`);
  }
  if (parsed?.schema !== CONTRACT_SCHEMA) {
    const recoveryKey = quarantineStoredData(stored, "unsupported-schema");
    throw new Error(`不支持的数据合同版本，原文${recoveryKey ? `已备份到 ${recoveryKey}` : "仍保留在原存储位置"}。为保护原数据，本次操作已停止。`);
  }
  let normalized;
  try {
    normalized = validateState(normalizeState(parsed));
  } catch (error) {
    const recoveryKey = quarantineStoredData(stored, "invalid-contract-data");
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`本地合同数据结构异常（${detail}），原文${recoveryKey ? `已备份到 ${recoveryKey}` : "仍保留在原存储位置"}。为保护原数据，本次操作已停止。`);
  }
  if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
    try {
      localStorage.setItem(STORAGE_KEY, encodeStoredState(normalized));
    } catch {
      throw new Error("本地数据需要升级格式，但浏览器存储空间不足，旧数据未被覆盖。请先释放本地存储空间后重试。");
    }
  }
  return normalized;
}

function publish(state) {
  validateState(state);
  state.workspace.updatedAt = timestamp();
  localStorage.setItem(STORAGE_KEY, encodeStoredState(state));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: clone(state) }));
  return state;
}

function quarantineStoredData(stored, reason) {
  const key = `${STORAGE_KEY}:recovery:${Date.now()}`;
  try {
    localStorage.setItem(key, JSON.stringify({
      kind: "guan-workbench.recovery.v1",
      originalStorageKey: STORAGE_KEY,
      reason,
      capturedAt: timestamp(),
      rawValue: stored,
    }));
    return key;
  } catch {
    return null;
  }
}

function mutate(mutator) {
  const state = readState();
  const result = mutator(state);
  publish(state);
  return result;
}

function requireById(items, id, label) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`${label} 不存在：${id}`);
  return item;
}

function normalizePurpose(value) {
  return PURPOSE_ORDER.includes(value) ? value : "custom";
}

function makePrompt(taskInput, productId, slotId) {
  const sourceText = String(taskInput.promptZh || taskInput.prompt || "").trim();
  const englishText = String(taskInput.promptEn || "").trim();
  const finalText = String(taskInput.finalPrompt || englishText).trim();
  return {
    id: createId("prompt"),
    productId,
    purpose: normalizePurpose(taskInput.purpose),
    slotId,
    revision: 1,
    source: { language: "zh-CN", text: sourceText },
    translation: {
      language: "en",
      text: englishText,
      status: englishText ? "translated" : "pending",
    },
    finalPrompt: {
      language: "en",
      text: finalText,
      visibleBeforeSubmit: true,
    },
    constraints: {
      preserveSubject: taskInput.preserveSubject !== false,
      preserveBrandText: taskInput.preserveBrandText !== false,
      negativePrompt: String(taskInput.negativePrompt || "").trim() || undefined,
    },
    ...(taskInput.variables && typeof taskInput.variables === "object"
      ? { variables: clone(taskInput.variables) }
      : {}),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
}

function getProductSlots(state, productId) {
  return state.slots
    .filter((slot) => slot.productId === productId)
    .sort((a, b) => a.sequence - b.sequence || a.slotId.localeCompare(b.slotId));
}

function getProductTasks(state, productId) {
  return state.tasks
    .filter((task) => task.productId === productId)
    .sort((a, b) => a.order.slotOrder - b.order.slotOrder || a.createdAt.localeCompare(b.createdAt));
}

function getProductAssets(state, productId) {
  return state.assets
    .filter((asset) => asset.productId === productId)
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || (a.outputIndex || 0) - (b.outputIndex || 0));
}

function createProductSetInternal(state, input = {}) {
  const now = timestamp();
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const set = {
    id: createId("set"),
    workspaceId: state.workspace.id,
    source: {
      kind: input.kind || "xlsx",
      fileName: String(input.fileName || "未命名产品表.xlsx"),
      fileSha256: input.fileSha256 || undefined,
      sheetName: input.sheetName || undefined,
      role: input.role || undefined,
      promptSheetName: input.promptSheetName || undefined,
      ...(input.headerMap && typeof input.headerMap === "object"
        ? { headerMap: clone(input.headerMap) }
        : {}),
      ...(Array.isArray(input.promptTemplates) && input.promptTemplates.length
        ? {
            promptTemplates: clone(input.promptTemplates),
            promptTemplateCount: input.promptTemplates.length,
          }
        : {}),
      slotCounts: input.slotCounts && typeof input.slotCounts === "object" ? clone(input.slotCounts) : undefined,
      importedAt: now,
    },
    productIds: [],
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  state.productSets.push(set);
  // The most recently imported workbook is the one the operator is working
  // on.  Keep the selection in the workspace so the header selector survives
  // a refresh and later product/task views can use the same active set.
  state.workspace.activeProductSetId = set.id;

  const slotTemplates = Array.isArray(input.slotTemplates) && input.slotTemplates.length
    ? input.slotTemplates
    : [{ slotId: "main-01", kind: "image", purpose: "product-main", sequence: 1, displayName: "主图 1", required: true, ratio: "1:1", resolution: "2k" }];

  rows.forEach((rowValue, index) => {
    const row = rowValue && typeof rowValue === "object" && !Array.isArray(rowValue) ? rowValue : { value: rowValue ?? "" };
    const sourceRowNumber = Number(input.sourceRowNumbers?.[index] || index + 2);
    const readField = (aliases) => {
      const entries = Object.entries(row);
      const found = entries.find(([key]) => aliases.includes(normalizeHeader(key)));
      return found?.[1];
    };
    const sku = readField(["sku", "商品编码", "货号", "skucode", "商品id", "产品id"]);
    const title = readField(["titlezh", "商品名称", "商品标题", "标题", "名称", "产品名称"]);
    const product = createProductInternal(state, {
      productSetId: set.id,
      sourceRowNumber,
      sourceRowKey: sku
        ? `${set.id}:sku:${String(sku).trim()}:row:${sourceRowNumber}`
        : `${input.fileSha256 || set.id}:row:${sourceRowNumber}`,
      headerMap: input.headerMap,
      sku: sku || undefined,
      titleZh: title || `未命名产品 ${index + 1}`,
      rawValues: row,
      order: index + 1,
      slotTemplates,
      compactImportRecord: true,
    });
    set.productIds.push(product.id);
  });
  set.status = rows.length || (Array.isArray(input.promptTemplates) && input.promptTemplates.length) ? "ready" : "draft";
  set.updatedAt = now;
  return set;
}

function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_\-（）()【】[\]：:]/g, "");
}

function createProductInternal(state, input = {}) {
  const productSet = requireById(state.productSets, input.productSetId, "ProductSet");
  const now = timestamp();
  const importRecordId = createId("imp");
  const sourceRowNumber = Math.max(1, Number(input.sourceRowNumber || productSet.productIds.length + 2));
  const rawValues = input.rawValues && typeof input.rawValues === "object" ? clone(input.rawValues) : {};
  state.importRecords.push({
    id: importRecordId,
    productSetId: productSet.id,
    sourceRowNumber,
    sourceRowKey: String(input.sourceRowKey || `${productSet.id}:row:${sourceRowNumber}`),
    headerMap: input.compactImportRecord ? {} : (input.headerMap && typeof input.headerMap === "object" ? clone(input.headerMap) : {}),
    // The complete row is already retained on Product.attributes. Keeping a
    // second copy here makes large real-world workbooks exceed localStorage.
    rawValues: input.compactImportRecord ? {} : rawValues,
    importedAt: now,
  });
  const product = {
    id: createId("prod"),
    workspaceId: state.workspace.id,
    productSetId: productSet.id,
    importRecordId,
    sourceRowNumber,
    order: Number(input.order || productSet.productIds.length + 1),
    identity: {
      sku: input.sku ? String(input.sku) : undefined,
      externalProductId: input.externalProductId ? String(input.externalProductId) : undefined,
      titleZh: input.titleZh ? String(input.titleZh) : undefined,
      titleRu: input.titleRu ? String(input.titleRu) : undefined,
    },
    attributes: rawValues,
    sourceAssets: Array.isArray(input.sourceAssets) ? [...input.sourceAssets] : [],
    subjectLock: {
      enabled: Boolean(input.subjectLock?.enabled),
      referenceAssetIds: Array.isArray(input.subjectLock?.referenceAssetIds) ? [...input.subjectLock.referenceAssetIds] : [],
      instruction: "preserve-product-identity",
    },
    taskGroupIds: [],
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  state.products.push(product);

  const slots = Array.isArray(input.slotTemplates) ? input.slotTemplates : [];
  for (const template of slots) {
    createSlotInternal(state, product.id, template);
  }
  product.status = slots.length ? "ready" : "draft";
  return product;
}

function createSlotInternal(state, productId, input = {}) {
  const product = requireById(state.products, productId, "Product");
  const slotId = String(input.slotId || `${input.purpose || "custom"}-${Number(input.sequence || 1)}`);
  if (state.slots.some((candidate) => candidate.productId === productId && candidate.slotId === slotId)) {
    throw new Error(`此产品已存在任务位：${slotId}`);
  }
  const now = timestamp();
  const slot = {
    id: createId("slot"),
    slotId,
    productId,
    kind: input.kind === "video" ? "video" : "image",
    purpose: normalizePurpose(input.purpose),
    sequence: Number(input.sequence || 1),
    displayName: String(input.displayName || input.slotId || "未命名任务位"),
    required: input.required !== false,
    ratio: input.ratio || "1:1",
    resolution: ["1k", "2k", "4k"].includes(input.resolution) ? input.resolution : "2k",
  };
  state.slots.push(slot);
  product.updatedAt = now;
  if (!product.taskGroupIds.length) product.taskGroupIds.push(createId("group"));
  return slot;
}

function createTaskInternal(state, productId, slotRef, input = {}) {
  const product = requireById(state.products, productId, "Product");
  const slot = state.slots.find((candidate) => candidate.productId === productId && (candidate.id === slotRef || candidate.slotId === slotRef));
  if (!slot) throw new Error(`产品任务位不存在：${slotRef}`);
  if (state.tasks.some((candidate) => candidate.productId === productId && candidate.slotId === slot.slotId)) {
    throw new Error(`此产品任务位已有关联任务：${slot.displayName}。如需重新生成，请在原任务上创建新的 Run。`);
  }
  const now = timestamp();
  const inputAssetIds = Array.isArray(input.inputAssetIds) ? [...input.inputAssetIds] : [...product.sourceAssets];
  for (const assetId of inputAssetIds) {
    const asset = state.assets.find((candidate) => candidate.id === assetId);
    if (!asset || asset.productId !== product.id) throw new Error(`参考素材必须属于当前产品：${assetId}`);
  }
  const prompt = makePrompt({ ...input, purpose: slot.purpose }, productId, slot.slotId);
  state.prompts.push(prompt);
  const task = {
    id: createId("task"),
    workspaceId: state.workspace.id,
    productId,
    taskGroupId: product.taskGroupIds[0] || createId("group"),
    slotId: slot.slotId,
    order: { productOrder: product.order, slotOrder: slot.sequence },
    kind: slot.kind,
    promptId: prompt.id,
    inputAssetIds,
    settings: {
      ratio: input.ratio || slot.ratio || "1:1",
      resolution: ["1k", "2k", "4k"].includes(input.resolution) ? input.resolution : slot.resolution || "2k",
      count: Math.max(1, Math.floor(Number.isFinite(Number(input.count)) ? Number(input.count) : 1)),
      format: ["png", "jpeg", "webp"].includes(input.format) ? input.format : "png",
      ...(input.durationSeconds ? { durationSeconds: Number(input.durationSeconds) } : {}),
      ...(input.modelHint ? { modelHint: String(input.modelHint) } : {}),
    },
    status: "draft",
    outputAssetIds: [],
    createdAt: now,
    updatedAt: now,
  };
  if (!product.taskGroupIds.includes(task.taskGroupId)) product.taskGroupIds.push(task.taskGroupId);
  state.tasks.push(task);
  product.status = "ready";
  product.updatedAt = now;
  return task;
}

function createAssetInternal(state, taskId, input = {}) {
  const task = requireById(state.tasks, taskId, "GenerationTask");
  const runId = input.runId || task.activeRunId;
  const run = runId ? requireById(state.runs, runId, "GenerationRun") : null;
  if (run && (run.taskId !== task.id || run.productId !== task.productId)) {
    throw new Error("Asset 的 Run 必须属于同一个 Task 和 Product");
  }
  const outputIndex = input.outputIndex == null ? (run ? run.outputAssetIds.length : task.outputAssetIds.length) : Number(input.outputIndex);
  const assetKind = ["image", "video", "audio", "psd", "zip", "mask", "other"].includes(input.kind)
    ? input.kind
    : task.kind;
  const now = timestamp();
  const asset = {
    id: createId("asset"),
    workspaceId: state.workspace.id,
    productId: task.productId,
    taskId: task.id,
    slotId: task.slotId,
    runId: run?.id,
    kind: assetKind,
    role: input.role || state.slots.find((slot) => slot.productId === task.productId && slot.slotId === task.slotId)?.purpose || "custom",
    sequence: Number(input.sequence || task.order.slotOrder),
    outputIndex,
    file: {
      storageKey: String(input.storageKey || `asset:${task.productId}:${task.slotId}:${Date.now()}`),
      originalName: input.originalName || undefined,
      downloadName: String(input.downloadName || `${task.productId}_${task.slotId}_${task.outputAssetIds.length + 1}.${assetKind === "video" ? "mp4" : "png"}`),
      mimeType: String(input.mimeType || (assetKind === "video" ? "video/mp4" : "image/png")),
      ...(input.bytes ? { bytes: Number(input.bytes) } : {}),
      ...(input.sha256 ? { sha256: String(input.sha256) } : {}),
      ...(input.width ? { width: Number(input.width) } : {}),
      ...(input.height ? { height: Number(input.height) } : {}),
      ...(input.durationMs ? { durationMs: Number(input.durationMs) } : {}),
    },
    lineage: {
      parentAssetIds: Array.isArray(input.parentAssetIds) ? [...input.parentAssetIds] : [],
      sourceTaskId: task.id,
      operation: input.operation || "generate",
    },
    status: ["available", "missing", "deleted"].includes(input.status) ? input.status : "available",
    createdAt: now,
    updatedAt: now,
  };
  state.assets.push(asset);
  task.outputAssetIds.push(asset.id);
  task.status = asset.status === "missing" ? "partial" : "succeeded";
  task.updatedAt = now;
  if (run) {
    if (!run.outputAssetIds.includes(asset.id)) run.outputAssetIds.push(asset.id);
    if (asset.status === "missing") {
      run.status = "partial";
    } else if (run.outputAssetIds.filter((assetId) => state.assets.find((candidate) => candidate.id === assetId)?.status === "available").length >= task.settings.count) {
      run.status = "succeeded";
      run.finishedAt = now;
      task.status = "succeeded";
    } else {
      run.status = "partial";
      task.status = "partial";
    }
  }
  return asset;
}

function createRunInternal(state, taskId, input = {}) {
  const task = requireById(state.tasks, taskId, "GenerationTask");
  const prompt = requireById(state.prompts, task.promptId, "PromptSpec");
  const now = timestamp();
  const run = {
    id: createId("run"),
    taskId,
    productId: task.productId,
    promptSnapshot: clone(prompt),
    inputAssetIds: [...task.inputAssetIds],
    settingsSnapshot: clone(task.settings),
    fallbackPolicySnapshot: {
      enabled: input.fallbackEnabled !== false,
      orderedProviderIds: Array.isArray(input.providerIds) ? [...input.providerIds] : [],
      maxAttempts: Number(input.maxAttempts || 4),
    },
    attemptIds: [],
    status: "queued",
    outputAssetIds: [],
    startedAt: now,
  };
  state.runs.push(run);
  task.activeRunId = run.id;
  task.status = "queued";
  task.updatedAt = now;
  return run;
}

const api = {
  schema: CONTRACT_SCHEMA,
  storageKey: STORAGE_KEY,
  getState: () => clone(readState()),
  reset: () => {
    const state = createEmptyState();
    publish(state);
    return clone(state);
  },
  saveState: (value) => {
    const state = validateState(normalizeState(value));
    publish(state);
    return clone(state);
  },
  setActiveProductSet: (productSetId) => clone(mutate((state) => {
    if (productSetId !== null && productSetId !== undefined && productSetId !== "") {
      requireById(state.productSets, productSetId, "ProductSet");
      state.workspace.activeProductSetId = productSetId;
    } else {
      state.workspace.activeProductSetId = null;
    }
    window.dispatchEvent(new CustomEvent(ACTIVE_PRODUCT_SET_EVENT, {
      detail: { productSetId: state.workspace.activeProductSetId },
    }));
    return state.workspace.activeProductSetId;
  })),
  createProductSet: (input) => clone(mutate((state) => createProductSetInternal(state, input))),
  deleteProductSet: (productSetId) => {
    const result = mutate((state) => {
      const productSet = requireById(state.productSets, productSetId, "ProductSet");
      const productIds = new Set(
        state.products
          .filter((product) => product.productSetId === productSet.id)
          .map((product) => product.id)
      );
      const slotIds = new Set(
        state.slots
          .filter((slot) => productIds.has(slot.productId))
          .map((slot) => slot.id)
      );
      const taskIds = new Set(
        state.tasks
          .filter((task) => productIds.has(task.productId))
          .map((task) => task.id)
      );
      const runIds = new Set(
        state.runs
          .filter((run) => taskIds.has(run.taskId) || productIds.has(run.productId))
          .map((run) => run.id)
      );

      state.productSets = state.productSets.filter((set) => set.id !== productSet.id);
      state.products = state.products.filter((product) => !productIds.has(product.id));
      state.importRecords = state.importRecords.filter((record) => record.productSetId !== productSet.id);
      state.slots = state.slots.filter((slot) => !slotIds.has(slot.id) && !productIds.has(slot.productId));
      state.prompts = state.prompts.filter((prompt) => !productIds.has(prompt.productId));
      state.tasks = state.tasks.filter((task) => !taskIds.has(task.id) && !productIds.has(task.productId));
      state.runs = state.runs.filter((run) => !runIds.has(run.id) && !taskIds.has(run.taskId));
      state.providerAttempts = state.providerAttempts.filter((attempt) => !runIds.has(attempt.runId));
      state.assets = state.assets.filter((asset) => (
        !productIds.has(asset.productId)
        && !taskIds.has(asset.taskId)
        && !runIds.has(asset.runId)
      ));

      const nextActive = state.productSets
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]?.id || null;
      state.workspace.activeProductSetId = state.workspace.activeProductSetId === productSet.id
        ? nextActive
        : (state.productSets.some((set) => set.id === state.workspace.activeProductSetId)
          ? state.workspace.activeProductSetId
          : nextActive);
      return {
        deletedProductSetId: productSet.id,
        deletedFileName: productSet.source?.fileName || "未命名产品表",
        activeProductSetId: state.workspace.activeProductSetId,
      };
    });
    window.dispatchEvent(new CustomEvent(ACTIVE_PRODUCT_SET_EVENT, {
      detail: { productSetId: result.activeProductSetId },
    }));
    return clone(result);
  },
  createProduct: (input) => clone(mutate((state) => {
    const product = createProductInternal(state, input);
    const set = requireById(state.productSets, input.productSetId, "ProductSet");
    if (!set.productIds.includes(product.id)) set.productIds.push(product.id);
    set.updatedAt = timestamp();
    return product;
  })),
  createSlot: (productId, input) => clone(mutate((state) => createSlotInternal(state, productId, input))),
  createTask: (productId, slotId, input) => clone(mutate((state) => createTaskInternal(state, productId, slotId, input))),
  createRun: (taskId, input) => clone(mutate((state) => createRunInternal(state, taskId, input))),
  addProviderAttempt: (runId, input = {}) => clone(mutate((state) => {
    const run = requireById(state.runs, runId, "GenerationRun");
    const attempt = {
      id: createId("att"),
      runId,
      providerId: String(input.providerId || "provider-unconfigured"),
      providerName: String(input.providerName || "未配置中转站"),
      model: String(input.model || ""),
      attemptOrder: run.attemptIds.length + 1,
      status: input.status || "queued",
      requestId: input.requestId || undefined,
      externalTaskId: input.externalTaskId || undefined,
      startedAt: input.startedAt || timestamp(),
      retryable: input.retryable !== false,
      errorCode: input.errorCode || undefined,
      errorMessage: input.errorMessage || undefined,
    };
    state.providerAttempts.push(attempt);
    run.attemptIds.push(attempt.id);
    run.status = attempt.status === "running" ? "running" : run.status;
    return attempt;
  })),
  createAsset: (taskId, input) => clone(mutate((state) => {
    return createAssetInternal(state, taskId, input);
  })),
  createDemoData: () => {
    const existing = readState();
    if (existing.products.length) return clone(existing);
    const state = existing;
    const set = createProductSetInternal(state, {
      fileName: "demo-wildberries-products.xlsx",
      rows: [{ sku: "WB-DEMO-001", titleZh: "演示针织衫" }],
      slotTemplates: [
        { slotId: "main-01", kind: "image", purpose: "product-main", sequence: 1, displayName: "主图 1", required: true, ratio: "1:1", resolution: "2k" },
        { slotId: "secondary-01", kind: "image", purpose: "product-secondary", sequence: 1, displayName: "副图 1", required: true, ratio: "3:4", resolution: "2k" },
        { slotId: "video-01", kind: "video", purpose: "product-video", sequence: 1, displayName: "短视频 1", required: false, ratio: "9:16", resolution: "2k" },
      ],
    });
    const product = state.products.find((candidate) => candidate.id === set.productIds[0]);
    if (product) {
      for (const slot of getProductSlots(state, product.id)) {
        const task = createTaskInternal(state, product.id, slot.slotId, {
          promptZh: `${slot.displayName}：展示演示针织衫，保持商品主体、颜色和结构一致。`,
          promptEn: `Create ${slot.displayName.toLowerCase()} for the knitwear product. Preserve the exact product identity, color, shape and details.`,
          finalPrompt: `Create ${slot.displayName.toLowerCase()} for the knitwear product. Preserve the exact product identity, color, shape and details.`,
          kind: slot.kind,
        });
        if (slot.slotId === "main-01") {
          const run = createRunInternal(state, task.id);
          createAssetInternal(state, task.id, {
            runId: run.id,
            kind: "image",
            role: "product-main",
            storageKey: "demo:asset:wb-demo-001:main-01",
            downloadName: "WB-DEMO-001_main-01_01.png",
            status: "missing",
          });
        }
      }
    }
    return clone(publish(state));
  },
  importRows: (input = {}) => clone(mutate((state) => createProductSetInternal(state, input))),
  importPromptProducts: (input = {}) => clone(mutate((state) => {
    const templates = Array.isArray(input.promptTemplates) ? clone(input.promptTemplates) : [];
    if (!templates.length) throw new Error("没有可导入的提示词模板");
    const productRows = Array.isArray(input.productRows) && input.productRows.length
      ? clone(input.productRows)
      : templates.map((template) => ({
          "产品名称": template.route || `提示词产品 ${template.order}`,
          "提示词路线": template.route,
          "提示词序号": template.order,
          ...template.prompts,
        }));
    const existing = state.productSets.find((candidate) => (
      candidate.source?.role === "prompt-products"
      && input.fileSha256
      && candidate.source?.fileSha256 === input.fileSha256
      && candidate.source?.sheetName === input.sheetName
    ));
    const set = existing || createProductSetInternal(state, {
      fileName: input.fileName,
      kind: input.kind,
      role: "prompt-products",
      fileSha256: input.fileSha256,
      sheetName: input.sheetName,
      promptSheetName: input.promptSheetName,
      promptTemplates: templates,
      rows: productRows,
      sourceRowNumbers: input.sourceRowNumbers,
      headerMap: input.headerMap,
      slotCounts: input.slotCounts,
      slotTemplates: input.slotTemplates,
    });
    if (existing) {
      existing.source.promptSheetName = input.promptSheetName || existing.source.promptSheetName;
      existing.source.promptTemplates = templates;
      existing.source.promptTemplateCount = templates.length;
      existing.updatedAt = timestamp();
      state.workspace.activeProductSetId = existing.id;
    }
    return {
      productSetId: set.id,
      productCount: set.productIds.length,
      promptTemplateCount: templates.length,
      fileName: set.source.fileName,
      promptSheetName: set.source.promptSheetName || "",
    };
  })),
  // Backward-compatible API name for callers that used the earlier template-only
  // import. New UI flows use importPromptProducts so each prompt row becomes a Product.
  importPromptTemplates: (input = {}) => clone(mutate((state) => {
    const templates = Array.isArray(input.promptTemplates) ? clone(input.promptTemplates) : [];
    if (!templates.length) throw new Error("没有可导入的提示词模板");
    const productRows = Array.isArray(input.productRows) && input.productRows.length
      ? clone(input.productRows)
      : templates.map((template) => ({
          "产品名称": template.route || `提示词产品 ${template.order}`,
          "提示词路线": template.route,
          "提示词序号": template.order,
          ...template.prompts,
        }));
    const set = createProductSetInternal(state, {
      ...input,
      role: "prompt-products",
      rows: productRows,
      promptTemplates: templates,
    });
    return {
      productSetId: set.id,
      productCount: set.productIds.length,
      promptTemplateCount: templates.length,
      fileName: set.source.fileName,
      promptSheetName: set.source.promptSheetName || "",
    };
  })),
  getProductTree: (productId) => {
    const state = readState();
    const product = requireById(state.products, productId, "Product");
    const slots = getProductSlots(state, productId).map((slot) => {
      const task = state.tasks.find((candidate) => candidate.productId === productId && candidate.slotId === slot.slotId) || null;
      return {
        ...clone(slot),
        task: clone(task),
        assets: task
          ? clone(state.assets.filter((asset) => asset.taskId === task.id))
          : [],
      };
    });
    return {
      product: clone(product),
      productSet: clone(requireById(state.productSets, product.productSetId, "ProductSet")),
      importRecord: clone(state.importRecords.find((record) => record.id === product.importRecordId) || null),
      slots,
      tasks: clone(getProductTasks(state, productId)),
      assets: clone(getProductAssets(state, productId)),
    };
  },
};

window.GuanWorkbenchData = api;

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = "/data-contract/index.css?contract-v26-20260927";
document.head.appendChild(css);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function closeExcelDeleteDialog() {
  const dialog = document.querySelector(".guan-dc-confirm");
  if (!dialog) {
    activeExcelDeleteDialog = null;
    return;
  }
  dialog.dataset.state = "closing";
  window.setTimeout(() => {
    if (dialog.dataset.state === "closing") dialog.remove();
  }, 170);
  activeExcelDeleteDialog = null;
}

function openExcelDeleteDialog({ fileName, onConfirm }) {
  closeExcelDeleteDialog();
  const dialog = document.createElement("div");
  dialog.className = "guan-dc-confirm";
  dialog.dataset.state = "opening";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "guan-dc-confirm-title");
  dialog.innerHTML = `
    <div class="guan-dc-confirm-backdrop" data-confirm-cancel></div>
    <section class="guan-dc-confirm-card" role="document">
      <div class="guan-dc-confirm-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6.5 7l.8 12h9.4l.8-12M9 7l1-3h4l1 3"></path></svg>
      </div>
      <div class="guan-dc-confirm-copy">
        <h2 id="guan-dc-confirm-title">删除 Excel？</h2>
        <p>确定删除“<strong>${escapeHtml(fileName)}</strong>”吗？关联的产品、任务和素材记录也会从本地数据中删除。</p>
      </div>
      <div class="guan-dc-confirm-actions">
        <button type="button" data-confirm-cancel>取消</button>
        <button type="button" class="danger" data-confirm-submit>删除</button>
      </div>
    </section>
  `;
  document.body.append(dialog);
  activeExcelDeleteDialog = dialog;
  const cancel = () => closeExcelDeleteDialog();
  dialog.querySelectorAll("[data-confirm-cancel]").forEach((element) => element.addEventListener("click", cancel));
  dialog.querySelector("[data-confirm-submit]")?.addEventListener("click", () => {
    const submit = dialog.querySelector("[data-confirm-submit]");
    if (!submit || submit.disabled) return;
    submit.disabled = true;
    try {
      onConfirm();
      closeExcelDeleteDialog();
    } catch (error) {
      submit.disabled = false;
      alert(error instanceof Error ? error.message : String(error));
    }
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  window.setTimeout(() => {
    if (dialog.dataset.state === "opening") dialog.dataset.state = "open";
    dialog.querySelector("[data-confirm-submit]")?.focus();
  }, 20);
}

function renderHeaderControls(root) {
  const dialog = document.querySelector('[role="dialog"]');
  const header = dialog?.querySelector(':scope > .flex.size-full > aside');
  if (!header) return false;

  let controls = header.querySelector(".guan-dc-header-controls");
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "guan-dc-header-controls";
    const anchor = header.querySelector(".local-workbench-theme-button")
      || header.querySelector(".local-workbench-settings-button");
    if (anchor) header.insertBefore(controls, anchor);
    else header.append(controls);
  }

  const state = readState();
  const productSets = [...state.productSets].sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
  const activeId = state.workspace.activeProductSetId || productSets[0]?.id || "";
  const stateKey = JSON.stringify({
    activeId,
    sets: productSets.map((set) => [set.id, set.source?.fileName || "未命名产品表", set.source?.sheetName || ""]),
  });
  if (controls.dataset.stateKey === stateKey) return true;
  controls.dataset.stateKey = stateKey;
  controls.dataset.menuOpen = "false";
  controls.innerHTML = `
    <span class="guan-dc-active-sheet-label" aria-hidden="true">当前工作表：</span>
    <div class="guan-dc-file-picker">
      <button type="button" class="guan-dc-file-trigger" aria-label="选择已上传的 Excel 文件" aria-haspopup="listbox" aria-expanded="false">
        <span class="guan-dc-file-trigger-label">${escapeHtml(productSets.find((set) => set.id === activeId)?.source?.fileName || "暂无已上传 Excel")}</span>
        <svg class="guan-dc-file-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
      </button>
      <div class="guan-dc-file-menu" role="listbox" aria-label="已上传的 Excel 文件" data-state="closed" hidden>
        ${productSets.map((set) => {
          const fileName = set.source?.fileName || "未命名产品表";
          const sheetName = set.source?.sheetName;
          const label = `${fileName}${sheetName ? ` · ${sheetName}` : ""}`;
          return `
            <div class="guan-dc-file-option-row">
              <button type="button" class="guan-dc-file-option" role="option" aria-selected="${set.id === activeId}" data-value="${escapeHtml(set.id)}">
                <span class="guan-dc-file-option-label">${escapeHtml(label)}</span>
                ${set.id === activeId ? `<svg class="guan-dc-file-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>` : ""}
              </button>
              <button type="button" class="guan-dc-file-delete" data-delete-product-set="${escapeHtml(set.id)}" aria-label="删除 ${escapeHtml(fileName)}" title="删除 Excel">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6.5 7l.8 12h9.4l.8-12M9 7l1-3h4l1 3"></path></svg>
              </button>
            </div>
          `;
        }).join("") || `<div class="guan-dc-file-empty">暂无已上传 Excel</div>`}
        <button type="button" class="guan-dc-file-upload" aria-label="上传 Excel">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>
          <span>上传 Excel</span>
        </button>
      </div>
    </div>
    <input class="guan-dc-header-file-input" type="file" accept=".xlsx,.xls,.csv" tabindex="-1" aria-hidden="true">
  `;

  const closeMenu = (animate = true) => {
    const menu = controls.querySelector(".guan-dc-file-menu");
    if (!menu || controls.dataset.menuOpen !== "true") return;
    controls.dataset.menuOpen = "false";
    const trigger = controls.querySelector(".guan-dc-file-trigger");
    trigger?.setAttribute("aria-expanded", "false");
    menu.dataset.state = animate ? "closing" : "closed";
    if (!animate) {
      menu.hidden = true;
      return;
    }
    window.setTimeout(() => {
      if (controls.dataset.menuOpen !== "true") {
        menu.hidden = true;
        menu.dataset.state = "closed";
      }
    }, 170);
  };

  const openMenu = () => {
    const menu = controls.querySelector(".guan-dc-file-menu");
    const trigger = controls.querySelector(".guan-dc-file-trigger");
    if (!menu || !trigger || trigger.disabled) return;
    controls.dataset.menuOpen = "true";
    menu.hidden = false;
    menu.dataset.state = "opening";
    trigger.setAttribute("aria-expanded", "true");
    // Keep the opening state long enough for the CSS animation to finish.
    // Switching to "open" on the very next frame would interrupt the animation.
    window.setTimeout(() => {
      if (controls.dataset.menuOpen === "true" && menu.dataset.state === "opening") {
        menu.dataset.state = "open";
      }
    }, 190);
  };

  if (controls.dataset.interactionsBound !== "true") {
    controls.dataset.interactionsBound = "true";
    controls.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const trigger = target.closest(".guan-dc-file-trigger");
      if (trigger) {
        event.preventDefault();
        controls.dataset.menuOpen === "true" ? closeMenu() : openMenu();
        return;
      }
      const option = target.closest(".guan-dc-file-option");
      if (option) {
        event.preventDefault();
        try {
          api.setActiveProductSet(option.dataset.value || null);
          closeMenu();
        } catch (error) {
          alert(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      const deleteButton = target.closest(".guan-dc-file-delete");
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        const productSetId = deleteButton.dataset.deleteProductSet;
        const productSet = readState().productSets.find((set) => set.id === productSetId);
        if (!productSet) return;
        const fileName = productSet.source?.fileName || "未命名产品表";
        openExcelDeleteDialog({
          fileName,
          onConfirm: () => {
            closeMenu(false);
            api.deleteProductSet(productSetId);
          },
        });
        return;
      }
      if (target.closest(".guan-dc-file-upload")) {
        event.preventDefault();
        closeMenu(false);
        controls.querySelector(".guan-dc-header-file-input")?.click();
      }
    });
    document.addEventListener("mousedown", (event) => {
      if (controls.dataset.menuOpen === "true" && !controls.contains(event.target)) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && controls.dataset.menuOpen === "true") closeMenu();
    });
    controls.addEventListener("change", (event) => {
      const input = event.target instanceof HTMLInputElement ? event.target : null;
      if (!input?.classList.contains("guan-dc-header-file-input")) return;
      loadExcelFile(input.files?.[0], root);
      input.value = "";
    });
  }
  return true;
}

function renderPanel(root) {
  const state = readState();
  const products = [...state.products].sort((a, b) => a.order - b.order);
  const productSets = [...state.productSets].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const activeProductSetId = state.workspace.activeProductSetId || productSets.at(-1)?.id || "";
  const taskByProduct = new Map();
  const assetsByTask = new Map();
  for (const task of state.tasks) {
    if (!taskByProduct.has(task.productId)) taskByProduct.set(task.productId, []);
    taskByProduct.get(task.productId).push(task);
    assetsByTask.set(task.id, state.assets.filter((asset) => asset.taskId === task.id));
  }
  const pending = pendingExcelImport;
  root.innerHTML = `
    <button class="guan-dc-trigger" type="button" aria-expanded="${root.dataset.open === "true"}">数据</button>
    <section class="guan-dc-panel" ${root.dataset.open === "true" ? "" : "hidden"}>
      <header class="guan-dc-header">
        <div>
          <strong>产品数据</strong>
          <span>合同 v1</span>
        </div>
        <button type="button" data-dc-action="close" aria-label="关闭数据面板">×</button>
      </header>
      <div class="guan-dc-stats">
        <span><b>${state.productSets.length}</b> 产品表</span>
        <span><b>${state.products.length}</b> 产品</span>
        <span><b>${state.slots.length}</b> 槽位</span>
        <span><b>${state.tasks.length}</b> 任务</span>
        <span><b>${state.assets.length}</b> 素材</span>
      </div>
      <div class="guan-dc-actions">
        <label class="guan-dc-upload-button" for="guan-dc-excel-file">上传 Excel</label>
        <input id="guan-dc-excel-file" class="guan-dc-file-input" type="file" accept=".xlsx,.xls,.csv" data-dc-input="excel-file">
      </div>
      ${pending ? renderExcelPreview(pending) : ""}
      <div class="guan-dc-tree">
        ${productSets.length ? productSets.map((set) => {
          const setProducts = products.filter((product) => product.productSetId === set.id);
          return `
            <section class="guan-dc-set ${set.id === activeProductSetId ? "is-active" : ""}">
              <header class="guan-dc-set-head">
                <div class="guan-dc-set-title">
                  <b>${escapeHtml(set.source.fileName)}</b>
                  ${set.source.sheetName ? `<small>${escapeHtml(set.source.sheetName)}</small>` : ""}
                  ${set.id === activeProductSetId ? `<small class="guan-dc-active-label">当前使用</small>` : ""}
                  ${set.source.role === "prompt-products"
                    ? `<small class="guan-dc-prompt-template-label">已导入 ${setProducts.length} 个提示词产品</small>`
                    : set.source.promptTemplateCount
                      ? `<small class="guan-dc-prompt-template-label">已关联 ${set.source.promptTemplateCount} 条提示词模板</small>`
                      : ""}
                </div>
                <small>${setProducts.length} 个产品</small>
              </header>
              <div class="guan-dc-products">
                ${setProducts.map((product) => {
                  const slots = state.slots.filter((slot) => slot.productId === product.id).sort((a, b) => a.sequence - b.sequence);
                  const tasks = taskByProduct.get(product.id) || [];
                  return `
                    <article class="guan-dc-product">
                      <div class="guan-dc-product-head">
                        <div>
                          <b>${escapeHtml(product.identity.sku || product.id)}</b>
                          <span>${escapeHtml(product.identity.titleZh || "未命名产品")}</span>
                        </div>
                        <small>${set.source.role === "prompt-products" ? "提示词表" : "Excel/数据表"}第 ${product.sourceRowNumber || product.order + 1} 行</small>
                      </div>
                      <div class="guan-dc-slots">
                        ${slots.map((slot) => {
                          const task = tasks.find((candidate) => candidate.slotId === slot.slotId);
                          const assets = task ? assetsByTask.get(task.id) || [] : [];
                          const missingCount = assets.filter((asset) => asset.status === "missing").length;
                          const assetLabel = missingCount ? `${assets.length} 个素材（${missingCount} 个文件待接入）` : `${assets.length} 个素材`;
                          return `
                            <div class="guan-dc-slot">
                              <span class="slot-label">${escapeHtml(slot.displayName)}</span>
                              <span class="slot-meta">${slot.kind === "video" ? "视频" : "图片"} · ${escapeHtml(slot.ratio)} · ${escapeHtml(slot.resolution)}</span>
                              <span class="slot-status">${task ? `${task.status} · ${assetLabel}` : "未建任务"}</span>
                            </div>
                          `;
                        }).join("")}
                      </div>
                      <button type="button" class="guan-dc-product-task" data-dc-action="init-tasks" data-product-id="${product.id}">为此产品初始化任务</button>
                    </article>
                  `;
                }).join("") || `<div class="guan-dc-empty">此产品表还没有产品行。</div>`}
              </div>
            </section>
          `;
        }).join("") : `<div class="guan-dc-empty">还没有产品数据。上传 Excel 后可先预览，再确认导入。</div>`}
      </div>
      <footer class="guan-dc-footer">Excel 在本机浏览器解析，数据保存在此浏览器中。文件不会上传。</footer>
    </section>
  `;
  renderHeaderControls(root);
  bindPanelEvents(root);
}

function renderExcelPreview(pending) {
  if (pending.busy) {
    return `<section class="guan-dc-excel-preview"><strong>正在读取 Excel…</strong><p>文件仅在本机浏览器中解析。</p></section>`;
  }
  if (pending.error) {
    return `<section class="guan-dc-excel-preview guan-dc-excel-error" role="alert">
      <strong>无法读取此文件</strong><p>${escapeHtml(pending.error)}</p>
      <button type="button" data-dc-action="clear-excel">清除</button>
    </section>`;
  }
  const parsed = pending.parsed;
  const isPromptProductSheet = parsed.kind === "prompt-template";
  const isCompetitorSheet = parsed.kind === "product-table"
    && (normalizeHeader(pending.sheetName) === "data" || Boolean(pending.promptSheetInfo));
  const visibleHeaders = parsed.headers.slice(0, 8);
  const previewRows = parsed.rows.slice(0, 6);
  const sheetOptions = pending.sheetNames.map((name) =>
    `<option value="${escapeHtml(name)}" ${name === pending.sheetName ? "selected" : ""}>${escapeHtml(name)}</option>`
  ).join("");
  const table = parsed.rows.length ? `
    <div class="guan-dc-preview-table-wrap">
      <table class="guan-dc-preview-table">
        <thead><tr><th>Excel 行</th>${visibleHeaders.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
        <tbody>${previewRows.map((row) => `
          <tr><th>${row.sourceRowNumber}</th>${visibleHeaders.map((header) => `<td>${escapeHtml(row.values[header] == null ? "" : String(row.values[header]))}</td>`).join("")}</tr>
        `).join("")}</tbody>
      </table>
    </div>
  ` : `<div class="guan-dc-excel-no-rows">当前工作表没有可导入的${isPromptProductSheet ? "提示词产品" : "产品"}行。</div>`;
  return `
    <section class="guan-dc-excel-preview">
      <div class="guan-dc-excel-title">
        <div><strong>${isPromptProductSheet ? "提示词产品预览" : "竞品/数据预览"}</strong><span title="${escapeHtml(pending.fileName)}">${escapeHtml(pending.fileName)}</span></div>
        <button type="button" data-dc-action="clear-excel" aria-label="取消 Excel 导入">×</button>
      </div>
      <div class="guan-dc-excel-meta">
        ${isPromptProductSheet
          ? `${parsed.rows.length} 个待生成产品 · ${parsed.promptColumnCount} 个提示词字段 · 第 ${parsed.headerRowNumber} 行为表头`
          : `${parsed.rows.length} 个产品行 · ${parsed.headers.length} 列 · 第 ${parsed.headerRowNumber} 行为表头`}
      </div>
      ${pending.sheetNames.length > 1 ? `<label class="guan-dc-sheet-label">工作表<select data-dc-input="sheet">${sheetOptions}</select></label>` : `<div class="guan-dc-sheet-name">工作表：${escapeHtml(pending.sheetName)}</div>`}
      ${isPromptProductSheet ? `
        <div class="guan-dc-prompt-detected">
          <strong>已识别“最终英文提示词”产品表</strong>
          <p>这里一行就是一个待生成产品。Main Prompt、Detail Prompt 01-10、Rich Prompt 01-06 和 Video Prompt 会按列保存到该产品的提示词配置。</p>
          <p><b>Data</b> 以及前面的分析工作表是竞品参考资料，不会作为商品导入。SKU、规格等产品参数后续可在自定义面板补充，并与这些提示词组合。</p>
          <div class="guan-dc-slot-counts">
            <strong>每个提示词产品建立图片槽位</strong>
            <label>主图<input data-dc-input="slot-main" type="number" min="0" max="100" value="${pending.slotCounts.main}"></label>
            <label>副图<input data-dc-input="slot-secondary" type="number" min="0" max="100" value="${pending.slotCounts.secondary}"></label>
            <label>详情图<input data-dc-input="slot-detail" type="number" min="0" max="100" value="${pending.slotCounts.detail}"></label>
          </div>
        </div>
      ` : `
        ${isCompetitorSheet ? `<div class="guan-dc-prompt-detected"><strong>这是竞品参考数据</strong><p>当前工作表不会导入为待生成商品，请切换到最后的提示词产品表。</p></div>` : ""}
        <div class="guan-dc-slot-counts">
          <strong>每个产品建立图片槽位</strong>
          <label>主图<input data-dc-input="slot-main" type="number" min="0" max="100" value="${pending.slotCounts.main}"></label>
          <label>副图<input data-dc-input="slot-secondary" type="number" min="0" max="100" value="${pending.slotCounts.secondary}"></label>
          <label>详情图<input data-dc-input="slot-detail" type="number" min="0" max="100" value="${pending.slotCounts.detail}"></label>
        </div>
        ${pending.promptSheetInfo ? `
          <div class="guan-dc-prompt-hint">
            已检测到提示词产品表“${escapeHtml(pending.promptSheetInfo.sheetName)}”：共 ${pending.promptSheetInfo.rowCount} 个待生成产品。请切换到该工作表导入；当前 Data/分析表仅作竞品参考。
          </div>
        ` : ""}
      `}
      ${parsed.headers.length > visibleHeaders.length ? `<p class="guan-dc-preview-note">预览仅显示前 8 列，导入时会保留全部 ${parsed.headers.length} 列。</p>` : ""}
      ${table}
      <p class="guan-dc-preview-note">显示前 ${Math.min(6, parsed.rows.length)} 行。完全空白行会跳过，Excel 原始行号和字段会保留。</p>
      <button type="button" class="guan-dc-confirm-import" data-dc-action="confirm-excel" ${(parsed.rows.length && !isCompetitorSheet) ? "" : "disabled"}>${isPromptProductSheet ? `导入 ${parsed.rows.length} 个提示词产品` : isCompetitorSheet ? "竞品数据不可作为产品导入" : `确认导入 ${parsed.rows.length} 个产品`}</button>
    </section>
  `;
}

function columnLabel(index) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function cellValueForImport(cell) {
  if (!cell) return null;
  let value = cell.v;
  if (value === undefined && cell.f) value = `=${cell.f}`;
  if (cell.t === "e") value = cell.w || String(value ?? "Excel 错误值");
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string" || typeof value === "boolean") return value;
  return String(value);
}

function sheetNameLooksLikePrompt(name) {
  const normalized = normalizeHeader(name);
  return normalized.includes("视觉内容与ai提示词")
    || normalized.includes("提示词")
    || normalized.includes("prompt")
    || normalized.includes("visualcontent");
}

function valueAt(worksheet, rowIndex, columnIndex) {
  return cellValueForImport(worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })]);
}

function rowValues(worksheet, range, rowIndex) {
  const values = [];
  for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
    values.push(valueAt(worksheet, rowIndex, columnIndex));
  }
  return values;
}

function rowText(values) {
  return values
    .filter((value) => value !== null && String(value).trim() !== "")
    .map((value) => String(value).trim())
    .join(" | ");
}

function promptColumnLabel(value) {
  const text = String(value ?? "").trim();
  // Prompt headers in the client workbooks include dimensions after a pipe,
  // for example "Detail Prompt 01 | 900 x 1200 | 3:4". Strip that suffix
  // before extracting the prompt number so "01 | 900" is not read as 1900.
  const headerPart = text.split("|", 1)[0].trim();
  const normalized = normalizeHeader(headerPart);
  if (normalized.includes("mainprompt")) return "Main Prompt";
  const detail = normalized.match(/^detailprompt0*(\d{1,2})$/);
  if (detail) return `Detail Prompt ${String(Number(detail[1])).padStart(2, "0")}`;
  const rich = normalized.match(/^richprompt0*(\d{1,2})$/);
  if (rich) return `Rich Prompt ${String(Number(rich[1])).padStart(2, "0")}`;
  if (normalized === "videoprompt" || normalized.startsWith("videoprompt")) return "Video Prompt";
  return "";
}

function findPromptSectionRow(worksheet, range) {
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const text = rowText(rowValues(worksheet, range, rowIndex)).toLowerCase();
    if (text.includes("final english prompts") || text.includes("最终英文提示词")) return rowIndex;
  }
  return -1;
}

function parsePromptSheet(workbook, sheetName) {
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet?.["!ref"]) throw new Error(`提示词工作表「${sheetName}」没有可读取的单元格`);
  const range = XLSX.utils.decode_range(worksheet["!ref"]);
  const columnCount = range.e.c - range.s.c + 1;
  if (columnCount > MAX_IMPORT_COLUMNS) throw new Error(`工作表共有 ${columnCount} 列，当前最多支持 ${MAX_IMPORT_COLUMNS} 列。请先精简工作表后再导入。`);

  const sectionRowIndex = findPromptSectionRow(worksheet, range);
  const searchStart = sectionRowIndex >= 0 ? sectionRowIndex + 1 : range.s.r;
  let headerRowIndex = -1;
  let promptDescriptors = [];
  let orderColumnIndex = -1;
  let routeColumnIndex = -1;
  for (let rowIndex = searchStart; rowIndex <= range.e.r; rowIndex += 1) {
    const values = rowValues(worksheet, range, rowIndex);
    const descriptors = [];
    values.forEach((value, offset) => {
      const label = promptColumnLabel(value);
      if (label) descriptors.push({ label, columnIndex: range.s.c + offset, originalHeader: String(value).trim() });
    });
    if (!descriptors.length) continue;
    const normalizedValues = values.map((value) => normalizeHeader(value));
    const candidateOrder = normalizedValues.findIndex((value) => value === "order" || value === "序号");
    const candidateRoute = normalizedValues.findIndex((value) => value.includes("productroute") || value.includes("产品路线"));
    // A prompt sheet must expose a real prompt matrix. A lone "Order" or
    // route column is common in documentation sections and is not enough to
    // classify the sheet as importable prompt data.
    if (descriptors.length >= 2 && (candidateOrder >= 0 || candidateRoute >= 0)) {
      headerRowIndex = rowIndex;
      promptDescriptors = descriptors;
      orderColumnIndex = candidateOrder >= 0 ? range.s.c + candidateOrder : -1;
      routeColumnIndex = candidateRoute >= 0 ? range.s.c + candidateRoute : -1;
      break;
    }
  }
  if (headerRowIndex < 0 || !promptDescriptors.length) {
    throw new Error(`工作表「${sheetName}」未找到“最终英文提示词”区域或 Prompt 表头`);
  }

  const seenLabels = new Set();
  promptDescriptors = promptDescriptors.filter((descriptor) => {
    if (seenLabels.has(descriptor.label)) return false;
    seenLabels.add(descriptor.label);
    return true;
  });
  const columns = [];
  if (orderColumnIndex >= 0) columns.push({ key: "Order", label: "Order", columnIndex: orderColumnIndex });
  if (routeColumnIndex >= 0) {
    columns.push({
      key: "Product route / core advantage",
      label: "Product route / core advantage",
      columnIndex: routeColumnIndex,
    });
  }
  promptDescriptors.forEach((descriptor) => columns.push({
    key: descriptor.label,
    label: descriptor.label,
    columnIndex: descriptor.columnIndex,
    originalHeader: descriptor.originalHeader,
  }));

  const headers = columns.map((column) => column.key);
  const headerMap = Object.fromEntries(columns.map((column) => [column.key, column.originalHeader || column.label]));
  const lastRowIndex = Math.min(range.e.r, headerRowIndex + MAX_IMPORT_ROWS);
  if (range.e.r - headerRowIndex > MAX_IMPORT_ROWS) {
    throw new Error(`工作表超过 ${MAX_IMPORT_ROWS} 个数据行。请先拆分工作表后再导入，避免浏览器存储和预览过载。`);
  }
  const rows = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex <= lastRowIndex; rowIndex += 1) {
    const values = {};
    let hasPrompt = false;
    columns.forEach((column) => {
      const value = valueAt(worksheet, rowIndex, column.columnIndex);
      values[column.key] = value;
      if (promptColumnLabel(column.label) && value !== null && String(value).trim() !== "") hasPrompt = true;
    });
    const orderValue = values.Order;
    const hasNumericOrder = orderValue !== null
      && String(orderValue).trim() !== ""
      && Number.isFinite(Number(orderValue));
    // Section titles such as "8. Mandatory pre-delivery checks" can appear
    // under the Order column. They are documentation, not product routes.
    // Keep a row only when it has a real numeric order or prompt content.
    if (hasPrompt || hasNumericOrder) rows.push({ sourceRowNumber: rowIndex + 1, values });
  }
  return {
    kind: "prompt-template",
    headers,
    headerMap,
    rows,
    headerRowNumber: headerRowIndex + 1,
    sectionRowNumber: sectionRowIndex >= 0 ? sectionRowIndex + 1 : null,
    promptColumns: promptDescriptors.map((descriptor) => descriptor.label),
    promptColumnCount: promptDescriptors.length,
  };
}

function findPromptSheetCandidate(workbook, sheetNames, excludedSheetName = "") {
  const candidates = [...sheetNames]
    .reverse()
    .filter((name) => name !== excludedSheetName && workbook.Sheets[name]?.["!ref"]);
  const prioritized = [
    ...candidates.filter((name) => sheetNameLooksLikePrompt(name)),
    ...candidates.filter((name) => !sheetNameLooksLikePrompt(name)),
  ];
  for (const sheetName of prioritized) {
    try {
      return { sheetName, parsed: parsePromptSheet(workbook, sheetName) };
    } catch {
      // A normal analysis sheet can contain a few words such as “prompt”.
      // Keep scanning until a real prompt matrix is found.
    }
  }
  return null;
}

function promptTemplatesFromParsed(parsed) {
  if (!parsed || parsed.kind !== "prompt-template") return [];
  return parsed.rows.map((row, index) => {
    const values = row.values || {};
    const prompts = {};
    for (const label of parsed.promptColumns || []) {
      const value = values[label];
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        prompts[label] = String(value).trim();
      }
    }
    return {
      id: `excel-prompt-${Number(values.Order) || index + 1}`,
      order: Number(values.Order) || index + 1,
      route: String(values["Product route / core advantage"] || "").trim(),
      prompts,
      sourceRowNumber: row.sourceRowNumber,
    };
  }).filter((template) => Object.keys(template.prompts).length > 0);
}

function promptProductRowsFromParsed(parsed) {
  return promptTemplatesFromParsed(parsed).map((template) => ({
    "产品名称": template.route || `提示词产品 ${template.order}`,
    "提示词路线": template.route,
    "提示词序号": template.order,
    ...template.prompts,
  }));
}

function promptProductSourceRowsFromParsed(parsed) {
  return promptTemplatesFromParsed(parsed).map((template) => template.sourceRowNumber);
}

function promptTemplateScore(product, template) {
  const attributeText = Object.values(product?.attributes || {})
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).toLowerCase())
    .join(" | ");
  if (!attributeText || !template?.route) return 0;
  const routeParts = String(template.route)
    .split("|")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  let score = 0;
  for (const [index, part] of routeParts.entries()) {
    if (attributeText.includes(part)) score += index === 0 ? 8 : 3;
  }
  return score;
}

function promptTemplateForProduct(product, productSet) {
  const templates = Array.isArray(productSet?.source?.promptTemplates)
    ? productSet.source.promptTemplates
    : [];
  if (!templates.length) return null;
  return templates
    .map((template, index) => ({ template, index, score: promptTemplateScore(product, template) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.template || null;
}

function promptTextForSlot(template, slot) {
  if (!template?.prompts || !slot) return "";
  if (slot.purpose === "product-main") return template.prompts["Main Prompt"] || "";
  if (slot.purpose === "product-secondary") {
    return template.prompts[`Detail Prompt ${String(slot.sequence).padStart(2, "0")}`] || "";
  }
  if (slot.purpose === "product-detail" || slot.purpose === "product-a-plus") {
    return template.prompts[`Rich Prompt ${String(slot.sequence).padStart(2, "0")}`] || "";
  }
  if (slot.purpose === "product-video") return template.prompts["Video Prompt"] || "";
  return "";
}

function headerFieldKind(value) {
  const normalized = normalizeHeader(value);
  if (!normalized) return "";
  if ([
    "sku", "skucode", "商品编码", "货号", "商品id", "产品id", "商品编号",
  ].some((alias) => normalized === normalizeHeader(alias) || normalized.includes(normalizeHeader(alias)))) return "sku";
  if ([
    "title", "商品名称", "商品标题", "标题", "名称", "产品名称",
  ].some((alias) => normalized === normalizeHeader(alias) || normalized.includes(normalizeHeader(alias)))) return "title";
  if ([
    "url", "链接", "商品链接", "产品链接", "详情页地址", "详情页链接",
    "主图", "主图高清原图url", "主图url", "图片详情", "图片详情地址",
  ].some((alias) => normalized === normalizeHeader(alias) || normalized.includes(normalizeHeader(alias)))) return "url";
  return "";
}

function inspectProductHeader(values) {
  const fields = { sku: [], title: [], url: [] };
  values.forEach((value, offset) => {
    const kind = headerFieldKind(value);
    if (kind) fields[kind].push(offset);
  });
  const kinds = Object.entries(fields).filter(([, columns]) => columns.length).map(([kind]) => kind);
  const valid = kinds.length >= 2
    && (fields.sku.length > 0 || fields.title.length > 0)
    && (fields.sku.length > 0 || fields.url.length > 0);
  return { fields, kinds, valid };
}

function findStandardHeaderRow(worksheet, range) {
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const values = rowValues(worksheet, range, rowIndex);
    const nonEmpty = values.filter((value) => value !== null && String(value).trim() !== "");
    if (!nonEmpty.length) continue;
    const nextValues = rowIndex < range.e.r ? rowValues(worksheet, range, rowIndex + 1) : [];
    const nextCount = nextValues.filter((value) => value !== null && String(value).trim() !== "").length;
    const inspection = inspectProductHeader(values);
    if (inspection.valid && (nonEmpty.length >= 2 || nextCount >= 2)) return {
      rowIndex,
      inspection,
    };
  }
  return null;
}

function parseExcelSheet(workbook, sheetName) {
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet?.["!ref"]) throw new Error(`工作表「${sheetName}」没有可读取的单元格`);
  const range = XLSX.utils.decode_range(worksheet["!ref"]);
  const columnCount = range.e.c - range.s.c + 1;
  if (columnCount > MAX_IMPORT_COLUMNS) throw new Error(`工作表共有 ${columnCount} 列，当前最多支持 ${MAX_IMPORT_COLUMNS} 列。请先精简工作表后再导入。`);

  if (sheetNameLooksLikePrompt(sheetName)) return parsePromptSheet(workbook, sheetName);

  const headerInfo = findStandardHeaderRow(worksheet, range);
  if (!headerInfo) throw new Error(`工作表「${sheetName}」未找到可识别的产品主表表头（至少需要 SKU/标题/链接中的两类字段）`);
  const { rowIndex: headerRowIndex, inspection: headerInspection } = headerInfo;

  const headers = [];
  const headerMap = {};
  const usedHeaders = new Map();
  for (let offset = 0; offset < columnCount; offset += 1) {
    const columnIndex = range.s.c + offset;
    const original = cellValueForImport(worksheet[XLSX.utils.encode_cell({ r: headerRowIndex, c: columnIndex })]);
    const originalHeader = original == null ? "" : String(original).trim();
    const base = originalHeader || `未命名列（${columnLabel(columnIndex)}）`;
    const duplicateCount = (usedHeaders.get(base) || 0) + 1;
    usedHeaders.set(base, duplicateCount);
    const uniqueHeader = duplicateCount === 1 ? base : `${base}（${duplicateCount}）`;
    headers.push(uniqueHeader);
    headerMap[uniqueHeader] = originalHeader;
  }

  const lastRowIndex = Math.min(range.e.r, headerRowIndex + MAX_IMPORT_ROWS);
  if (range.e.r - headerRowIndex > MAX_IMPORT_ROWS) {
    throw new Error(`工作表超过 ${MAX_IMPORT_ROWS} 个数据行。请先拆分工作表后再导入，避免浏览器存储和预览过载。`);
  }
  const rows = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex <= lastRowIndex; rowIndex += 1) {
    const values = {};
    let hasData = false;
    headers.forEach((header, offset) => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: range.s.c + offset })];
      const value = cellValueForImport(cell);
      values[header] = value;
      if (value !== null && String(value).trim() !== "") hasData = true;
    });
    const identityKindsPresent = Object.entries(headerInspection.fields).filter(([, offsets]) => (
      offsets.some((offset) => {
        const header = headers[offset];
        const value = values[header];
        return value !== null && String(value).trim() !== "";
      })
    )).map(([kind]) => kind);
    // Keep only rows that still look like product records. This excludes
    // narrative/analysis rows beneath a valid header while allowing one
    // missing identity field in a partially completed workbook.
    if (hasData && identityKindsPresent.length >= 2) {
      rows.push({ sourceRowNumber: rowIndex + 1, values });
    }
  }
  if (!rows.length) throw new Error(`工作表「${sheetName}」找到表头，但没有满足 SKU/标题/链接两类身份字段的产品行`);
  return {
    kind: "product-table",
    headers,
    headerMap,
    rows,
    headerRowNumber: headerRowIndex + 1,
    identityColumns: headerInspection.kinds,
  };
}

function findProductSheetCandidate(workbook, sheetNames, excludedSheetName = "") {
  for (const sheetName of sheetNames) {
    if (sheetName === excludedSheetName || !workbook.Sheets[sheetName]?.["!ref"]) continue;
    try {
      return { sheetName, parsed: parseExcelSheet(workbook, sheetName) };
    } catch {
      // Cover pages, instructions and prompt sheets are not product tables.
    }
  }
  return null;
}

function buildSlotTemplates(counts) {
  const templates = [];
  const groups = [
    { key: "main", prefix: "main", purpose: "product-main", name: "主图", ratio: "1:1" },
    { key: "secondary", prefix: "secondary", purpose: "product-secondary", name: "副图", ratio: "3:4" },
    { key: "detail", prefix: "detail", purpose: "product-detail", name: "详情图", ratio: "3:4" },
  ];
  for (const group of groups) {
    for (let sequence = 1; sequence <= counts[group.key]; sequence += 1) {
      templates.push({
        slotId: `${group.prefix}-${String(sequence).padStart(2, "0")}`,
        kind: "image",
        purpose: group.purpose,
        sequence,
        displayName: `${group.name} ${sequence}`,
        required: true,
        ratio: group.ratio,
        resolution: "2k",
      });
    }
  }
  return templates;
}

function readSlotCounts(root) {
  const counts = {
    main: Number(root.querySelector('[data-dc-input="slot-main"]')?.value ?? DEFAULT_SLOT_COUNTS.main),
    secondary: Number(root.querySelector('[data-dc-input="slot-secondary"]')?.value ?? DEFAULT_SLOT_COUNTS.secondary),
    detail: Number(root.querySelector('[data-dc-input="slot-detail"]')?.value ?? DEFAULT_SLOT_COUNTS.detail),
  };
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("每类槽位数量需为 0 到 100 的整数");
  }
  const total = counts.main + counts.secondary + counts.detail;
  if (total < 1) throw new Error("请至少保留一个图片槽位");
  return counts;
}

async function loadExcelFile(file, root) {
  if (!file) return;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["xlsx", "xls", "csv"].includes(extension)) {
    pendingExcelImport = { error: "请选择 .xlsx、.xls 或 .csv 文件。" };
    renderPanel(root);
    return;
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    pendingExcelImport = { error: "文件超过 100 MB。请先拆分或精简文件后再导入。" };
    renderPanel(root);
    return;
  }
  const token = createId("excel");
  pendingExcelImport = {
    token,
    file,
    fileName: file.name,
    kind: extension,
    busy: true,
    slotCounts: { ...DEFAULT_SLOT_COUNTS },
  };
  renderPanel(root);
  try {
    if (!globalThis.XLSX) throw new Error("本地 Excel 解析库没有加载。请刷新页面后重试。");
    const buffer = await file.arrayBuffer();
    // CSV files do not carry an encoding declaration.  SheetJS otherwise
    // falls back to the legacy codepage and UTF-8 Chinese headers become
    // mojibake in the preview/imported product fields.  Explicitly select
    // UTF-8 for CSV while leaving native XLS/XLSX parsing unchanged.
    const workbook = XLSX.read(buffer, {
      type: "array",
      cellDates: true,
      ...(extension === "csv" ? { codepage: 65001 } : {}),
    });
    const sheetNames = [...workbook.SheetNames];
    if (!sheetNames.length) throw new Error("文件中没有工作表");
    const namedDataSheet = sheetNames.find((name) => normalizeHeader(name) === "data");
    const namedDataCandidate = namedDataSheet && workbook.Sheets[namedDataSheet]?.["!ref"]
      ? (() => {
          try {
            return { sheetName: namedDataSheet, parsed: parseExcelSheet(workbook, namedDataSheet) };
          } catch {
            return null;
          }
        })()
      : null;
    // Prompt routes normally live in the final worksheet. Scan from the end,
    // first preferring prompt-like names, then validating every remaining sheet
    // by its actual Prompt/Order/route matrix so names are not a hard requirement.
    const promptCandidate = findPromptSheetCandidate(workbook, sheetNames, namedDataCandidate?.sheetName || "");
    const productCandidate = namedDataCandidate || findProductSheetCandidate(
      workbook,
      sheetNames,
      promptCandidate?.sheetName || "",
    );
    // The prompt sheet is the operator's product source. Data and the other
    // analysis sheets are reference-only competitor research, so default the
    // preview to the prompt products whenever one is found.
    const selectedCandidate = promptCandidate || productCandidate;
    if (!selectedCandidate) throw new Error("文件中没有可识别的 Data 产品表或提示词模板工作表");
    const sheetName = selectedCandidate.sheetName;
    const parsed = selectedCandidate.parsed;
    const promptSheetName = promptCandidate?.sheetName || "";
    const promptSheetParsed = promptCandidate?.parsed || null;
    const promptSheetInfo = promptSheetParsed ? {
      sheetName: promptSheetName,
      sectionRowNumber: promptSheetParsed.sectionRowNumber,
      headerRowNumber: promptSheetParsed.headerRowNumber,
      rowCount: promptSheetParsed.rows.length,
      promptColumns: promptSheetParsed.promptColumns,
    } : null;
    let fileSha256;
    if (globalThis.crypto?.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      fileSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    if (pendingExcelImport?.token !== token) return;
    pendingExcelImport = {
      token, file, fileName: file.name, kind: extension, fileSha256,
      workbook, sheetNames, sheetName, parsed, promptSheetInfo, promptSheetParsed, busy: false,
      slotCounts: { ...DEFAULT_SLOT_COUNTS },
    };
  } catch (error) {
    if (pendingExcelImport?.token !== token) return;
    pendingExcelImport = {
      token,
      fileName: file.name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  root.dataset.open = "true";
  renderPanel(root);
}

function downloadJson(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `guan-ai-workbench-data-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function initTasksForProduct(productId) {
  const state = readState();
  const product = requireById(state.products, productId, "Product");
  const productSet = requireById(state.productSets, product.productSetId, "ProductSet");
  const promptTemplate = promptTemplateForProduct(product, productSet);
  const slots = getProductSlots(state, productId);
  const existing = new Set(state.tasks.filter((task) => task.productId === productId).map((task) => task.slotId));
  for (const slot of slots) {
    if (existing.has(slot.slotId)) continue;
    const importedPrompt = promptTextForSlot(promptTemplate, slot);
    const fallbackPrompt = `Create ${slot.displayName.toLowerCase()} while preserving the exact product identity.`;
    const templateRoute = promptTemplate?.route || "";
    createTaskInternal(state, productId, slot.slotId, {
      promptZh: templateRoute
        ? `Excel 提示词模板：${templateRoute}`
        : `${slot.displayName}：展示产品并保持主体一致。`,
      promptEn: importedPrompt || fallbackPrompt,
      finalPrompt: importedPrompt || fallbackPrompt,
      variables: importedPrompt ? {
        source: "excel-prompt-sheet",
        templateOrder: promptTemplate.order,
        templateRoute,
        promptSheetName: productSet.source?.promptSheetName || "",
      } : undefined,
      kind: slot.kind,
    });
  }
  product.status = "ready";
  publish(state);
}

function bindPanelEvents(root) {
  root.querySelector(".guan-dc-trigger")?.addEventListener("click", () => {
    root.dataset.open = "true";
    renderPanel(root);
  });
  root.querySelector('[data-dc-action="close"]')?.addEventListener("click", () => {
    root.dataset.open = "false";
    renderPanel(root);
  });
  root.querySelector('[data-dc-action="demo"]')?.addEventListener("click", () => {
    api.createDemoData();
    root.dataset.open = "true";
    renderPanel(root);
  });
  root.querySelector('[data-dc-action="export"]')?.addEventListener("click", () => downloadJson(api.getState()));
  root.querySelector('[data-dc-input="excel-file"]')?.addEventListener("change", (event) => {
    loadExcelFile(event.currentTarget.files?.[0], root);
  });
  root.querySelector('[data-dc-input="sheet"]')?.addEventListener("change", (event) => {
    const pending = pendingExcelImport;
    if (!pending?.workbook) return;
    try {
      const slotCounts = readSlotCounts(root);
      const sheetName = event.currentTarget.value;
      const nextParsed = sheetName === pending.promptSheetInfo?.sheetName && pending.promptSheetParsed
        ? pending.promptSheetParsed
        : parseExcelSheet(pending.workbook, sheetName);
      pendingExcelImport = {
        ...pending,
        sheetName,
        slotCounts,
        parsed: nextParsed,
        promptSheetParsed: nextParsed.kind === "prompt-template" ? nextParsed : pending.promptSheetParsed,
      };
      renderPanel(root);
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  });
  root.querySelectorAll('[data-dc-input^="slot-"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (!pendingExcelImport) return;
      try {
        pendingExcelImport.slotCounts = readSlotCounts(root);
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error));
        input.value = String(pendingExcelImport.slotCounts[input.dataset.dcInput.replace("slot-", "")]);
      }
    });
  });
  root.querySelector('[data-dc-action="clear-excel"]')?.addEventListener("click", () => {
    pendingExcelImport = null;
    renderPanel(root);
  });
  root.querySelector('[data-dc-action="confirm-excel"]')?.addEventListener("click", () => {
    const pending = pendingExcelImport;
    if (!pending?.parsed?.rows?.length) return;
    try {
      if (pending.parsed.kind === "prompt-template") {
        const promptTemplates = promptTemplatesFromParsed(pending.parsed);
        const slotCounts = readSlotCounts(root);
        const result = api.importPromptProducts({
          fileName: pending.fileName,
          kind: pending.kind,
          fileSha256: pending.fileSha256,
          sheetName: pending.sheetName,
          promptSheetName: pending.sheetName,
          promptTemplates,
          productRows: promptProductRowsFromParsed(pending.parsed),
          sourceRowNumbers: promptProductSourceRowsFromParsed(pending.parsed),
          headerMap: pending.parsed.headerMap,
          slotCounts,
          slotTemplates: buildSlotTemplates(slotCounts),
        });
        pendingExcelImport = null;
        root.dataset.open = "true";
        renderPanel(root);
        window.setTimeout(() => {
          root.querySelector(".guan-dc-prompt-template-label")?.scrollIntoView({ block: "nearest" });
        }, 0);
        return result;
      }
      if (pending.promptSheetInfo && normalizeHeader(pending.sheetName) === "data") {
        throw new Error("Data 是竞品参考数据，请切换到最后的提示词工作表后导入");
      }
      const slotCounts = readSlotCounts(root);
      const rows = pending.parsed.rows.map((row) => row.values);
      api.importRows({
        fileName: pending.fileName,
        kind: pending.kind,
        fileSha256: pending.fileSha256,
        sheetName: pending.sheetName,
        rows,
        sourceRowNumbers: pending.parsed.rows.map((row) => row.sourceRowNumber),
        headerMap: pending.parsed.headerMap,
        slotCounts,
        slotTemplates: buildSlotTemplates(slotCounts),
        promptSheetName: pending.promptSheetInfo?.sheetName,
        promptTemplates: promptTemplatesFromParsed(pending.promptSheetParsed),
      });
      pendingExcelImport = null;
      root.dataset.open = "true";
      renderPanel(root);
    } catch (error) {
      alert(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  root.querySelector('[data-dc-action="import"]')?.addEventListener("click", () => {
    const textarea = root.querySelector('[data-dc-input="rows"]');
    try {
      const rows = JSON.parse(textarea?.value || "[]");
      if (!Array.isArray(rows)) throw new Error("必须是数组");
      api.importRows({
        fileName: "本地导入产品行.json",
        kind: "json",
        rows,
        slotTemplates: [
          { slotId: "main-01", kind: "image", purpose: "product-main", sequence: 1, displayName: "主图 1", required: true, ratio: "1:1", resolution: "2k" },
          { slotId: "secondary-01", kind: "image", purpose: "product-secondary", sequence: 1, displayName: "副图 1", required: true, ratio: "3:4", resolution: "2k" },
          { slotId: "detail-01", kind: "image", purpose: "product-detail", sequence: 1, displayName: "详情图 1", required: true, ratio: "3:4", resolution: "2k" },
        ],
      });
      root.dataset.open = "true";
      renderPanel(root);
    } catch (error) {
      alert(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  root.querySelectorAll('[data-dc-action="init-tasks"]').forEach((button) => {
    button.addEventListener("click", () => {
      initTasksForProduct(button.dataset.productId);
      root.dataset.open = "true";
      renderPanel(root);
    });
  });
}

function mount() {
  if (document.getElementById("guan-data-contract-root")) return;
  const root = document.createElement("div");
  root.id = "guan-data-contract-root";
  root.dataset.open = "false";
  const placeRoot = () => {
    // The archived page hydrates its active workspace inside a Radix dialog
    // after DOMContentLoaded. Body-level siblings are then aria-hidden/inert
    // and sit beneath the dialog overlay, so follow that accessible layer.
    const mountTarget = document.querySelector('[role="dialog"]') || document.body;
    if (root.parentElement !== mountTarget) mountTarget.appendChild(root);
    renderHeaderControls(root);
  };
  placeRoot();
  const mountObserver = new MutationObserver(() => requestAnimationFrame(placeRoot));
  mountObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["role"] });
  const placementTimer = window.setInterval(() => {
    placeRoot();
    if (document.querySelector('[role="dialog"]')) window.clearInterval(placementTimer);
  }, 100);
  requestAnimationFrame(placeRoot);
  try {
    renderPanel(root);
  } catch (error) {
    root.innerHTML = `
      <section class="guan-dc-error" role="alert">
        <strong>本地数据读取失败</strong>
        <p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
      </section>
    `;
  }
  window.addEventListener(CHANGE_EVENT, () => {
    renderHeaderControls(root);
    if (root.dataset.open === "true") renderPanel(root);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
