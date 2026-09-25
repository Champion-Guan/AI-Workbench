# AI 生图工作台统一数据合同 v1

状态：v1 最小数据链已接入本地工作台；已支持本地 Excel/CSV 解析与确认导入
设计日期：2026-09-25  
适用范围：Excel 产品导入、图片/视频生成、提示词翻译、Fallback、素材库、无限画布、视频剪辑、批量下载

## 1. 设计目标

统一合同只解决一件核心事情：

> 任何图片、视频、提示词和生成结果，都必须能够准确追溯到一个产品、一个产品任务位和一次生成运行。

合同需要同时被以下模块使用：

1. 当前 AI 生图工作台的运营模式。
2. GPT Image Playground 的提示词、参数、任务、Fallback 和本地持久化能力。
3. Infinite Canvas 的节点、连线、参考图和生成工作流。
4. BeatDesign 的项目素材库、视频时间线和导出结果。
5. 未来的 ComfyUI 高级工作流适配器。

本合同是业务数据合同，不等于某一个项目的数据库表结构。不同实现可以使用 IndexedDB、SQLite、JSON 或其他本地存储，但对外读写的字段语义必须一致。

当前实现说明：

- 合同对象与关联元数据存放在浏览器 `localStorage`，页面刷新后保留。
- 工作区顶部提供已上传 Excel 的选择框和新增上传按钮；文件在浏览器本地解析，先选择工作表并预览，再确认写入合同。左下角“数据”面板只用于查看产品、槽位和任务明细。
- 运营界面不展示 JSON 导入/导出入口；JSON 仅作为内部合同 API 的开发验证格式保留。
- 导入时每个非空数据行对应一个 `Product`，保留 Excel 原始行号、全部原始字段、工作表名和文件 SHA-256；空白行不创建产品。
- 每个产品默认建立 1 个主图、10 个副图和 6 个详情图 `ProductSlot`，可在确认导入前调整。
- `Asset` 当前持久化文件元数据和 `storageKey`，不保存图片二进制；接入生成器/素材存储后再写真实文件。
- 当前核心引用链是 `ProductSet → Product → ProductSlot → GenerationTask → Asset`。TaskGroup 暂时仅以 `taskGroupId` 分组标识保留，不单独落表。

## 2. 总体关系

```text
Workspace
  └─ ProductSet（一次 Excel 导入）
       └─ Product（Excel 一行）
            ├─ PromptSpec（中文、英文和提示词版本）
            ├─ TaskGroup（一个产品的一整套生成计划）
            │    └─ GenerationTask（主图/副图/详情图/视频的单个任务位）
            │         ├─ GenerationRun（一次实际提交和重试）
            │         │    └─ ProviderAttempt（某一个中转站的尝试）
            │         └─ Asset（输出图片/视频/PSD/ZIP）
            ├─ CanvasDocument（画布中的产品、提示词、任务和素材节点）
            └─ Timeline（视频剪辑时间线，引用具体 Asset）
```

## 3. 通用规则

### 3.1 ID 规则

- 所有实体都有稳定的 `id`，推荐使用 UUID 或带前缀的 UUID。
- ID 一旦创建不得复用。
- 展示名称可以修改，ID 不随名称修改。
- 业务关联一律使用 ID，不使用数组下标、文件名或页面位置。

推荐前缀：

```text
ws_       Workspace
set_      ProductSet
prod_     Product
imp_      ImportRecord
prompt_   PromptSpec
group_    TaskGroup
task_     GenerationTask
run_      GenerationRun
att_      ProviderAttempt
asset_    Asset
canvas_   CanvasDocument
node_     CanvasNode
edge_     CanvasEdge
tl_       Timeline
clip_     TimelineClip
```

### 3.2 时间和版本

- 时间统一使用 ISO 8601 UTC 字符串，例如 `2026-09-25T08:00:00.000Z`。
- 每个可编辑实体保留 `createdAt`、`updatedAt`。
- 每次提示词或任务设置变化增加 `revision`。
- 已提交的 `GenerationRun` 必须保存提交时的不可变快照，不能随着当前设置变化。

### 3.3 最重要的绑定原则

以下字段在任务和结果中必须存在：

```text
productId
taskGroupId
taskId
slotId
```

因此不能出现“所有图片都在一个结果列表里，只靠图片顺序猜属于哪个产品”的结构。

## 4. Workspace

Workspace 是本地工作台容器，不代表用户账号，也不需要登录。

```ts
interface Workspace {
  schema: "guan-workbench.v1";
  id: string;                    // ws_xxx
  name: string;
  locale: "zh-CN";
  platform: "Wildberries";
  language: "ru";
  storageMode: "local-only";
  createdAt: string;
  updatedAt: string;
  activeProductSetId?: string;
}
```

约束：

- 当前固定平台为 `Wildberries`。
- 当前固定语言为 `ru`，但提示词合同仍保留源语言和目标语言字段。
- API Key 不放进普通项目导出文件，使用本地 `credentialRef` 或单独加密配置保存。

## 5. ProductSet 和 Excel 导入

一个 Excel 文件是一个 `ProductSet`，Excel 的一行是一个 `Product`。

```ts
interface ProductSet {
  id: string;                    // set_xxx
  workspaceId: string;
  source: {
    kind: "xlsx" | "xls" | "csv" | "json"; // json 仅供开发验证入口使用
    fileName: string;
    fileSha256?: string;
    sheetName?: string;
    importedAt: string;
  };
  productIds: string[];          // 保持 Excel 行顺序
  status: "draft" | "ready" | "archived";
  createdAt: string;
  updatedAt: string;
}

interface ImportRecord {
  id: string;                    // imp_xxx
  productSetId: string;
  sourceRowNumber: number;       // Excel 中的真实行号，从 1 开始
  sourceRowKey: string;          // 稳定行键，优先使用 SKU，否则使用文件哈希+行号
  headerMap: Record<string, string>;
  rawValues: Record<string, string | number | boolean | null>;
  importedAt: string;
}
```

## 6. Product

`Product` 是整个合同的业务根节点。

```ts
interface Product {
  id: string;                    // prod_xxx
  workspaceId: string;
  productSetId: string;
  importRecordId: string;
  order: number;                 // Excel 中的产品顺序
  identity: {
    sku?: string;
    externalProductId?: string;
    titleZh?: string;
    titleRu?: string;
  };
  attributes: Record<string, string | number | boolean | null>;
  sourceAssets: string[];        // 真实产品主体图等输入 Asset ID
  subjectLock: {
    enabled: boolean;
    referenceAssetIds: string[];
    instruction: "preserve-product-identity";
  };
  taskGroupIds: string[];
  status: "draft" | "ready" | "running" | "partial" | "done" | "error";
  createdAt: string;
  updatedAt: string;
}
```

### 产品主体锁定规则

- 没有上传真实产品图时，`subjectLock.enabled` 可以是 `false`。
- 上传真实产品主体图后，必须将主体图 Asset ID 写入 `referenceAssetIds`。
- 所有引用主体图的生成任务必须把这些 Asset ID 写入 `inputAssetIds`。
- 生成提示词中必须包含产品主体保持约束。
- 不能只在页面上显示“锁定”，而不写入任务快照。

## 7. PromptSpec

提示词必须同时保存中文原文、英文译文、最终提交文本和版本。

```ts
type PromptPurpose =
  | "product-main"
  | "product-secondary"
  | "product-detail"
  | "product-a-plus"
  | "product-video"
  | "custom";

interface PromptSpec {
  id: string;                    // prompt_xxx
  productId: string;
  purpose: PromptPurpose;
  slotId: string;
  revision: number;
  source: {
    language: "zh-CN";
    text: string;
  };
  translation: {
    language: "en";
    text: string;
    status: "pending" | "translated" | "edited" | "approved";
    engine?: string;
  };
  finalPrompt: {
    language: "en";
    text: string;
    visibleBeforeSubmit: true;
  };
  constraints: {
    preserveSubject: boolean;
    preserveBrandText: boolean;
    preserveLayout?: boolean;
    negativePrompt?: string;
  };
  variables?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}
```

原则：

- UI 默认直接展示 `finalPrompt.text`，不需要先点击选择某条任务。
- 任务提交后，将 PromptSpec 的完整内容复制到 `GenerationRun.promptSnapshot`。
- 后续修改提示词不会改变历史结果的提示词记录。

## 8. 产品任务位和 TaskGroup

一个产品的一整套图片不是一个“批量数字”，而是一组有明确槽位的任务。

```ts
type SlotKind = "image" | "video";

interface ProductSlot {
  id: string;                    // 实现层稳定行 ID
  slotId: string;                // 例如 main-01、secondary-03、detail-06
  productId: string;
  kind: SlotKind;
  purpose: PromptPurpose;
  sequence: number;              // 同一 purpose 内从 1 开始
  displayName: string;           // 例如「主图 1」「副图 3」
  required: boolean;
  ratio?: string;                // 例如 1:1、3:4
  resolution?: "1k" | "2k" | "4k";
}

interface TaskGroup {
  id: string;                    // group_xxx
  productId: string;
  productOrder: number;
  slots: ProductSlot[];
  status: "draft" | "queued" | "running" | "partial" | "done" | "error";
  createdAt: string;
  updatedAt: string;
}
```

当前最小实现不单独保存 `TaskGroup` 实体；`Product.taskGroupIds` 和 `GenerationTask.taskGroupId` 暂作同一产品任务集合的分组标识，实际外键主链仍是 `Product → ProductSlot → GenerationTask`。

推荐的首批结构：

```text
prod_001
├─ main-01        主图 1
├─ secondary-01   副图 1
├─ ...
├─ secondary-10   副图 10
├─ detail-01      详情图 1
├─ ...
└─ detail-06      详情图 6
```

`n` 只表示同一个 `GenerationTask` 的候选输出数量，不能代替产品槽位。

## 9. GenerationTask

`GenerationTask` 对应一个“产品 + 槽位”，是任务与结果绑定的核心。

```ts
interface GenerationTask {
  id: string;                    // task_xxx
  workspaceId: string;
  productId: string;
  taskGroupId: string;
  slotId: string;
  order: {
    productOrder: number;
    slotOrder: number;
  };
  kind: "image" | "video";
  promptId: string;
  inputAssetIds: string[];
  settings: {
    ratio: string;
    resolution: "1k" | "2k" | "4k";
    count: number;               // 同一个槽位的候选输出数量
    format?: "png" | "jpeg" | "webp";
    transparentBackground?: boolean;
    durationSeconds?: number;
    modelHint?: string;
  };
  status: "draft" | "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  activeRunId?: string;
  outputAssetIds: string[];
  createdAt: string;
  updatedAt: string;
}
```

### 任务幂等键

```text
idempotencyKey =
  productId + ":" + slotId + ":" + promptRevision + ":" + settingsHash + ":" + inputAssetsHash
```

同一个幂等键重复提交时，应提示“已有相同任务”，而不是悄悄创建无法区分的重复任务。

## 10. GenerationRun 和 ProviderAttempt

一次任务可以有多个中转站尝试，但仍然只属于同一个 `GenerationTask`。

```ts
interface GenerationRun {
  id: string;                    // run_xxx
  taskId: string;
  productId: string;
  promptSnapshot: PromptSpec;
  inputAssetIds: string[];
  settingsSnapshot: GenerationTask["settings"];
  fallbackPolicySnapshot: FallbackPolicySnapshot;
  attemptIds: string[];          // 指向工作区中的 ProviderAttempt 记录
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "paused";
  outputAssetIds: string[];
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

interface FallbackPolicySnapshot {
  enabled: boolean;
  orderedProviderIds: string[];
  maxAttempts: number;
}

interface ProviderAttempt {
  id: string;                    // att_xxx
  runId: string;
  providerId: string;
  providerName: string;
  model: string;
  attemptOrder: number;
  status: "queued" | "running" | "succeeded" | "failed" | "unknown" | "skipped";
  requestId?: string;
  externalTaskId?: string;
  startedAt?: string;
  finishedAt?: string;
  retryable?: boolean;
  errorCode?: string;
  errorMessage?: string;
  responseMeta?: Record<string, unknown>;
}
```

Fallback 规则：

- Fallback 只新增 `ProviderAttempt`，不新增 `GenerationTask`。
- 明确余额不足、模型不存在、接口明确失败，可以进入下一站。
- 网络断开、结果不完整或状态未知，默认暂停，不自动重复扣费。
- 每个中转站的真实请求顺序必须可在任务详情中查看。
- IXYAPI 余额耗尽标记保留在本地 Provider 状态，不改变历史任务。

## 11. Asset

所有上传、生成、导出和派生文件统一进入素材库。

```ts
type AssetKind = "image" | "video" | "audio" | "psd" | "zip" | "mask" | "other";

interface Asset {
  id: string;                    // asset_xxx
  workspaceId: string;
  productId?: string;
  taskId?: string;
  slotId?: string;               // 与 task.productId + task.slotId 对应
  runId?: string;
  kind: AssetKind;
  role?: PromptPurpose | "source" | "reference" | "mask" | "export";
  sequence?: number;
  outputIndex?: number;
  file: {
    storageKey: string;          // IndexedDB/本地文件的逻辑键
    originalName?: string;
    downloadName: string;
    mimeType: string;
    bytes?: number;
    sha256?: string;
    width?: number;
    height?: number;
    durationMs?: number;
  };
  lineage?: {
    parentAssetIds: string[];
    sourceTaskId?: string;
    operation: "upload" | "generate" | "edit" | "mask-edit" | "extract-frame" | "export";
  };
  status: "available" | "missing" | "deleted";
  createdAt: string;
  updatedAt: string;
}
```

排序规则：

```text
productOrder
→ purposeOrder（main, secondary, detail, a-plus, video）
→ sequence
→ outputIndex
→ createdAt
```

不能使用接口返回顺序作为最终排序。

PSD 规则：

- PSD 是可选的派生 Asset，不是默认输出类型。
- PSD 必须关联原始图片 Asset 和 `parentAssetIds`。
- 如果没有真正的分层文件，不得把普通 PNG 改名为 PSD。

## 12. CanvasDocument

画布只保存业务对象引用，不复制整份任务或图片数据。

```ts
interface CanvasDocument {
  id: string;                    // canvas_xxx
  workspaceId: string;
  productId?: string;            // 产品运营画布建议绑定一个产品
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

type CanvasNodeRef =
  | { type: "product"; id: string }
  | { type: "prompt"; id: string }
  | { type: "task"; id: string }
  | { type: "asset"; id: string }
  | { type: "timeline"; id: string };

interface CanvasNode {
  id: string;                    // node_xxx
  ref: CanvasNodeRef;
  nodeType: "product" | "prompt" | "generation" | "asset" | "timeline" | "group";
  position: { x: number; y: number };
  size?: { width: number; height: number };
  title?: string;
}

interface CanvasEdge {
  id: string;                    // edge_xxx
  sourceNodeId: string;
  targetNodeId: string;
  relation: "reference" | "derived-from" | "feeds" | "compare";
}
```

画布节点移动、缩放和连线不会改变业务实体；删除画布节点也不能删除素材或生成任务。

## 13. Timeline

视频时间线引用确定的 Asset，不跟随画布节点的最新结果自动变化。

```ts
interface Timeline {
  id: string;                    // tl_xxx
  workspaceId: string;
  productId?: string;
  name: string;
  durationMs: number;
  tracks: TimelineTrack[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface TimelineTrack {
  id: string;
  type: "video" | "image-overlay" | "audio" | "caption";
  clips: TimelineClip[];
}

interface TimelineClip {
  id: string;                    // clip_xxx
  assetId: string;               // 锁定具体素材版本
  startMs: number;
  durationMs: number;
  trimInMs?: number;
  trimOutMs?: number;
  transform?: Record<string, number>;
  caption?: Record<string, string | number>;
}
```

## 14. ProviderProfile

Provider 配置和业务任务分离。任务只保存配置快照，不依赖当前配置才能解释历史结果。

```ts
interface ProviderProfile {
  id: string;                    // provider_xxx
  name: string;
  protocol: "openai-images" | "openai-responses" | "custom";
  baseUrl: string;
  credentialRef: string;          // 指向本地安全存储，不在普通导出中展开
  capabilities: Array<"image" | "video" | "audio" | "text">;
  models: Array<{
    id: string;
    capabilities: string[];
  }>;
  enabled: boolean;
  priority: number;
  costHint?: {
    unit: "image" | "second" | "request";
    amount?: number;
    currency?: string;
  };
  updatedAt: string;
}
```

当前四个图片中转站可分别映射为四个 `ProviderProfile`。`zzone` 的 `/v1` 地址测试确认后再写入正式配置，不在合同中写死错误地址。

## 15. 一个产品的完整示例

```json
{
  "product": {
    "id": "prod_001",
    "productSetId": "set_wb_20260925",
    "order": 1,
    "identity": {
      "sku": "WB-001",
      "titleZh": "女士针织衫"
    },
    "subjectLock": {
      "enabled": true,
      "referenceAssetIds": ["asset_source_001"],
      "instruction": "preserve-product-identity"
    }
  },
  "taskGroup": {
    "id": "group_prod_001",
    "productId": "prod_001",
    "slots": [
      {
        "slotId": "main-01",
        "kind": "image",
        "purpose": "product-main",
        "sequence": 1,
        "displayName": "主图 1",
        "required": true,
        "ratio": "1:1",
        "resolution": "2k"
      },
      {
        "slotId": "secondary-01",
        "kind": "image",
        "purpose": "product-secondary",
        "sequence": 1,
        "displayName": "副图 1",
        "required": true,
        "ratio": "3:4",
        "resolution": "2k"
      },
      {
        "slotId": "video-01",
        "kind": "video",
        "purpose": "product-video",
        "sequence": 1,
        "displayName": "短视频 1",
        "required": false,
        "ratio": "9:16",
        "resolution": "2k"
      }
    ]
  },
  "task": {
    "id": "task_prod_001_main_01",
    "productId": "prod_001",
    "taskGroupId": "group_prod_001",
    "slotId": "main-01",
    "kind": "image",
    "promptId": "prompt_prod_001_main_01",
    "inputAssetIds": ["asset_source_001"],
    "outputAssetIds": ["asset_output_001"],
    "status": "succeeded"
  },
  "output": {
    "id": "asset_output_001",
    "productId": "prod_001",
    "taskId": "task_prod_001_main_01",
    "kind": "image",
    "role": "product-main",
    "sequence": 1,
    "outputIndex": 0,
    "file": {
      "storageKey": "image:prod_001:main-01:output-0",
      "downloadName": "WB-001_main-01_01.png",
      "mimeType": "image/png"
    }
  }
}
```

## 16. 状态流转

### 产品

```text
draft → ready → running → partial → done
                         ↘ error
```

### 单个任务

```text
draft → queued → running → succeeded
                         ↘ partial
                         ↘ failed
                         ↘ cancelled
```

### Fallback

```text
attempt-1 running
  ├─ succeeded → run succeeded
  ├─ explicit failure → attempt-2
  └─ unknown/network pause → run paused
```

## 17. 适配三个现有项目

### GPT Image Playground

- `TaskRecord.id` 映射为 `GenerationTask` 或 `GenerationRun` 的外部来源 ID。
- `inputImageIds` 映射为 `inputAssetIds`。
- `outputImages` 映射为 `Asset.id` 列表。
- `apiAttempts` 映射为 `ProviderAttempt[]`。
- `params` 映射为 `GenerationTask.settings`。
- `revisedPromptByImage` 映射为每个输出 Asset 的提示词元数据。
- 现有本地 IndexedDB 继续作为存储适配器，不直接暴露给运营 UI。

### Infinite Canvas

- Canvas 节点只保存 `CanvasNodeRef`。
- 图片/视频节点的生成配置映射为 `GenerationTask`。
- 画布生成结果进入统一 `Asset`，不在节点内复制一份图片。
- 画布连线映射为 `CanvasEdge` 的业务关系。

### BeatDesign

- Project 映射为 `Workspace` 或工作区内的项目视图。
- Asset 映射为统一 `Asset`。
- Canvas card 映射为 `CanvasNode`。
- Timeline clip 映射为 `TimelineClip`，固定引用具体 Asset。
- Editor 导出的 MP4 创建新的 `Asset(kind="video", role="export")`。

## 18. 第一阶段只实现的最小集合

第一期不需要一次实现全部合同，只需先落地以下字段：

1. `ProductSet`
2. `Product`
3. `ProductSlot`
4. `PromptSpec`
5. `GenerationTask`
6. `GenerationRun`
7. `ProviderAttempt`
8. `Asset`

暂缓：

- `Timeline` 的完整剪辑参数
- PSD 分层内部结构
- ComfyUI 工作流 JSON
- Agent/MCP 操作日志
- 跨设备同步

当前代码已经完成 ProductSet、Product、ProductSlot、PromptSpec、GenerationTask、GenerationRun、ProviderAttempt 和 Asset 的最小对象结构及本地持久化。`ImportRecord` 保存 Excel/CSV/JSON 行入口的行号与原始字段；Excel/CSV 已在本地浏览器解析并在确认后写入合同。尚未接入 AI 服务调用或图片二进制落盘；演示数据中的素材明确标记为 `missing`，不会伪装成已生成的图片。

## 19. 验收标准

合同接入后，首批最新 2 到 3 份 Excel 至少要满足：

1. 导入后每一行对应一个唯一 `Product.id`。
2. 一个产品的主图、副图、详情图不会进入其他产品的任务组。
3. 任务列表能够按产品展开，并显示 `主图 1 / 副图 3 / 详情图 6` 等槽位名称。
4. 每个任务在提交前可直接看到最终英文提示词。
5. Fallback 切换后，任务详情能看到每一次中转站尝试。
6. 图片返回顺序异常时，仍按 `productOrder + slotOrder + outputIndex` 展示。
7. 批量下载文件名包含 SKU 或 `productId`、槽位名和输出序号。
8. 页面刷新或服务重启后，产品、任务、提示词、尝试记录和素材关联不丢失。
9. 画布删除节点不会删除产品任务和素材。
10. 视频时间线引用的是明确 Asset，不会因画布产生新版本而静默替换。

## 20. 兼容与演进

- 根合同版本使用 `schema: "guan-workbench.v1"`。
- 新增字段默认可选，删除字段必须提升主版本。
- 外部项目适配器只允许转换合同，不得在 UI 中维护第二套产品 ID。
- 所有导入、迁移和批量生成前先保存本地备份。
- 任何无法识别的 `schema` 版本不得覆盖现有数据，应写入隔离的恢复文件。
