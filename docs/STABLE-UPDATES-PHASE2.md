# Stable 自动更新：阶段 2 基础改造记录

日期：2026-10-10。本记录描述已完成的基础改造，不代表自动更新系统或阶段 2 整体已验收。

最终目标已固定于 `docs/PROJECT-GOAL.md`，项目 `AGENTS.md` 要求后续更新工作读取目标和本阶段记录。

## 已完成的完整备份

私有备份目录：

`/Users/guanchengbin/CodexProjects/guan-ai-workbench-projects/guan-ai-workbench-backups/pre-stable-updater-20261010-170731-4zOH7C/`

- `project-complete.tar.gz`：整个当前项目，含 Git、依赖、未跟踪代码和输出，无排除项，约 267 MB。
- `active-proxy-runtime.tar.gz`：正在使用的代理临时配置和用户态核心，约 20 MB。
- `guan-workbench-full-browser-backup-20261010-170731.json`：真实 Chrome 工作台浏览器存储，约 168 MB。不是测试浏览器的空数据库。
- 各文件 SHA-256 见该目录 `BACKUP-README.md`。

目录权限 0700、备份文件 0600。备份含私人凭证，未加密，禁止提交到 GitHub、放入 Stable Release 或共享。

隔离恢复演练已完成：不同端口、独立 Playwright 浏览器、空白页面，无生产应用代码运行，也无外网请求。恢复并逐项比较了 316 个 localStorage 项、3 个 sessionStorage 项、两个数据库的版本和结构、143 条记录及其中所有 Blob/File 的二进制内容。图片库与缩略图库各 56 条，prompt_cache 28 条，app_state 2 条。当前数据没有 autoIncrement 存储；不能将本次验证推广为任意数据库自增序列、外部文件、Cookies、Keychain 或 WebDAV 服务器的完整恢复验证。

恢复工具仅用于隔离演练，拒绝原 Origin、5174 端口及非空测试环境。它不是生产恢复入口；中途失败的测试副本不能直接重复覆盖，必须使用新的空白隔离环境。

## 已完成的代码

| 文件 | 作用 |
| --- | --- |
| `src/server/runtime-paths.mjs` | 私人目录定位、权限、copy-once 兼容、原子落盘、写入队列、代理状态验证 |
| `src/server/index.mjs` | 使用私人运行目录，保存代理开关、来源和订阅缓存，串行配置变更及失败恢复，本地健康检查 |
| `src/server/proxy-service.mjs` | 私人配置及核心缓存位置，兼容旧核心位置，向后端返回已解析配置用于离线重启 |
| `config/examples/default-proxy.yaml` | 无私人节点和凭证的公共配置模板 |
| `.gitignore` | 排除私人代理配置、个人迁移目录、运行状态、备份及私钥文件 |
| `scripts/lib/browser-backup-codec.mjs` | 逻辑备份编码/解码，保留 Blob/File、结构化类型与引用，防止原型污染 |
| `scripts/verify-browser-backup.mjs` | 空白隔离 Origin 的浏览器备份恢复及逐项核验工具，不进入生产服务 |
| `tests/runtime-paths.test.mjs` | 路径、权限、copy-once、损坏配置、原子写入和并发验证 |
| `tests/private-runtime-integration.test.mjs` | 真正启动独立服务及假 Mihomo 核心，验证重启、离线恢复、失败回退、敏感信息脱敏 |
| `tests/browser-backup-codec.test.mjs` | 结构化数据、大图片、无效引用和原型污染防护 |
| `tests/fixtures/fake-mihomo.mjs` | 仅本机测试监听器，不使用真实节点、不发送 AI 请求 |

## 私人目录与兼容策略

macOS 默认位置：

```text
~/Library/Application Support/GuanAIWorkbench/
  data/
    config/runtime.env
    proxy/profile.yaml
    proxy/state.json
    proxy/core/
    runtime/image-relay-transports.json
  logs/
  backups/
  updates/
```

`GUAN_WORKBENCH_DATA_DIR` 仅接受绝对路径，不允许系统根目录、用户主目录、项目根及项目子目录。测试始终使用独立临时目录，并预填所有私人配置目的文件，避免复制真实凭证。

首次安全启动新服务时，旧 `.env.local`、`config/default-proxy.yaml`、`.image-relay-transports.json` 仅在目的文件不存在时复制。已有目的文件优先，旧文件不移动、不删除。读到损坏的代理状态时保留原文件，禁止代理配置变更，但工作台服务仍可启动。

`state.json` 保存代理开关、图片中转开关、配置来源、名称和最近成功解析的订阅内容。缓存含节点凭证，权限 0600；目前不是 Keychain 密钥存储。重新启用或重启时可以使用缓存，不依赖订阅网络。重新提交订阅 URL 则会明确重新拉取订阅。

配置变更串行处理；新配置启动或状态保存失败，尝试恢复旧代理运行状态。旧代理恢复也失败时明确报错，保留旧配置，不以默认配置覆盖。不声称解决所有核心异常退出或系统断电事务问题。

健康检查：`GET /local-app/health`，仅接受现有允许的本机 Host/Origin。返回应用版本、源码指纹、进程实例标识和代理状态，不返回文件路径或凭证。当前 buildId 是开发指纹，不能当作后续签名 Release 的构建身份。

## 当前生产环境边界

- 用户原工作台仍为 `http://127.0.0.1:5174`，未重启原服务、未变更 Origin。
- 新代码只在磁盘和隔离服务中验证，尚未向当前使用环境启用迁移。
- IndexedDB、localForage、localStorage 中的业务数据仍在原浏览器 Origin，不迁到文件数据库。
- 未迁移或删除浏览器中的 API Key、WebDAV 凭据、历史、画布或工作簿。
- 工作台 UI/样式/动画保护区与实施前备份保持一致。没有重新构建或发布前端资源。
- 没有 Git 提交、GitHub 上传、Release 发布、自动安装或生产进程切换。
- Git 恢复标签只标识现有提交，不包含未提交/未跟踪工作；完整文件归档才是真实备份。

## 测试与可复现演练

```bash
npm test
npm --prefix src/canvas run typecheck
node --check src/server/index.mjs
node scripts/verify-browser-backup.mjs
```

最后一条会打印临时隔离地址。必须使用新的独立测试浏览器，只在该页面选择本机备份文件，结果只显示脱敏数量。不要把恢复脚本粘贴到原工作台。由于测试副本包含密钥，完成演练后应关闭并清理**这一独立测试会话**，保留原备份。

已验证：GitHub 更新相关代码尚未启用；当前回归、类型检查、代理的保存/重启/订阅断网/坏配置/并发启用/状态文件损坏/写入失败恢复测试，以及实际浏览器备份恢复测试。

本轮完整 `npm test` 共 140 项通过，TypeScript typecheck 通过。基础改造专项测试 13 项通过；前端 UI 保护区与改造前完整项目备份逐字对照一致。

## 阶段 2 仍需完成后才能验收

1. 建立生产切换前的安全交接：重新确认所有画布、Agent、网络请求、后台任务和 WebDAV 同步都空闲；捕获当前运行代理的有效配置及开关。不能假设旧项目默认 YAML 与用户本次上传、运行中的配置相同。
2. 进行首次私人配置初始化和完整对照。只有对照成功，才允许重启原服务。原文件和原浏览器备份持续保留。
3. 实现更新空闲屏障与 WebDAV 互斥，不能仅根据顶部胶囊判断可安装。
4. 完成 Stable 白名单打包、提交前/历史敏感扫描，以及原有打包器的隔离验证。`.gitignore` 不会清理已跟踪内容或历史，不能据此声称没有泄露。
5. API Key/Keychain 和后端密钥代理按审计方案分阶段接入；自定义模型脚本不能直接在持有 Keychain 密钥的主服务中执行。完成验证前继续保留旧配置。

阶段 3 的真实 GitHub 联调需要用户指定私有仓库 owner/name 和每台 Mac 的独立授权流程。不要通过聊天发送 Token，不将 Token 放入前端。阶段 4 的可信签名、阶段 5 的 launchd 安装/回滚，以及两台实体 Mac 的验收均尚未实施，不能提前开启自动安装。

## 2026-10-10 后续安全基础进展

- `src/server/activity-gate.mjs`：业务操作租约、预期参与者/覆盖域、心跳过期保护、暂停 epoch、静默时间和安装屏障。当前后端已跟踪整个图片中转和代理变更操作；图片路由学习的落盘也在中转租约内等待完成。`GET /local-app/activity` 仅提供本地只读脱敏状态，不开放浏览器安装/清除任务接口。
- 旧页面及未接入的画布、后台生成、Agent、WebDAV、存储写入一律判定未知，不等同于空闲。前端完整库存注册、真实活动报告及暂停/恢复协作尚未接入，因此生产 `canInstall` 不会被放开。该模块是防护基础，不是完整业务空闲检测完成声明。
- `scripts/capture-runtime-handoff.mjs` 和 `scripts/lib/runtime-handoff.mjs`：从现有端口查明工作目录、入口和所属代理 supervisor，仅捕获真实运行核心的 applied YAML。读前后核对进程、配置及开关，目标必须是源码目录之外已有的 0700 私有目录；0600 独占写入，已有交接文件不覆盖。
- 已对当前 PID 32438、127.0.0.1:5174 做只读检查，并将实际运行的代理配置/开关存入原私有备份目录 `runtime-handoff-20261010-1800.json`。未改变当前代理或服务；源 YAML SHA-256 为 `316ce7e2d3cf9f2c861d76b81419d1f042c461b7f4515ce08a941db6fb8e787f`。旧服务没有原始订阅 URL 导出能力，交接保留有效 YAML，但不能声称完整恢复订阅 URL 元信息。交接记录明确 `activityVerified=false`、`installAllowed=false`，尚未导入正式私人运行目录。
- 新增 `scripts/scan-secrets.mjs`、`scripts/lib/secret-scan.mjs`，支持当前源码、暂存区、Git 历史、包目录扫描。只报告位置/规则/旧对象哈希，不报告匹配值。暂存扫描直接读取索引，不能被干净工作副本掩盖；不完整扫描、超大文件和软链接按阻断处理。
- `scripts/install-git-hooks.mjs` 已为此仓库安装 `.githooks/pre-commit`。不会替换已有自定义 hooks 或现有 pre-commit；没有暂存或提交代码。新电脑需要再次执行 `npm run secrets:install-hooks`，hooks 配置不由 Git 自动启用。
- 历史扫描覆盖 1,359 个 blob；两处命中核实为旧 devProxy 测试的 reserved example.com 占位账户，例外绑定完整对象 SHA、路径、行和规则，记录在 `config/security/secret-scan-reviewed.json`。标准 Office GUID 和 npm 的 uuid 模块路径不是代理密钥，已修正规则范围并测试。没有发现本扫描规则覆盖的未解决高置信真实凭证；这不是“所有秘密绝不存在”的保证，阶段 4 仍需独立成熟扫描器、依赖审查和 CI 门禁。没有轮换凭证或改写历史。
- `scripts/create-release.mjs` 改为便携运行文件白名单，排除整棵画布开发源码、测试、私人文件；公共代理模板放在 `config/examples/`，复用共享秘密扫描。便携 manifest 明确 `portable-unsigned`、`automaticInstallAllowed=false`。当前仍使用已有生产静态资源，并不等同于 Stable 的源码重建和可信签名链。
- `scripts/verify-release.mjs` 和 `scripts/lib/release-validation.mjs`：解压前校验 ZIP 路径、链接、重复名、本地/中央目录一致性、Unicode 别名与有界解压；校验精确文件集合、哈希、版本、入口及构建资源；子进程使用临时端口和临时私人数据根，禁用真实 Mihomo，并核对 PID/版本/构建/Origin。所有错误脱敏。此验证器会执行开发者本机提供的包，不接受远端包作为可信安装依据；真实更新必须先完成签名验证。
- 已完成本地未签名便携样包验证：313 个文件哈希、6 个 HTTP 页面/资源路由，通过；未上传或安装。后续源码变化会产生新样包，任何样包均不作为正式 Stable 发布。

阶段 2 尚需：前端所有活动域的真实接入、WebDAV/写入互斥和暂停协作，以及任务空闲后正式私人配置导入与原服务安全切换。用户已确认私有仓库尚未创建；真实 GitHub 授权、网络联调、CI 发布、数字签名、launchd 和两台实体 Mac 验收仍未进行。

本次续作验收：`npm test` 163 项全部通过；TypeScript typecheck 通过；当前源码扫描 878 个候选路径，无未解决命中；历史 1,359 个 blob，仅保留两条已核实占位凭证复核记录；暂存区当前为空。最新本地便携样包 `guan-ai-workbench-v1.0.3-20261010-095832.zip` 的 315 个文件哈希和 6 个页面/资源路由验证通过，SHA-256 为 `36a21671c435c1b347562695f2837627c2f57d124cc4c07fac0c9ea7df27e1c5`。命名时间为 UTC 构建标识，不代表新的正式版本发布。

`runtime-handoff-20261010-1800.json` 文件本身 SHA-256 为 `1805df15f56995af122001e8a69db2d6831c7ef72128a2b8d456bfb967037157`，含私人节点配置，权限 0600，禁止提交或分享。当前服务 PID 32438 未重启；源码内 UI 保护区与最初完整备份一致。此次没有 Git 提交、GitHub 创建/推送、正式发布、签名安装或真实用户数据迁移。

## 2026-10-10 前端活动观测接入（阶段 2 仍未整体验收）

本轮先创建 `restore/pre-frontend-activity-20261010`，并将改动前前端整目录（含当时依赖和构建）、后端及相关测试另存私有 `pre-frontend-activity-20261010.tar.gz`。SHA-256：`bc9e966d8d156b1892c6b5f0b739cedd6bd075a76488b8cab2fa93fa95e2a20e`。文件权限 0600，结合最初完整项目/浏览器备份使用。此备份不是 Release。

### 已接入范围

| 模块 | 作用 |
| --- | --- |
| `src/canvas/lib/update-activity.ts` | 独立业务活动计数与完整 Promise 租约；返回副本，观察器异常不破坏业务，不携带提示词/凭据 |
| `src/canvas/lib/activity-storage.ts` | 显式 localForage 实例适配器，保留原接收者、泛型和回调，只跟踪变更操作；没有全局替换 fetch/IndexedDB |
| `src/canvas/lib/localforage-storage.ts` | 从写入排队时就记录活动；不改变同步恢复副本、逐键队列或 tombstone 语义 |
| `src/canvas/services/update-activity-reporter.ts`、`main.tsx` | 每页面独立 UUID，单调序列、每 5 秒心跳、100ms 合并变化、4 秒请求超时；不改 DOM/CSS |
| `src/server/browser-activity.mjs`、`index.mjs` | 受限、内存有界、严格格式的同源观察接口；过期页面保留为未知，旧序列不能抹掉新忙状态 |
| `services/api/image.ts`、`audio.ts`、`video.ts` | 生图/改图/文本流式响应、音频及视频创建/查询/等待函数的完整调用周期 |
| `services/api/canvas-agent.ts` | Agent JSON 请求直到响应内容解析完成；另观察 Agent store 的运行/等待/审批状态 |
| `services/webdav-sync.ts`、`app-sync.ts` | 整体同步、独立并行域及并行子任务；一个域失败后，其余未完成操作继续计数 |
| `services/image-storage.ts`、`file-storage.ts` | 原文件缓存、解码/缩放、媒体元信息读取、变更/清理及待执行缩略图队列 |
| `services/api/prompts.ts` | 后台提示词刷新直到缓存保存完成 |
| 图片/视频工作台历史存储、`canvas-event-bus.ts` | 历史写入和插件提供的存储适配器；所有当前源码内 localForage 实例变更均接入 |

Agent 断线不是远端任务结束证据；此前忙状态保留，直到重新连接并获得非忙状态。工作台 Agent 任务从 queued/running 计数，只有明确 succeeded/failed 才释放；历史截断不释放已观测的未决任务。上述状态仍是 UI 侧辅助观察，不代替远端后端的任务终态证明。

### 协议和安全边界

- `POST /local-app/activity/report` 只接收精确同源 Origin、JSON、最大 2KiB，且仅允许 protocol/pageId/sequence/counts 四个字段。
- `GET /local-app/activity` 的 `observedBrowser` 仅是脱敏诊断。顶层 `counts/active` 仍属于原后端 gate；不要误将浏览器观察计数当成已证明的全业务库存。
- 浏览器报告不调用 gate 的 `verifyInventory`、`forgetParticipant`、暂停确认或安装入口。报告全零仍然 `unknown=true`、`canInstall=false`。
- 不用页面卸载的零报告释放任务，不按 TTL 删除记录。旧页、断线、关闭/刷新页面均不能悄悄消除未知状态。记录达到容量上限时拒绝新报告，不自动淘汰忙页。
- 更新屏障的暂停/恢复、互斥及可信完整库存尚未完成。本轮没有打开安装开关，也没有向网页提供系统命令。

### 验证结果和限制

- `npm test`：171 项通过，包括活动租约、异常、并发失败、队列写入、图片交付缩放、WebDAV body 超时、Agent 响应体读取、报告严格验证及真实隔离后端接口。
- TypeScript typecheck 与 Vite build 通过。构建仍有既有的大 bundle、混合静态/动态 import 和非 module Excel bridge 提示，不作为 Stable 可发布验收。
- 使用 Playwright 技能，在独立浏览器和临时端口 54848 测试新构建；禁止访问非测试 Origin，未连接真实 Agent、代理或 AI API。实际新建测试画布、打开图片工作台、两个标签页同时心跳、关页后心跳过期保留、刷新新页面记录均验证通过；未执行真实付费生成。
- `scripts/verify-frontend-activity.mjs` 是可复现的隔离前端静态/诊断测试服务器，没有生产数据、代理或安装能力。实际后端的 Origin/格式/脱敏/不可授权安装由独立集成测试验证。
- 独立构建目录缺少 logo.svg 与 plugins/index.json；旧公开仓库 VERSION 请求被测试网络防护阻止。生产 public 尚未重新发布，不据此宣称生产页面缺少资源；Stable 构建必须补齐这些资源并替换旧公开检查链。
- 服务器受保护 UI 字符串与本轮改动前逐字一致；未修改布局组件、样式文件或生产 public。仅构建 src/canvas/dist 作测试。
- 当前源码秘密扫描 884 候选路径无未解决命中；历史/暂存扫描继续按原复核规则执行，不代表能证明所有秘密不存在。
- 原服务 127.0.0.1:5174/PID 32438 未重启，原浏览器业务数据和实际代理未写入。没有 Git 提交、仓库创建、上传、正式发布或客户安装。

### 下一步必须先补齐的空闲证明

1. 在 `pages/canvas/project.tsx` 的 handleGenerateNode、批量任务和各工作台任务根入口跟踪整个任务，包括准备输入、排队、每一结果的本地保存及状态提交；API 函数返回不能当成整个任务完成。
2. 单独 createVideoGenerationTask/pollVideoGenerationTask 之间的轮询等待和已恢复远端任务，目前不能仅靠调用计数证明为空闲。取消/超时也不能假设上游已终止。
3. 可信协调器建立所有工作台窗口、缓存画布 iframe、旧页面、插件和外部 Agent 的完整库存及后端真实终态。自注册观察器看不到未注册旧页面，不能自行授予完整覆盖。
4. 设计“两步排空”：先封住新任务根入口，让已有任务及其子请求/落盘完成；全部排空后再冻结后端入口并进行 epoch/quiet 确认。不能一开始禁止旧任务的后续写入或请求，造成死锁或结果丢失。
5. WebDAV 新同步互斥、写入屏障、重连/BFCache/刷新/HMR、未知旧页和多窗口竞态演练通过后，才可进行首次生产配置交接/安全切换。
6. Keychain/后端 AI 密钥迁移、GitHub 认证及正式发布链按目标文档分阶段继续，不因本轮计数接入而提前声称阶段 2 全部通过。

本轮另存 25 文件源码检查点 `frontend-activity-source-20261010.tar.gz`，位置和 SHA-256 见私有备份目录的 `BACKUP-README.md`；它不包含完整用户数据，不替代原始完整备份。隔离测试浏览器和前端测试服务器已关闭，生产服务保留。

## 2026-10-10 任务生命周期与同步排空续作（阶段 2 仍未整体验收）

### 已实现代码

- `lib/unresolved-activity.ts`：远端未决任务租约。视频创建成功或恢复查询后，在请求之间仍保持活动；只有明确 completed/failed 才释放。取消、查询错误、超时、历史删除不证明上游结束。归属采用账户/渠道/任务的 SHA-256 opaque key，不上报或长期保留明文凭据；归属失败、容量溢出保留有界的未知阻断。
- `services/api/video.ts`：接入上述生命周期。它仍是前端观察，不是后端权威任务清单；请求已被上游接受但创建响应丢失、尚未获得 taskId 的情况仍未形成完整证明。
- `pages/canvas/project.tsx`：生成、重试、视频完成/轮询、批量生成、蒙版、放大与角度生成的根 Promise 接入活动范围；视口延迟保存从排队时即记录 storage 活动。
- 图片/视频工作台、Agent 事件与工具调用、插件生成入口：跟踪准备、网络等待、原件保存与返回的完整异步操作。图片历史保存改为实际等待，保存完成前不提交 Agent 成功状态或重试成功提示；保存失败不删除已缓存原件。
- `lib/settle-activity-group.ts`：所有已开始分支排空后再传播第一个失败，保留结果顺序。应用于 WebDAV 并行域、素材恢复、并发 worker、插件图片保存及画布图像/文本/批量生成，避免 Promise.all 提前释放根任务或同步锁。
- `lib/webdav-activity-lock.ts`、`services/app-sync.ts`：每页 FIFO，加同 Origin 原生 Web Locks exclusive 互斥；排队也计数。缺少 Web Locks 时保留原单页同步能力，但增加未知阻断，不宣称跨页安全。
- `services/update-activity-reporter.ts`：画布真实持久化的 saving/error 保持 storage 阻断，仅实际 saved 释放。未修改原存储恢复或默认配置语义。
- `tests/task-lifecycle.test.mjs`、`tests/helpers/frontend-activity.mjs` 及相关回归：使用实际活动/排空实现，不用 no-op 替代。`scripts/verify-frontend-activity.mjs --task-locks` 仅在隔离测试参数下提供从实际 helper 源码内存构建的测试模块，不进入生产路由。

### 已完成验证

- 完整回归 178/178 通过，TypeScript typecheck 与 Vite build 通过；既有 bridge、bundle 大小及混合 import 提示仍在，不代表 Stable 构建链已验收。
- 当前源码秘密扫描 889 候选无未解决命中；历史扫描 1,359 blob，仅两条精确绑定旧测试占位值的复核例外；暂存区为空。不能将规则扫描当作所有秘密不存在的证明。
- 使用 Playwright 技能，在独立 Origin `127.0.0.1:61206` 和两个独立页面验证实际 helper 与浏览器原生 Web Locks：第一组失败但子 Promise 未完成时，第二页持锁请求排队；子 Promise 完成后才解锁、第二页运行并返回，最终双方活动归零且无残留 WebDAV 锁。
- 此浏览器验证不是真实 WebDAV 服务端或真实付费生成的端到端测试；禁止非测试 Origin 网络请求，没有接触真实 Agent、AI、代理或用户配置。隔离浏览器及测试服务均已关闭。
- 与改动前归档逐字核对：5 个 TSX 文件的全部 JSX 根片段、18 个布局/样式文件及后端受保护界面块均一致，没有改动现有界面。
- 原 `127.0.0.1:5174` 服务 PID 32438 未重启，生产 public 未发布；本轮未迁移用户数据，未创建 GitHub 仓库、提交、推送或发布。自动安装仍禁止，浏览器计数不能授予安装权限。

### 下一步与剩余阻断

1. 补齐可信页面/iframe/插件/外部 Agent 的完整库存；旧页面、断线、刷新、关页及历史截断不能当作终态。视频创建响应丢失和未恢复远端任务仍需后端权威证明。
2. 完成 React 状态提交到持久化的 flush 确认。根 Promise 结束不等于 useEffect 已保存；视口计时器 cleanup 取消仍遵循旧行为，不得把取消视作成功落盘。
3. 两步暂停协议：先封住新任务根入口，允许已开始任务的子请求和写入排空，再冻结后端入口，完成 epoch/quiet 确认。不能提前冻结旧任务需要的存储或中转造成死锁。
4. 上述竞态与失败演练通过后，才能实施首次生产私人配置对照与交接。仍未进行 Keychain/后端密钥迁移、GitHub 私有认证、签名发布、launchd 安装/回滚或两台实体 Mac 验收。

本轮改动前归档及源码检查点保存在同一私有备份目录，校验值和范围见 `BACKUP-README.md`。Git 的 pre/post 恢复标签不包含未提交源码，也不替代完整用户数据备份。

## 2026-10-10 两步暂停与持久化确认基础（阶段 2 仍未整体验收）

### 本轮实现

- `src/server/activity-gate.mjs`：拆分 root drain 与 backend freeze。`beginQuiescence()` 不再拒绝旧任务的后续中转/保存；已核实库存、所有参与者同 epoch 的暂停确认、全域零活动及静默期满足后，可信协调器才能调用 `freezeQuiescence(epoch)`。冻结后拒绝新后端操作，并重新等待静默期。没有 freeze，永远不允许安装；取消、晚到忙状态、旧 epoch 或库存失效均不能保留安装许可。
- `src/canvas/lib/page-drain-barrier.ts`：独立、未激活的页面排空基础类。同步阻止新根任务、保留旧根作用域的子操作能力、等待已跟踪活动、排空所有已开始的持久化 flusher，再发放对象身份与活动 revision 绑定的确认。任何后续活动，即使计数很快回到零，也使旧确认失效。失败不自动放开根入口；受信任取消可恢复工作。取消或卸载不会取消正在落盘的写入，也不会释放远端未知任务。
- `src/canvas/lib/update-activity.ts`：增加只读单调 revision，防止零计数的 ABA 竞态。仍是辅助观测，不提供安装权限。
- `src/canvas/stores/canvas/use-canvas-store.ts`：增加 `flushCanvasPersistence()`，等待已提交画布写入，并继续等待期间提交的新版本；最新写入失败会拒绝确认。序列化失败被记录为保存错误；相同快照上次失败后允许重试，不被原引用去重规则跳过。存储删除接口也纳入等待，仅记录原来明确请求的操作，不主动执行任何删除。
- `tests/two-step-drain.test.mjs` 与 gate 回归：新根拒绝、旧根子请求、脱离父 Promise 的子写入、并行 flush 失败排空、取消/卸载、旧 epoch、零计数 ABA、同快照重试、序列化失败、新写入取代旧失败及存储删除失败均有测试。

### 明确未完成的接入

页面排空类没有生产 singleton、网络入口或自动调用；现有业务入口仍使用观察器，尚未统一通过 `runRoot`/显式子 scope 进入屏障。因此不得据此宣称生产已阻止新任务。

`flushCanvasPersistence()` 只证明已提交给 canvas store 的保存，不能证明 React 未提交状态、延迟视口、Excel shell、其它 store、插件或浏览器数据库都已保存。它尚未由真实画布的提交/视口 flush 回调接入页面屏障。缓存 iframe、旧窗口和外部 Agent 的可信完整库存也未实现。自注册、BroadcastChannel 或全部浏览器自报零，都不能代替可信库存确认。

下一步必须统一任务根与子作用域、注册真实 React 提交与视口落盘确认、建立可信页面与远端任务清单，再以完整协议演练。未完成这些步骤前，后端生产库存保持 unknown，自动安装始终禁用。此轮没有新增浏览器的暂停、冻结、安装或系统命令 API。

### 验证与保护

- 完整 `npm test`：193/193 通过（本轮新增 15 项）；TypeScript typecheck、Vite build 和后端模块语法检查通过。原有 bridge、bundle 与混合 import 警告仍需发布阶段处理。
- 当前源码秘密扫描 891 候选无未解决命中；历史 1,359 blob，仅原两条精确占位例外；暂存区为空。规则扫描不是绝对无秘密证明。
- 5 个任务入口 TSX 文件与上一轮源码检查点字节一致；没有修改布局、样式、后端界面块或生产 public。只构建隔离开发 dist，没有发布前端。
- 测试使用内存 fixture 与独立服务回归，不连接真实 AI、Agent 或 WebDAV；没有原浏览器数据写入。本轮未使用真实浏览器验证新屏障，因此不宣称端到端暂停已通过。
- 原 5174/PID 32438 保留，未重启、迁移私人配置或删除用户数据；没有 Git 提交、仓库创建、推送或 Release。

改动前另存 `pre-two-step-drain-20261010.tar.gz`，SHA-256 `5434df464e9a7d1834284ad999460532acf74974b5d1e260ef0fd91fcd09026d`；后续源码检查点及校验值见私有备份说明。两个归档均不是 Stable 包，不替代原完整备份。

## 2026-10-10 真实画布 React 提交与视口保存接入（阶段 2 仍未整体验收）

### 已实现与接入

- `lib/render-commit-checkpoint.ts`：请求一个带 ticket 的真实 React render，只有 layout-effect 提交后才能取得快照。等待快照对应的实际持久化后，核对组件 generation、提交 revision 与 ready 状态；新编辑、尚未就绪、卸载或 StrictMode 重挂载不能产生有效保存确认。最多保留 32 个未提交请求，调度失败不泄漏活动租约。
- `pages/canvas/hooks/use-update-flush.ts`：真实画布使用的 Hook，按组件生命周期注册/移除 flusher，并在 layout effect 中更新保存回调与提交快照。每次 flush 的租约涵盖 render 等待和持久化，不按固定延迟猜测 React 已完成。
- `services/canvas-update-flush.ts`：当前 JS realm 中已挂载画布的本地注册表。等待所有已开始的 flush，失败或注册表拓扑变更拒绝确认；空注册表不声称已有覆盖。它不是完整页面库存，也不授予安装权限。
- `pages/canvas/project.tsx`：快照包括 projectId、nodes、connections、chatSessions、activeChatId、backgroundMode、showImageInfo、viewport。记录实际恢复的画布 ID，拒绝把尚未恢复的新路由当成旧画布；未提交的节点事务、拖动/缩放编辑、历史暂停与视口动画期间拒绝确认。通过原 `updateProject` 和 `flushCanvasPersistence()` 保存完整快照。只有保存成功且视口仍对应这份快照，才取消原待执行视口计时器并释放其租约；失败不取消，新视口的计时器不受影响。
- `tests/canvas-update-flush.test.mjs`：9 项专项回归，涵盖完整快照、实际 render/写入等待、旧提交、未就绪、新编辑、保存失败、卸载/重挂载、容量、注册变更，以及提取真实画布保存回调验证计时器顺序与失败保留。
- `tests/fixtures/canvas-commit-harness.tsx`、`scripts/verify-frontend-activity.mjs --commit-flush`：内存构建真实 React/StrictMode 与实际 Hook 的隔离浏览器测试页。测试写入仅为内存 Promise，不加载用户配置/数据库；不进入 production public 或便携包白名单。

### 验证结果

- 完整回归 202/202 通过；TypeScript typecheck、Vite build、测试服务语法检查通过。原 bridge、混合 import 与 bundle 大小提示仍保留。
- 使用 Playwright 技能，在独立浏览器和 `127.0.0.1:65454` 测试页验证：StrictMode 仅注册一份；同批次编辑后立即 flush 保存最新节点与视口；持久化完成前 storage 仍忙；新编辑使正在保存的确认失败；未就绪不发起写入；卸载后注册移除，但未完成写入继续计数，结束后仍拒绝原确认。最终活动归零。
- 该验证使用实际 Hook 与真实 React，但模拟持久化；不是整个生产画布、真实用户 IndexedDB、所有状态 setter 或跨 iframe 安装流程的端到端验收。测试网络仅允许测试 Origin，未连接真实 AI、Agent、WebDAV 或代理。测试浏览器和服务均已关闭。
- 画布 project.tsx 的所有 JSX 根片段与改动前归档逐字一致，18 个布局/样式文件与既有保护归档一致；没有改动现有按钮/样式或发布 production public。
- 当前源码扫描 896 候选无未解决命中；历史 1,359 blob，仅已有两条精确占位复核例外；暂存区为空。未做 Git 提交、GitHub 上传、签名、发布或安装。
- 原 5174/PID 32438 未重启，未对原浏览器、私人配置或真实代理写入。最初完整备份保留，新增改动前与源码归档见私有备份说明。

### 仍需继续的边界

已挂载画布有了显式保存入口，但尚无可信协调器自动调用，也没有向 window、postMessage 或 HTTP 暴露 flush/暂停/安装入口。生产新任务仍未统一进入 root/scope 屏障，自动安装继续禁止。

真实 marker commit 能确认这一次已提交状态，不能无条件证明所有未提交 React lane、延后执行的事件/更新、其它工作台 store、Excel shell、插件、缓存 iframe、旧窗口和外部 Agent 都已排空。完整接入需要：先统一阻止新任务/编辑根入口，再将本地 flusher 放入带 revision 的页面屏障，核实所有页面及远端任务库存，处理超时、失联、晚到提交与 BFCache/HMR，最后冻结后端。不能把本地注册数量或单次 flush 成功当作可安装证据。

## 2026-10-10 生成任务准入与显式批次作用域（阶段 2 仍未整体验收）

### 本轮实现

- `lib/page-drain-barrier.ts`：增加 `runTask`，区分新根与显式传入的旧根子作用域。作用域冻结并以本实例 WeakSet 校验存活身份；伪造、跨实例或已结束作用域被拒绝，不退化成新根。新增 `invalidateCheckpoint()`，使拓扑变化使未决 drain 和旧确认失效，但不取消写入、不自动恢复根入口。
- `services/task-admission.ts`：本 JS realm 的任务准入实例，接入实际活动注册表及画布 flusher。没有 HTTP、window、postMessage 控制或自动 drain。画布注册/移除通知使确认失效；没有已挂载画布不等于已证明全部窗口/缓存画布为空。
- 画布 7 个生成根（生成、重试、批量、补齐并生成、蒙版、放大、角度）、图片工作台生成/重试及视频工作台生成，共 10 个实际入口接入 `runTaskActivity`。已有三 worker 批次显式向每个后续卡片传递原 scope，补齐并生成向批次传递 scope，因此暂停新根不会截断已经开始的批次。原业务体、JSX 和既有布局不变。
- 视频恢复轮询继续作为旧远端任务观察，不因暂停新生成而停止结果查询与保存。当前内部 API/保存继续使用原活动租约，不提前冻结它们。
- `tests/task-admission.test.mjs`：提取真实入口并执行，覆盖 10 个根在业务体之前拒绝、三 worker 全批次排空、组合入口 scope 传播、身份/过期校验及拓扑失效。fixture 使用实际 barrier，不用 no-op 替代。

### 已完成验证

- 完整回归 207/207 通过；TypeScript typecheck、Vite build 通过。既有非 module bridge、混合 import 及大 bundle 警告仍在，不代表 Stable 发布构建已验收。
- 使用 Playwright 技能，在独立浏览器与 `127.0.0.1:51535` 验证实际准入服务、React/StrictMode、真实 Hook 和内存写入：新根拒绝；旧批次子操作完成；保存包含最新 `batch-finished` 节点和视口；保存未完成保持 storage 忙；保存完成才取得确认；晚到编辑使确认失效；显式 resume 后新根可运行，最终活动归零。
- 该演练只使用 QA fixture 和内存持久化，不是完整生产画布/真实 IndexedDB/跨窗口安装验收。网络仅允许隔离 Origin，未连接真实 AI、Agent、WebDAV 或代理。该测试浏览器与服务已关闭。
- 3 个任务页全部 JSX 根片段与改动前归档逐字一致；18 个布局/样式文件及后端 19 个模板字符串与既有保护归档一致。未改生产 public，未发布前端。
- 当前源码秘密扫描 898 个候选路径无未解决命中；历史 1,359 blob 仅原两条精确占位例外；暂存区为空。此结论仅在扫描规则覆盖范围内。
- 原 `127.0.0.1:5174`/PID 32438 未重启；没有原浏览器数据、私人配置或真实代理写入。原完整备份保留，本轮 pre/source 归档及校验值见私有备份说明。未提交、创建 GitHub 仓库、上传、发布或安装。

### 尚未启用与下一步

本轮接入的入口具备本地暂停能力，但没有生产协调器发起暂停，自动安装仍禁用。不能把 10 个入口、单页零计数、一次 flush 或本地注册数量当作全业务覆盖证据。

仍需统一 Agent/插件任务、编辑/导入/异步恢复等根与显式子 scope 的完整传播；已运行 Agent 稍后触发生成，不能误判成新用户任务而阻断其子操作。生产启用前还需统一处理准入拒绝的 UI/错误反馈，避免现有 void 调用产生未处理拒绝。可信页面/iframe/旧窗口及远端任务库存、跨 realm、HMR/BFCache、延后 React 更新和其它 store 的排空证明尚未完成。

只有以上缺口及失败演练通过后，才允许首次私人配置交接和原服务安全切换。Keychain/后端密钥迁移、GitHub 私有认证、可信签名发布、launchd 安装/回滚及两台实体 Mac 验收仍未实施；阶段 2 未整体验收。

## 2026-10-10 Agent 画布操作与插件显式任务续作（阶段 2 仍未整体验收）

### 已实现代码

- `pages/canvas/hooks/use-agent-bridge.ts`：画布 applyOps 进入本地 agent 根/显式子 scope。保留原微任务后启动生成的顺序，但不再 fire-and-forget；所有已启动生成分支结束后才返回，分支拒绝时仍排空其它分支。缺少生成能力明确失败，不返回假成功。返回使用最新 refs，避免等待生成后将旧快照发送到 Agent、覆盖新增结果。
- `stores/use-agent-store.ts`、`pages/canvas/project.tsx`：更新内部 applyOps Promise 契约及 generateNodeRef 的显式 scope 类型。非生成指令仍在首次 await 前同步应用，未改节点业务数据或撤销逻辑。Promise 完成仍不代表 React/IndexedDB 已保存，最终安装必须经过已有 commit/flush 屏障。
- `components/agent/local-agent-panel.tsx`：两个画布写工具及生成图片导入等待 applyOps；等待 postState，并检查其成功布尔值。状态交付失败时回报工具错误，不静默回报成功、不回滚或删除已经生成的本地结果。生成本身的业务成功/失败仍按原画布状态报告，不能把工具指令返回等同于所有图片成功。
- `lib/canvas/plugin-task-host.ts`：包裹实际插件 host。独立图片/视频/文本生成及 applyOps 为根任务；同步节点/元数据更新进行本地准入检查，保持同步契约。新增显式 runTask，只有它提供的 scoped host/context 可以在暂停后继续旧任务子操作。作用域由 host 闭包携带，不接受插件 options、全局可变上下文或 postMessage 传入的 scope；任务结束后持有的旧 scoped host 不能再写入/生成。
- `types/canvas-plugin.ts`、`lib/canvas/plugin-node-context.ts`、`pages/canvas/hooks/use-plugin-host.tsx`：新增节点/host runTask，向节点传递 scoped context。applyOps 返回 Promise，旧插件忽略返回值时仍保持原同步应用时序，并挂接拒绝处理和通用错误提示；await 调用者仍得到原始拒绝，不把错误转换成成功。没有修改 JSX、样式、布局或 production public。
- `lib/page-drain-barrier.ts`、`services/task-admission.ts`：增加同步准入校验，验证同一实例存活作用域。它不授予安装权限，也不声称同步 setter 等于已提交保存。

### 插件接入约定

新多步骤插件需 await 整体任务及每个异步操作，并使用回调提供的 scoped context，而不是原 ctx。例如：

```ts
await ctx.runTask(async (scoped) => {
    const result = await scoped.ai.generateText("提示词");
    scoped.updateMetadata({ content: result.text });
});
```

旧插件独立调用 AI 后，再用原 ctx 写回，或者自行 fetch、设置延迟定时器、发出 detached Promise，不自动获得子任务资格。未逐个迁移并验证这些插件前，不允许激活生产暂停/安装。scoped context 的 storage、emit/on 和任意插件代码仍不是完整受控执行环境；插件存储目前只有原活动观测，没有宣称全功能 scope 覆盖。

### 验证与保护

- 新增 `tests/agent-plugin-admission.test.mjs` 10 项专项测试，执行真实 Agent/工具/插件 hook 回调和实际 host wrapper：准入前不变更业务、微任务子生成保留 scope、保存等待、兄弟失败排空、最新结果快照、Agent 状态交付失败、不泄漏作用域、结束后拒绝旧 scope、节点上下文与存储 namespace、实际 hook 接入及同步更新兼容。
- 完整回归 217/217 通过；TypeScript typecheck、Vite build 通过。既有 bridge、混合 import、大 bundle 和部分测试的 module-type 提示保留，不据此宣称 Stable 构建可发布。
- 当前源码秘密扫描 900 候选无未解决命中；历史 1,359 blob 仅原两条精确占位复核例外；暂存区为空。扫描规则不能证明所有秘密绝不存在。
- 画布页、Agent 面板及插件 Hook 的全部 JSX 根片段与本轮 pre 归档逐字一致；18 个布局/样式文件及后端 19 个模板字符串与保护归档一致。原 5174/PID 32438 未重启，没有私人配置、原浏览器数据或真实代理写入。
- 本轮是源码回调/实际辅助类的隔离单元回归，没有新增真实浏览器、真实 Agent 服务、付费 AI、真实 WebDAV 或客户插件端到端演练。不能将这些测试当成外部 Agent 协议验收。

### 剩余阻断

本轮只覆盖已被本地准入的画布指令及显式插件任务，不等于整个远端 Agent turn 已有作用域。当前外部 tool_call 协议缺少可靠 turn/thread/创建请求归属，sendPrompt 的 HTTP 响应也不提供 turnId；不能凭当前选中会话、waiting 或 token 猜测传递旧 scope。断线、恢复、晚到工具、审批、远端任务清单及工作台 command 的排队/跨路由 scope 交接仍需完善。等待长生成后才响应工具的行为，尚需验证外部 Agent 的超时和取消协议。

Agent 撤销、普通编辑/导入、异步恢复、旧插件、其它 store、跨 iframe/旧窗口及 HMR/BFCache 的完整准入与错误 UI 仍未完成。完整库存与可信协调器尚未实现；没有生产暂停/冻结/安装网络入口。自动安装继续禁用。Keychain、GitHub 私有授权、签名、launchd 与两台实体 Mac 验收仍待后续阶段，不做 GitHub 创建/提交/推送/发布。

改动前 10 文件归档及本轮源码检查点保存在原私有备份目录，范围、权限和校验值见 BACKUP-README；不替代最初完整项目/代理/浏览器备份，也不是 Release。

## 2026-10-10 工作台命令排队与同 realm 路由交接（阶段 2 仍未整体验收）

### 本轮实现

- `lib/deferred-task-handoff.ts`、`services/workbench-task-handoff.ts`：命令发布前取得独立的 workbench 根租约，排队期间持续计数。只按原对象身份单次领取，复制 command/相同 taskId 不构成授权；领取时以仍存活的旧 scope 执行，暂停新根后仍可继续。操作完整 Promise 结束后才释放，不能取消已开始操作。容量最多 16；没有超时、关页或历史截断自动清除。仅确知没有生成开始的忙拒绝/配置命令可显式释放。
- `stores/use-workbench-agent-store.ts`：命令冻结、发布前准入、拒绝覆盖未消费的同类命令。清空 UI slot 按 expectedNonce 匹配，不清除 newer command，也不自行释放任务租约；queued/running/历史状态不被当作完整的持久化完成证明。任务命令及 scope 只在内存，不写入浏览器存储、不迁移历史。
- `lib/agent/agent-site-tools.ts`：在改配置之前检查准入、容量及同类待执行命令；先发布 admitted command，再 navigate。暂停时不会先修改模型/尺寸再拒绝生成。远端 Agent turn 尚无可信 scope，因此不猜测它是旧任务而绕过此检查。
- 图片/视频工作台：接收命令后保留 slot 到实际执行开始，避免 React 两个 effect 之间被新命令覆盖。auto effect 显式传入原 command，取出 ref 后不会重复执行；普通手动 generate 不偷走尚待自动执行命令的 taskId。忙拒绝与仅配置命令在没有请求发出时明确结束租约。auto 准入错误有通用提示并更新相应任务失败，不产生未处理拒绝。
- 视频 generate 从 fire-and-forget 轮询改为等待 pollGenerationLog，整个创建、初次历史保存、轮询间隔、原件保存与最终历史保存都在根操作内。Agent 的 succeeded 状态放到最终 saveLog 成功之后。轮询失败或超时仍不代表上游终止，原未决远端租约继续保护；恢复中的旧视频仍允许查询/保存。
- `tests/helpers/frontend-activity.mjs` 使用实际 deferred handoff 实现，不用 no-op 替代；新增 `tests/workbench-handoff.test.mjs`，QA harness 增加仅隔离测试使用的真实 store/服务交接入口。

### 验证结果

- 新增 10 项专项回归，覆盖排队阻断、暂停后领取、保存等待、重复/伪造领取、容量、显式未开始拒绝、store 覆盖/旧 nonce、Agent 改配置前准入、实际页面两个 effect、普通配置与忙拒绝、图片历史保存、视频全轮询等待及成功状态顺序。完整 `npm test` 227/227 通过；TypeScript typecheck、Vite build 通过。
- 当前源码秘密扫描 903 候选无未解决命中；历史 1,359 blob 仅原两条精确旧占位复核例外；暂存区为空。既有 bridge、混合 import、大 bundle 及部分测试 module-type 提示仍保留，不作为 Stable 发布验收。
- 使用 Playwright 技能，在独立浏览器与 `127.0.0.1:57215` 验证实际 command store、handoff 服务及 React/StrictMode/画布 Hook：排队即保持租约；未消费不确认 idle；新命令拒绝；旧命令暂停后执行；最新 command-finished 节点/视口提交；内存写入未完成仍 storage 忙；保存结束才确认，最终活动归零。
- 浏览器验证的执行结果/持久化是 QA 内存 fixture，不是真实图片/视频页面、真实 IndexedDB、外部 Agent、跨 iframe 或完整更新器端到端验收。网络仅允许测试 Origin，没有真实生成、代理或 WebDAV 请求。测试浏览器和服务已关闭。
- 两个工作台页的全部 JSX 根片段与改动前归档逐字一致；18 个布局/样式文件及后端 19 个模板与保护归档一致。production public 未改/发布；原 5174/PID 32438 未重启，没有原浏览器数据、私人配置或真实代理写入。私有 pre/source 归档和权限/校验值见 BACKUP-README，原完整备份持续保留。

### 尚未证明的边界

本轮交接限定同一 JS realm 的 SPA 路由，不跨独立标签页、iframe、刷新、HMR、BFCache 或进程重启。消费前卸载不主动清空 command；整个 realm 销毁后不能用这张内存表证明远端已终止，必须由可信库存与失联保护阻断安装。没有把超时、历史截断或 UI 失败当作上游终态。

配置仍按原工作台机制读取，尚未为每条命令固定所有配置/素材快照；同帧手动生成竞态、所有按钮的暂停 UI、工作台失败写入恢复/flush、其它 store 及编辑/导入仍需完善。没有把根 Promise 结束当作所有 React/store 已保存。

外部 Agent 的完整 turn/tool 归属及服务器协议仍未接入；当前项目没有该远端服务源码，不扩展修改用户其它项目。旧 Agent turn 在暂停后新到的工具不能猜测成旧 scope，仍是生产启用阻断。完整可信窗口/iframe/远端库存与协调器尚未实现；没有开启暂停/冻结/安装网络入口，自动安装继续禁用。阶段 2 未整体验收；GitHub 私有授权、Keychain、签名发布、launchd 和实体两台 Mac 仍待后续阶段。未创建仓库、提交、推送、发布或安装。

## 2026-10-10 历史/媒体/插件与配置失败保存确认（阶段 2 仍未整体验收）

### 本轮实现

- `lib/persistence-checkpoint.ts`：记录尚未完成的写入和失败证据，不保存业务值或原始异常。显式 flush 等待所有已开始写入，期间新写入继续核验；失败后不会自动重试、删除数据或清除错误。同一操作/键在没有重叠写入时的后续成功，才允许解除该失败。并发写入无法证明提交顺序，保守保留失败；其它键、其它操作的成功不解除失败。
- 每检查点最多保留 4,096 个未完成/失败键，单 realm 最多登记 256 个检查点；超限保留阻断，不淘汰失败、不影响原业务写入。全组 flush 带变更 revision 再核验，避免先排空的存储在等待慢兄弟时又写入、却遗漏其失败。新登记的存储使拓扑确认失效。
- `lib/activity-storage.ts`：原 localForage 显式适配器接入检查点，覆盖已使用它的图片/视频历史、媒体、提示词缓存和插件存储。保持接收者、参数、原回调时序和业务错误传播，不全局改写 IndexedDB。`dropInstance` 的 options 可能指向不同数据库，失败后不根据另一次 drop 成功推断恢复；没有实际执行清库或删库操作。
- `lib/checkpoint-json-storage.ts`、`stores/use-config-store.ts`：配置使用等价 JSON envelope 的显式 localStorage 适配器，包含序列化、配额和同步写入异常的确认。原 CONFIG_STORE_KEY、Origin、partialize、默认配置、merge/恢复逻辑不变；存储不可用仍遵循原 Zustand 行为，但保存确认拒绝。没有密钥迁移、上传、默认覆盖或读取真实用户配置。
- `services/task-admission.ts`：本地页面屏障登记全组 storage flusher 及拓扑失效订阅。已结束的失败写入即使活动计数归零，也不能发出保存成功确认。没有生产协调器发起 drain，没有新增浏览器控制/安装接口。

### 验证结果与保护

- 新增 11 项隔离专项回归，覆盖排队/晚到写入、两个并发完成顺序、失败保持及明确重试、兄弟排空、跨存储晚到失败、容量/拓扑、异常订阅、真实适配器回调/drop、配置 JSON 格式及循环序列化/配额失败、存储不可用、实际 PageDrainBarrier 的拒绝/恢复流程。完整回归 238/238 通过，TypeScript typecheck 和 Vite build 通过。
- 当前源码秘密扫描 907 个候选无未解决命中；历史 1,359 blob 仅原两条精确测试占位例外；暂存区为空。规则扫描不能证明所有秘密不存在。原 bridge、混合 import、大 bundle 及部分测试 module-type 警告仍需发布阶段处理。
- 18 个布局/样式文件与保护归档字节一致；配置文件扣除导入和 storage 适配器声明后与本轮 pre 归档一致。没有修改 JSX、后端界面、production public 或访问 Origin；只构建 src/canvas/dist。原 5174/PID 32438 保留，未重启。
- 本轮只有内存存储、实际 helper/适配器与源码回归测试，没有新的真实浏览器 IndexedDB、实际配置、真实生成、Agent、WebDAV 或跨设备演练。保留最初完整备份；pre/source 私有源码归档、权限与校验见 BACKUP-README。Git pre/post 标签不替代脏工作目录备份。

### 剩余边界与下一步

本检查点只核验已经提交到这些适配器的操作，不能证明未提交 React 状态、日志预处理、工作台其它状态或任意插件代码已保存。`localforage-storage.ts` 的逐键队列、localStorage 恢复副本/tombstone 和吞掉的主存储失败，仍需独立明确成功判定；不能据此声称所有 Zustand store 已有失败确认。其它直接 localStorage 写入、Excel shell、WebDAV 同步恢复及普通编辑/导入的准入也未全部覆盖。业务现有错误提示/恢复入口还需统一，检查点不自动重放副作用。

检查点属于当前 JS realm 的内存证据；刷新、HMR、关页、iframe/其它窗口和进程重启不能据此抹掉未知状态。完整可信页面/远端库存、外部 Agent 协议及协调器仍未实现。自动安装继续禁用，阶段 2 未整体验收；不提前进行真实配置交接、原服务切换、Keychain、私有 GitHub 联调、签名、launchd 或实体双 Mac 验收。未创建仓库、提交、推送、发布或安装。

## 2026-10-10 localForage 队列与恢复副本确认（阶段 2 仍未整体验收）

### 本轮实现

- `lib/localforage-storage.ts`：登记暂存、主存储提交/原清理、恢复证据三个有界检查点。保留同步 localStorage 恢复副本、原存储键、infinite-canvas/app_state、逐键 FIFO、tombstone 与原读写返回/异常行为。主存储失败即使被原逻辑捕获并正常返回，也保留失败证据，不当作保存成功。
- 主提交检查点在逐键队列内启动；同一键的后续成功替换或删除有明确串行顺序，可以取代此前失败。同一键的旧保存不能清除较新的删除标记，旧删除也不能清除较新的值标记；与其它键无关的成功不能抹掉失败。暂存/清理异常继续阻断确认，业务数据不被静默删除。
- `flushLocalForagePersistence()` 等待尚未执行和正在执行的 FIFO、期间新写入与检查点 revision，排空所有已开始的键后才确认；不自动重试主写入、回放恢复副本或删库。暂存成功不等同于主提交成功，Promise 返回也不等同于可安装。
- 已读取的恢复副本、删除标记、仅剩 marker、恢复存储不可读或主读取失败，记录为尚未确认。读仍按原规则返回，观察不修改数据库。只有原显式写入路径成功、且同键恢复值/标记已按原逻辑处理完，才能解除相应恢复阻断。不扫描或处理未访问的所有 localStorage 键，不声称完整 Origin 库存。
- `services/task-admission.ts` 增加本地 FIFO flusher。仍需同时使用全组检查点和本地 FIFO flusher，不能单独以全组检查点的某一次结果证明尚未启动的队列为空。没有新增生产暂停/安装/命令入口，也没有协调器主动发起 drain。

### 验证与保护

- 新增 16 项内存专项回归，并强化原 3 项恢复测试：排队/晚到写入、FIFO 新值取代旧失败、跨键失败隔离、同步配额/部分暂存、两存储均失败、删除暂存失败、值/marker 清理失败、恢复 tombstone/仅 marker/无 marker 副本、读取不可用、删除清理重试、实际屏障等待/拒绝/明确恢复、保存与删除两种交错及失败兄弟排空。没有使用 no-op 检查点，执行真实适配器、检查点及 PageDrainBarrier。
- 完整回归 254/254、TypeScript typecheck、Vite build 通过；源码扫描 907 候选无未解决命中，历史 1,359 blob 仅原两条精确占位例外，暂存区为空。规则扫描不能证明所有秘密不存在；既有 bridge、混合 import、大 bundle 和测试 module-type 警告保留。
- 18 个布局/样式文件与保护归档字节一致，任务准入文件仅增加该 flusher 的导入和登记。没有修改 JSX、配置默认值、后端界面、production public 或 Origin，只构建 src/canvas/dist。原 127.0.0.1:5174/PID 32438 保留，未重启。
- 本轮只有隔离内存/源码测试，没有真实用户 IndexedDB/localStorage 写入、实际 AI/Agent/WebDAV/代理请求或新的浏览器端到端演练。改动前四文件私有归档 `pre-localforage-confirmation-20261010.tar.gz` SHA-256：`33a0e66c2541f33a107bcbd11a76d6c60e753522c5dd1e970714a2196e9041ca`；本轮源码检查点校验见私有 BACKUP-README。归档均 0600，不替代最初完整备份，Git 标签不包含未提交源码。

### 下一步与未证明边界

本次确认仅涵盖实际提交给此适配器的字符串及已访问恢复键。大画布超过 localStorage 配额，即使主存储成功，暂存失败仍保守阻断更新；需要另行设计并验证可证明主副本完整及无残留冲突的恢复策略，不能为了打开安装而直接清除证据。序列化发生在适配器之前的 asset/plugin store、其它直接 localStorage 写入、未提交 React 状态、日志预处理和 Excel shell 仍需覆盖；读取到的旧恢复记录没有自动修复入口。

逐键 FIFO 只在同 JS realm，不提供跨标签/iframe 的写入事务互斥；并发外部窗口、刷新/HMR/BFCache、未知旧页面及未访问存储不能据此判定空闲。外部 Agent 归属、完整可信页面/远端任务库存和协调器仍是生产启用阻断。阶段 2 尚未整体验收，自动安装继续禁用；未迁移真实配置、切换原服务、创建仓库、提交、推送、发布或安装，Keychain/私有授权/签名/launchd/双 Mac 仍待后续阶段。

## 2026-10-10 素材/插件序列化与其他 store 保存确认（阶段 2 仍未整体验收）

### 本轮实现

- `lib/checkpoint-async-json-storage.ts`：针对异步 StateStorage 的显式 JSON 适配器。保留原 JSON envelope、Zustand reader 的 null/解析/异步异常规则，以及同步序列化失败在后端写入之前抛出的时序。记录循环引用、toJSON 抛错、存储不可用及完整异步写入/删除的失败；不记录值或原始异常，不重试副作用。后端写入/删除成功后才结束活动，适配器前序列化失败也阻断全组确认。
- `stores/use-asset-store.ts`：保存/删除使用上述适配器，保留原自定义恢复、媒体解析、partialize、素材默认值与清理机制。`stores/canvas/use-plugin-store.ts` 同样接入；保持插件 key、缓存源码、启用/删除操作和恢复机制，不改变任意插件代码的执行权限。
- `stores/use-theme-store.ts`、`use-prompt-source-store.ts` 使用已有同步 JSON 检查点，沿用原 localStorage key、partialize、merge 与默认值。主题通知父页面、切换动画以及每画布 Excel 提示词更新事件不变；没有重新渲染或修改 UI。
- `lib/checkpoint-local-storage.ts`：同步直接写入检查点，不全局 patch Storage。侧栏排序/开关及 Agent store 的连接 URL/Token 保存接入；保留写入参数、原异常和写入前后 set 的顺序。Token 保存失败不执行后续启用连接；两项写入并非原子事务，没有声称解决全部凭据事务问题。值仍按旧路径存在浏览器中，尚未迁移 Keychain。

### 验证与保护

- 新增 12 项隔离测试，使用实际 Zustand vanilla store/persist/createJSONStorage 和真实检查点/活动/页面屏障，验证异步写入等待、JSON 格式/receiver、循环引用/toJSON、删除/写入失败、存储不可用、六个实际 store 的保存/恢复/partialize/merge、配额异常、侧栏原定时器、Agent URL 成功但 Token 失败时不启用，以及同步失败使旧 receipt 失效。底层为内存，不读取用户配置、不连接真实 API。
- 完整回归 266/266、TypeScript typecheck、Vite build 通过。源码秘密扫描 910 候选无未解决命中，历史 1,359 blob 仅原两条精确占位例外，暂存区为空；规则扫描不是绝对无秘密证明。原 bridge、混合 import、大 bundle 和测试 module-type 警告保留。
- 六个 store 去除本轮适配器导入/接入后与 pre 归档逐字一致；18 个布局/样式文件与保护归档逐字一致。没有 JSX、样式、后端界面、production public、存储键或 Origin 改动，仅构建 src/canvas/dist。原 5174/PID 32438 保留，没有服务重启、真实用户存储写入、真实生成/Agent/WebDAV/代理请求。
- 本轮是内存存储与真实持久化中间件/源码的隔离回归，没有新的真实浏览器/IndexedDB、完整应用更新或实体双 Mac 验证。pre 七文件归档 SHA-256 `409c9660eea5e1d64b394d443b2394f892ba857ce704dd170f902f8227be55aa`，本轮 source 校验见私有 BACKUP-README。0600 源码检查点不替代最初完整项目/代理/浏览器备份，Git 标签不包含脏源码。

### 仍需推进的缺口

接入的是这些 store 的写入路径，不是普通编辑/导入的完整准入，暂停后新编辑仍可能发生并使确认失效。组件内其它直接 localStorage 写入（侧栏/Agent 宽度、快速工具、Agent 面板的模型/权限/凭据、画布名称/汇总、语言）、产品回收标记、Excel bridge/shell，以及日志预处理仍未全部接入；同一 key 在未接入路径写入成功不能自行解除旧失败。

素材恢复中的异步分支与延后媒体清理仍需完整生命周期跟踪；损坏 JSON/恢复失败的业务处理尚未重构，不把读失败/默认状态当作数据安全证明。异步 JSON 适配器的并发失败按通用检查点保守保持，未实现跨 realm 事务。大画布恢复配额、已访问旧恢复记录的安全处理、完整可信窗口/远端库存及外部 Agent 归属仍是阶段 2 阻断。

自动安装继续禁用，没有生产暂停/安装协调器或浏览器系统命令入口。未迁移实际凭据、切换原服务、创建仓库、提交、推送、发布或安装；Keychain、GitHub 私有认证、签名、launchd 与实体双 Mac 验收待后续阶段，不能宣称自动更新系统已完成。

## 2026-10-10 延后清理、素材恢复与组件保存续作（阶段 2 仍未整体验收）

### 本轮实现

- `lib/scheduled-persistence.ts`：定时器调度前取得 storage 活动与持久化检查点，等待实际任务完整 Promise。未执行的定时器仍忙，不用固定时间、卸载或取消 drain 自动释放。回调重复执行只运行一次；调度在启动前抛错时不执行晚到回调，启动后抛错仍等待已开始操作再报告错误。失败不自动重试，明确的后续非重叠同任务成功才允许恢复。
- `stores/use-asset-store.ts`：延后清理从排队即观测；保持读取最新素材/项目、先图片后媒体的原顺序及原清理算法，通用检查点保留错误，避免 detached 未处理拒绝和原异常数据日志。自定义恢复也接入完整活动/失败检查点，等待预览查询及所有已开始的恢复分支后再抛错。
- 修复素材恢复失败仍标记 hydrated、触发默认空列表保存的风险：仅 state 有值且 error 严格为 undefined 时才提交成功标记，包括 falsey rejection 理由也不能冒充成功。未清空坏记录、重置默认配置或自动重放恢复；明确重新恢复成功后才按原规则保存。此安全修复不代表所有损坏数据/后续用户编辑均已有恢复保护。
- `services/image-storage.ts`、`file-storage.ts`：清理/删除与历史索引并行组改为 settleActivityGroup，失败不提前释放尚未结束的兄弟操作。清理选键、回收 URL 与删除顺序不变，没有扩大删除目标；本轮测试只操作内存假键，未删除真实图片/视频。
- `lib/checkpoint-local-storage.ts` 增加同步 JSON 写入和删除方法；画布/Agent 侧栏宽度、快速工具设置/原恢复删除、画布名称/胶囊汇总、语言保存接入。JSON 序列化在检查点内；原存储键、异常、事件、重命名和动画时序保持，没有全局 patch Storage 或系统命令入口。

### 验证与保护

- 新增 14 项回归：调度前/后、重复/晚到回调、排空取消不释放、明确失败重试、真实延后清理顺序/最新状态/失败不启动后续删除、恢复兄弟与预览等待、实际 Zustand 坏数据恢复不写默认空值及 falsey 错误、媒体删除/历史索引兄弟排空、直接 JSON/删除失败、两个真实 resize 和重命名回调。
- 真实 Zustand 的异步素材恢复测试对 vm 与 Node 的 Promise realm 作显式桥接，仅修正 instanceof Promise 的测试环境差异，不替代真实持久化中间件或失败逻辑；底层仍为内存，不是浏览器 IndexedDB/完整应用端到端验收。
- 完整回归 280/280、TypeScript typecheck、Vite build 通过。源码秘密扫描 912 候选无未解决命中；历史 1,359 blob 仅原两条精确占位例外，暂存区为空。规则扫描不能证明所有秘密不存在；原 bridge、混合 import、大 bundle 与测试 module-type 警告保留。
- 4 个 TSX 文件全部 303 个 JSX 片段与本轮 pre 归档逐字一致，18 个布局/样式文件与保护归档一致；两个媒体 service 扣除 settleActivityGroup 导入/替换后与 pre 一致，原算法未改。没有 production public、后端 UI 或 Origin 改动，仅构建 src/canvas/dist。原 127.0.0.1:5174/PID 32438 未重启。
- pre 十文件归档 SHA-256 `49cb6decff8f980890b9862336dce259692fbe51a8894f9651ccb1cc18bc1a3d`，本轮 source 归档范围/校验见私有 BACKUP-README，均 0600，不替代最初完整项目/代理/浏览器备份。没有新增真实浏览器、用户存储、AI/Agent/WebDAV/代理或实体 Mac 验证，未实际删除用户文件。

### 后续缺口

Agent 面板内其它模型/权限/凭据写入、产品回收标记、Excel bridge/shell、工作台日志预处理、插件自定义请求与定时器仍未全部接入。缩略图队列已有活动观测，但部分解码/查询错误被旧逻辑捕获，完整失败/恢复证据仍需完善；不以等待一次预览查询证明所有缓存已完整。

本次不把保存/恢复/清理的观察当成编辑/导入准入；暂停期间普通编辑仍可能发生并使确认失效。各检查点仍是同 JS realm 的内存记录，不能证明所有窗口/缓存 iframe、HMR/BFCache、未访问数据与外部 Agent 的完整库存。主副本配额恢复、清理业务数据保留审查、完整可信协调器与实际失败反馈/恢复 UI 仍待继续。

阶段 2 尚未整体验收，自动安装继续禁用；未重启原服务、迁移真实配置、创建仓库、提交、推送、发布或安装。Keychain、GitHub 私有认证、签名、launchd 与双 Mac 验收仍待后续阶段。

## 2026-10-10 Agent 面板与产品回收标记保存确认（阶段 2 仍未整体验收）

### 本轮实现

- `components/agent/local-agent-panel.tsx`：八处同步写入接入已有 checkpointLocalStorageWrite，涵盖连接 URL/Token、异步模型列表校正、模型选择、推理档位和权限模式。保持原 key、值、写入顺序及同步异常；存储失败时不继续原来的后续状态提交。异步模型列表即使由旧 catch 处理业务错误，检查点仍保留失败，不误认已经保存。
- `services/product-recycle-bridge.ts`：删除标记写入和恢复标记移除接入已有检查点。保持先归档再标记、再删除画布的原顺序；标记失败不删除画布，恢复标记失败不替换当前画布，归档持续保留。没有新增永久删除、媒体清理、自动重试或事务回滚，后续不同存储之间的部分成功仍需完整事务设计。
- 没有全局 patch Storage、复制用户凭据或改变连接协议。API/Agent 凭据仍按原路径存在浏览器；现有 EventSource 查询参数携带 Token 的风险没有被本轮检查点消除，需在外部 Agent 协议可验证后改用安全认证，不能把保存确认称为 Keychain 安全迁移完成。

### 验证结果与保护

- 新增 `tests/agent-marker-storage.test.mjs` 八项隔离回归，执行实际面板回调、连接前置语句、异步模型列表 effect 与完整 recycle/restore 消息处理器。验证成功顺序、第二项写失败、权限确认、catch 不清失败、显式同操作成功恢复、归档保留，以及非预期类型/Origin/source 拒绝。底层为内存，没有用户配置、真实 Agent 或文件删除。
- 旧产品回收夹具剥离 imports，初次全量测试因未加载新增 helper 失败；已补上真实检查点/活动实现，不用 no-op 替代，并增加成功恢复后的 flush 核验。最终完整回归 288/288 通过；TypeScript typecheck、Vite build 通过，既有 bridge、混合 import、大 bundle 与 module-type 警告保留。
- 当前源码秘密扫描 913 候选无未解决命中，历史 1,359 blob 仅两条原精确占位例外；暂存区为空。扫描不证明所有秘密不存在，也没有改写历史或轮换凭据。
- 两个生产源码去除本轮 helper import、将十处 helper 调用还原为原 setItem/removeItem 后，与 pre 归档逐字一致。两个内联 JSX 回调仅替换保存调用，所有布局、属性、样式和按钮顺序不变；18 个受保护布局/样式文件与保护归档逐字一致。原 127.0.0.1:5174/PID 32438 保留，没有后端 UI、production public 或 Origin 变更；仅构建 src/canvas/dist，未发布。
- pre 四文件归档 SHA-256 `a99c75cfe01e79f894857346c937bcfb9dc502f3efbcaa571157732e51a00c0a`；原产品回收夹具单独 pre 归档 SHA-256 `e1cf9df8c22eb0218bfe05ec6d70dc98b2684e4380df1c4a785ff4d67518baf7`。源码检查点范围/校验见私有 BACKUP-README，均 0600。原完整项目/代理/浏览器备份持续保留，Git 标签不包含脏源码。

### 后续重点与安全边界

当前画布 TS/TSX 的这些直接 localStorage 写入已接入；Excel bridge/shell、其他预处理及插件任意代码仍不能据此视为覆盖。存储检查点不是编辑/导入准入，不证明跨 realm 写入事务、完整窗口/远端库存、关页后任务终态或自动安装资格。

只读审查发现媒体自动清理的高优先级风险：素材 removeAsset 会调度 cleanupUnusedMedia，但传入引用仅含当前素材/项目/extra；file-storage 没有像图片清理一样读取生成历史。视频历史保存保留 storageKey、清空 url，因此仅存在于历史的原视频可能被当作未使用并删除，后续下载无法从空 URL 恢复。产品回收归档也需要纳入媒体保留证明。本轮未修改或执行该清理算法、未检查真实文件是否丢失；下一轮应先以内存复现并设计失败即保留、并发安全的完整引用规则，不能以多读一张历史表宣称完整库存。

缩略图失败证据、主副本配额恢复、普通编辑/导入/恢复准入、可信页面/远端协调器、首次生产配置交接仍待完成。阶段 2 未整体验收，自动安装禁用；没有真实浏览器或实体双 Mac 新验证，未重启原服务、操作真实用户数据、创建仓库、提交、推送、发布或安装。Keychain、私有 GitHub 认证、签名和 launchd 待相应阶段验证。

## 2026-10-10 集中实现与批量验收（最新状态）

阶段 2 尚未整体验收，没有降低标准或把未完成项移到后续阶段冒充完成。此前小轮次记录保留用于追溯。

### 集中完成的实现

- `lib/recovery-read-gate.ts`：同步/异步恢复进行中或失败时禁止覆盖、删除原记录；同 key 明确非重叠成功读取后恢复。falsey rejection、重叠读取、抛错 then accessor 与容量溢出保守处理，不泄漏活动、不保留业务值。接入同步/异步 JSON、canvas 和 asset 存储；坏记录不标记 hydrated、不写空默认副本。
- `lib/localforage-storage.ts`：暂存配额失败后，只有 IndexedDB 字符串精确读回、前后无恢复副本/tombstone、revision 未变时才解除 staging 失败。冲突、读取失败、晚到副本或新写入均保持阻断，不清除旧恢复记录换取确认。
- `services/image-storage.ts`：缩略图查询、队列、解码和写入保留各自失败；解码失败不写有效 negative cache。原件就绪不等待预览，后续明确成功才恢复对应证据。
- 自动孤儿图片/媒体清理只扫描、保留候选，返回 `reference_inventory_unverified`，避免误删历史独占视频、产品回收副本及并发保存原件。明确用户选键删除保持原功能。代价是缓存占用可能增加，完整引用库存/事务证明后才能恢复回收。
- `scripts/lib/canvas-build.mjs`、Vite 与便携打包器绑定根版本、源代码/构建器指纹和精确文件哈希；构建期间源码改变失败。`--canvas-build` 在包内复制最新构建，不修改生产 public；内外两层清单必须一致。
- `npm run verify:phase2` 固定执行类型、全回归、当前/历史/暂存秘密扫描、当前构建、本地未签名打包和独立数据根的包健康/资源验证。拒绝任意命令或生产目标参数；脱敏报告 `output/phase2/latest-verification.json` 区分 localBatchPassed 与 fullPhase2Accepted。

### 已完成实测

- 全回归 314/314、typecheck、Vite build、三个秘密扫描通过。历史仍仅使用精确核实的旧占位例外；规则扫描不是绝对无秘密保证。既有 bridge、混合 import、大 bundle 警告保留。
- 当前源码本地未签名包：317 文件、6 HTTP 路由、独立 PID/版本/build/Origin 健康检查通过；最终包哈希见最新报告。不是 Stable，不验证发布签名、不允许自动安装。
- Playwright 独立浏览器、临时 Origin `127.0.0.1:58974`、禁止非测试 Origin 请求。真实 IndexedDB/localForage driver `asyncStorage`：坏 canvas JSON 不被编辑覆盖、明确修复后恢复/保存、12MB 字符串触发真实 localStorage QuotaExceededError 后 IndexedDB 精确读回、历史独占视频保留、storage 最终归零。只使用 QA 数据，不是完整跨窗口安装演练。
- 独立空白 context 加载新构建工作台：未连接 Agent 请求数 0、agent busy=false。不曾连接/使用 Agent 不需要其服务源码；已经开始任务后断线仍保持保护。
- 136 个 production public/布局/样式文件与本轮 pre 归档逐字一致，整个后端 index 也一致；未发布前端、未变 Origin。只读复核当前 5174 监听 PID 为 1510，而非早期记录的 32438。本轮没有发起生产重启/切换，不继续沿用旧 PID 声称未变。
- 原完整项目/代理/真实浏览器备份保留。本轮 pre-phase2-batch-20261010.tar.gz SHA-256 为 `4caa8402a2a7ee523fd5e95db750d0630b30167243168ac17476da63f76c0ad6`。收尾归档/校验见私有 BACKUP-README；Git 标签不包含未提交源码。

### 整体验收的确切未完成项

1. 普通编辑/导入/异步恢复完整准入与错误反馈，包括 Excel shell、旧插件和延后操作；现有生成任务准入不能冒充全部覆盖。
2. 可信窗口/缓存 iframe/旧页面库存与生产协调器，跨窗口/刷新/BFCache/HMR/晚到操作/失联保护。浏览器自报、本地 barrier/flush 和 QA fixture 均不能授权安装。
3. 完整任务证明后，首次私人配置交接、逐项对照和生产切换；尚未向真实私人目录导入运行代理配置或迁移浏览器数据。
4. API/Agent/WebDAV 等凭据仍走旧浏览器路径；Keychain/后端密钥代理和验证后的迁移未实现，URL Token 风险未消除。

以上是项目自身待实现工作，不是没有 GitHub 仓库或未连接 Agent 源码造成的阻塞。自动安装禁用；未创建仓库、提交、推送、正式发布、数据库迁移或实体双 Mac 更新。阶段 3 至 6 不提前宣称完成。

## 2026-10-10 Keychain 安全链路与首次人工维护切换（最新记录）

本节更新此前“尚未实现 Keychain / 尚未启用生产”的历史状态，但不宣称阶段 2 整体验收。

### 实现与隔离验证

- `src/native/keychain-helper.swift`、`src/server/keychain-vault.mjs`：Security.framework 原生通用密码；凭据只经 stdin/stdout 进入后端，不放命令行或日志。生产与随机 QA namespace 隔离；不覆盖已有账户、不触发自动授权弹窗。Node 桥接限制文件属主/权限、输入/输出大小及超时，整段 Buffer 解码避免多字节字符串跨 chunk 损坏。
- `credential-registry.mjs`：不可变账户、Keychain 精确读回后才登记引用；旧账户保留给在途请求。元数据只含 endpoint/kind/account/username，0600 原子保存。重复身份、未知字段、坏元数据保守拒绝，不用默认配置替代。原配置经 AES-256-GCM 加密、Keychain 保存随机恢复密钥，实际文件解密读回一致后才登记快照。
- `credential-migration.mjs`、`credential-http.mjs`、`secure-provider-proxy.mjs`：仅提供准备接口和绑定 endpoint 的受限代理，精确 Host/Origin、方法/路径白名单、禁止重定向/遍历、后端注入鉴权、过滤返回凭据及 Cookie；JSON/SSE 跨 chunk 脱敏。WebDAV 必须同时匹配 username 与引用。所有 profile 参数在准备写入前验证。准备接口不写浏览器、不自动迁移真实配置，不提供秘密导出或系统命令。
- 目前准备迁移支持内置 OpenAI、WebDAV、本地 Agent；Gemini 和自定义模型脚本仍保守拒绝，原配置不改。Agent 兼容既有上游 query-token 协议，仅移到后端，不宣称消除了上游 URL/日志风险。
- `scripts/build-keychain-helper.mjs`、`install-keychain-helper.mjs`、`lib/native-keychain-build.mjs`：本机 arm64 编译、源码/二进制 SHA-256 及 Mach-O 架构绑定、copy-once 私人目录安装。已有不同辅助程序不覆盖。`create-release --native-helper` 可包含已校验辅助程序；327 文件、6 HTTP 路由的未签名包通过隔离启动。Intel、代码签名及 Keychain ACL 升级兼容未验证；这个包不是 Stable，也不允许自动安装。
- 实际原生 QA Keychain 验证 insert/read/remove、Unicode 跨 chunk 和加密恢复；实际 Zustand/localStorage → prepare HTTP → QA Keychain → 受限后端 → 本机合成 OpenAI → 1px PNG 全链路通过，0 付费请求。QA namespace 两个账户已移除、0 保留，测试服务器及浏览器关闭。
- `services/config-file.ts`、`pages/canvas/index.tsx`、`services/product-recycle-bridge.ts`：配置导入、ZIP 导入、创建/回收/恢复的部分根入口接入准入；暂停时在读取/变更前拒绝新操作。并行 ZIP 文件写入采用实际 settleActivityGroup，失败仍等待所有已开始写入，不提前报告排空。不新增永久删除，不改变 JSX 或现有布局。
- 最新集中验收 335/335、typecheck、构建、当前/历史/暂存扫描及未签名包隔离启动通过。报告 `output/phase2/latest-verification.json` 仍明确 fullPhase2Accepted=false；扫描不是绝对无秘密证明。最新 sourceHash 为 `ace5181e4ac9935e3e6e422847d490a9a0029b14d34e99ee614b7084946caec8`。
- 此后为私人元数据/恢复增加 bounded file read，防止坏文件导致无限内存读取；规范化后的 Unicode endpoint 长度也必须合法，避免登记一个下次无法读取的 profile。32 项相关专项通过（其中新增 1 项），这两处后端加固与导入补丁一样暂未向运行中的进程启用；不把此前 335 项全量报告冒充这些最后变更的全量运行结果。

### 已执行的生产启用及数据保护

用户明确批准“测试通过之后进行首次服务切换”，并确认全部生成、Agent、WebDAV 已结束、画布已保存。只读检查显示原 5174 服务及 Chrome 均已停止，没有本地 Agent 监听；没有强杀旧服务或以未连接 Agent 为借口索取其它源码。

- 切换前增加真实 Chrome `Default` / `Profile 1` 的离线存储快照，覆盖 IndexedDB、localStorage、会话、文件系统/Service Worker 等已存在的 19 个条目及 Local State/偏好。解压隔离副本逐文件比较 11,254 文件、1,058,355,747 字节一致。它不是整个 Chrome profile/Cookies/Keychain/远端 WebDAV 的全量备份，也不是新版浏览器数据库迁移证明；最初完整项目、代理、真实逻辑浏览器备份持续保留。
- 私人目录原 profile YAML SHA-256 `72fdd21a4ace7f1b24e31d430cb54041f56aad620e1814a2f84352c64abc72b0`，原 transports 文件 SHA-256 `93e089fef21c9e1f1a358f0f51ac98b227952860901c01e7cb6a200b65fe2cf5`，不覆盖源配置。
- 已安装原生辅助程序到私人 runtime，安装过程没有读取或创建真实 Keychain 凭据。真实 credentials/status 仍是 profiles=0、snapshots=0；API Key 仍按旧浏览器路径使用，不能称为真实密钥迁移完成。
- 已部署通过校验的首批画布构建；`publish-canvas.mjs` 加入源码/清单核对及暂存副本校验，旧部署保存在 `../guan-ai-workbench-backups/guan-ai-workbench-20261010-221354-canvas-deployment`。该操作由人工维护授权执行，不是自动安装。
- 新后端 PID 79063，version 仍 1.0.3，buildId `7c2f29160dea8aa1f2c8105e`，Origin 仍 `http://127.0.0.1:5174`。健康检查、资源及原 CSS 路由补丁核验通过，Mihomo running=true、stateReadable=true。版本没有为了测试虚增。
- 新服务实际运行的代理配置经 PID/cwd/所属 supervisor/读前后状态核验后再次捕获，SHA-256 `316ce7e2d3cf9f2c861d76b81419d1f042c461b7f4515ce08a941db6fb8e787f`，与先前真实有效配置捕获一致。当前 enabled=true / relayEnabled=true 首次 copy-once 写入原先不存在的私人 state.json 并读回核验；已有文件不会覆盖。捕获记录仍 activityVerified=false / installAllowed=false，它自身不是安装许可。
- Playwright 独立空白 context 加载真实服务，创建 QA 产品后对应胶囊/画布出现、已保存可见；用户真实 Chrome 存储不写入，0 付费请求。旧归档的登录/统计请求被 CSP 阻止，另有旧 auth/session 405、locale prefetch 404 与预加载警告；没有通过放松 CSP 掩盖它们，不能宣称整个页面 console 无错误。测试 context 已关闭。

### 当前确切边界

首次启用部署的画布 sourceHash 为 `f931a6a18e94939b55092f697917b60c5c7fc8947ba3fa182028f2eb17a6c05a`。随后新增的导入准入补丁已在最新磁盘构建/未签名包验证，但**尚未向 production public 发布**。检测到非自动化的真实 Chrome 再次打开，后续切换安全检查已拒绝，未停止 PID 79063；不能假设先前空闲确认永久有效。

自动安装保持禁用，activity.unknown=true / canInstall=false。首次维护是用户明确确认 + 当时页面关闭后的人工切换，不冒充全窗口/远端任务权威库存或无人值守协调器通过。

仍需完成：完整编辑/异步恢复/Excel shell/旧插件准入及错误反馈；可信窗口/iframe/旧页与远端未决任务库存和生产协调器；实际凭据迁移、新凭据编辑及导入/导出/WebDAV 兼容（Keychain 引用不能当作可跨 Mac 使用的凭据），Gemini/自定义脚本的安全适配。新 helper 更新不能未经验证破坏旧账户访问。上述仍是项目实现缺口，不归因于未创建 GitHub 仓库或未连接 Agent。

本轮没有创建仓库、提交、推送、正式 Release、签名安装、launchd 更新器或双 Mac 更新；没有删除原始数据、旧配置或备份。恢复标签不包含脏源码，实际源码与私人数据备份的权限、范围、SHA-256 见私有 BACKUP-README。

## 2026-10-10 再次授权维护切换与配置导入保护（更新当前状态）

本节取代上节“导入补丁未上线 / PID 79063 保留”的当前状态描述；此前延期过程作为历史记录保留。

- 用户再次确认“已关闭”工作台标签页及任务后，核对原服务归属和活动、核对保存的代理开关，SIGTERM 正常退出原 PID 79063，没有强杀。新服务 PID 10088、version 1.0.3、buildId `40a1b85f6d87f6fbd0ac28d4`，健康检查 ready=true；Origin 仍为 `http://127.0.0.1:5174`。
- 已启用画布 sourceHash `ace5181e4ac9935e3e6e422847d490a9a0029b14d34e99ee614b7084946caec8`，以及最后的后端 bounded read / endpoint 长度加固。三个实际入口 JS/CSS/bridge HTTP 资源与该部署清单哈希一致。原先部署保存在 `../guan-ai-workbench-backups/guan-ai-workbench-20261010-222758-canvas-deployment`；更早的备份未覆盖。
- 代理 running=true、stateReadable=true。原 profile、transports、state 三文件 SHA-256 分别仍为 `72fdd21a4ace7f1b24e31d430cb54041f56aad620e1814a2f84352c64abc72b0`、`93e089fef21c9e1f1a358f0f51ac98b227952860901c01e7cb6a200b65fe2cf5`、`a7570003ccb471c2a8d7be6db7ba6c7020ae2812fc01396a816fd3016986e9ea`。没有输出文件内容。生产 credential profiles 为空，encryptedSnapshots=0；未迁移真实 API Key。
- 本次切换后的源码续作新增 `lib/config-portability.ts` 并接入配置导入：本机 `guan-vault:` 凭据或 `local-secure-api` 绑定不可通过普通便携配置导入，拒绝发生在 store 写入之前，并使用已有错误提示。原始 endpoint/明文配置路径仍兼容，不会把引用静默转换成空 Key 或另一台电脑的账户。文字提示中提及引用不当作凭据。
- 配置文件读取上限 4 MiB（文件大小及实际 UTF-8 大小），null/数组/错误核心结构拒绝；提示词 store 仅写 sources/schedule，避免附加 JSON 字段替换操作方法。该保护不等于完整配置 schema 或跨 store 事务；第二个 store 保存失败时仍需更完整的事务恢复设计。
- 新增导入保护尚只在源码及隔离构建中验证，不把它与已部署的 ace518 构建混为一谈。没有改变 JSX、布局、主题或现有按钮顺序。完整验收结果及新源码检查点见本节后续记录与私人备份说明。

automaticInstallAllowed=false、activity.unknown=true、canInstall=false 继续保持。完整编辑/异步恢复/Excel shell/旧插件准入、可信窗口及远端未决任务库存/生产协调器、真实凭据迁移/编辑/导出兼容及 Gemini/自定义脚本仍未整体验收。此次人工启用不授予无人值守安装权限；阶段 2 仍在实施。

本轮最终集中验收：339/339 回归、typecheck、当前/历史/暂存秘密扫描、当前源码构建、未签名便携包和独立数据根包启动验证全部通过。当前磁盘构建 sourceHash `0c57c32e6635a7c57ad8c616bc4692e1c62e31b3aa92966afc3e97baba414cb6`；本地样包 SHA-256 `d8bd276e70d85897040b69b7b15162477dc400882002ad1454012b5a7ee6b621`，322 文件、6 路由。报告仍为 fullPhase2Accepted=false；当前生产部署是上文 ace518，不能以样包验证冒充已上线或正式发布。新增导入回归使用真实准入/活动模块和实际源码，底层 store 夹具为内存；没有新的真实用户浏览器或双 Mac 演练。

## 2026-10-10 用户批准原阶段划分后的收口（当前权威状态）

用户明确选择“按原六阶段收口（推荐）”：阶段 2 是代码与私人数据隔离及兼容验证，完整自动安装协调器在阶段 5 实施，期间安装始终禁用。此前完整安装库存/协调器提前作为阶段 2 阻断，是实施范围安排失误；历史记录不删，本节取代此前“阶段 2 尚未整体验收”的当前范围判断。最终系统安全标准没有降低，阶段 5 未通过时仍不许安装。

**阶段 2 按用户批准的原范围验收通过**，详细清单、实际证明、源码/生产区别及残余风险见 `docs/PHASE2-ACCEPTANCE.md`。

收口新增真实隔离修复：`src/server/private-env.mjs` 是初始化后唯一持久环境来源，移除后端把旧 `.env.local` 再次叠加的入口，避免用户移除的旧设置被悄悄恢复。原文件不删除，copy-once 初始化和启动进程显式覆盖保持兼容；坏/超限私人文件保留并拒绝加载，不默认覆盖。5 项专项和 17 项相关测试通过；完整 344 项、类型/构建/三类扫描及隔离包运行通过。

4 份原备份重新计算哈希保持一致，原私人 profile/transports/state 的 3 项哈希/权限一致；原服务 PID10088 健康、代理正常、Origin不变。独立 Playwright 最新源码的实际新建/重命名/添加卡片/刷新持久化通过，0付费请求，QA服务/浏览器已关闭；测试可选插件索引缺失导致404，不宣称console无错误。15个受保护长模板不变，没有JSX/样式改动。

此后源码 env/配置导入加固没有强行向正在使用的服务热替换；隔离包验证不能冒充当前进程已加载。真实 API/Agent/WebDAV 浏览器凭据仍在旧路径，Keychain QA链路已验证但真实迁移、编辑/导出、Gemini/脚本兼容未完成，按安全工作流另行实现，保留旧配置。全窗口/旧页/远端任务库存、完整根准入与生产安装协调器是阶段5必过项；没有把它们称为已经实现。签名/CI/launchd/双实体Mac均未提前验收。

