# 受管理 Chrome 窗口接入

用户已批准保留现有 Chrome 数据，并允许受限扩展及本机桥接。以下为开发验收接入，不是正式签名安装器，也不代表阶段 5 完成。

## 权限与数据边界

- 扩展在 `browser/managed-workbench`，点击扩展按钮打开同一 Chrome 配置中的工作台窗口。地址固定 `http://127.0.0.1:5174`，不创建或复制 profile，不迁移 IndexedDB/localStorage。
- 唯一 Host 权限是该 Origin；没有 `tabs`、`debugger`、Cookies、浏览器历史或任意 URL 权限。用户另外批准了仅匹配该 Origin 的 `ISOLATED` 内容脚本，覆盖同源子 frame，不匹配其它网站或其它本机端口。
- `webNavigation` 枚举该工作台的 frame/document 身份；`nativeMessaging` 连接唯一 `com.guanaiworkbench.browser`；没有浏览器 `storage` 权限。不会读取其他网站内容。
- 只向本机桥接发送 tab/window/frame/document ID、生命周期、递增 revision；不发送网址路径、标题、查询参数、提示词、API Key、图片或画布内容。
- 桥接只读观察、原生 stdio 有界消息，没有 HTTP、系统命令、更新安装、启动/停止服务或凭据 API。记录目前仅在该桥接进程内存中，不通过浏览器自报授予安装许可。

## 受限页面通信：安装前说明

用户于 2026-10-11 明确允许“受限页面暂停与保存确认通信”。本节为新代码启用前的权限和回退说明，**当前生产页面和已加载扩展仍为此前版本，新通信尚未在用户工作台启用**。

- `browser/managed-workbench/manifest.json`：新增 `content_scripts`，匹配 `http://127.0.0.1:5174/*`，`all_frames=true`、`document_start`、`world=ISOLATED`；原 `nativeMessaging` / `webNavigation` 两项权限及单 Origin host 权限不扩大。无后台外网请求、`externally_connectable`、任意脚本执行或额外存储权限。
- `browser/managed-workbench/page-relay.js`：仅在匹配的文档发现应用就绪，以 `MessageChannel` 传递严格的 `probe/pause/assert/resume`。不读取 DOM 业务值、提示词、Key、localStorage 或 IndexedDB；不使用 fetch。只向扩展 background 返回固定版本、五类活动计数、revision、epoch、保存确认和四个通用错误码，附加字段不转发。
- `browser/managed-workbench/background.js`：来源必须是自身扩展，由 Chrome 提供 tab/frame/document 身份；session/序号/容量/心跳有界。过期或失联保留 unknown；慢回复不能覆盖较新状态。当前本机只读 host **仅观察，自动发送 probe，不发 pause/resume 或安装指令**，控制命令仅由隔离 QA 演练。
- `src/canvas/services/managed-page-relay.ts` 和 `src/canvas/lib/managed-page-control.ts`：应用侧只接受原 Origin / 同 window / 精确握手及单 session。暂停现有已接入任务根，旧任务子操作与保存继续；实际排空与 flusher 成功才确认，晚到活动、HMR 或生命周期变化使确认失效。断连不取消请求、不释放未决远端任务、不隐式恢复。
- `src/canvas/main.tsx`：仅增加应用启动与 HMR 清理接入，不改变 JSX、布局或主题。

同 Origin 主世界脚本可观察握手并伪造页面消息，所以页面回复仍是辅助证据，**不是独立可信安装授权**。普通编辑、Excel shell、旧插件及所有 profile 尚未完整覆盖。所有回复明确 `fullRootCoverage=false/installAllowed=false`，不从一次保存成功推导全局可安装。

启用顺序：先查看以上源代码与权限，完成集中验证；再重新加载扩展。旧工作台页面不会被强制刷新或热替换，未接入的页面保持 unknown。应用新代码部署必须另行经过正式兼容版本及维护窗口，不沿用先前已经过期的空闲确认。

回退新通信：在 Chrome 扩展页停用或移除该扩展即可停止内容脚本在新文档的注入；现有文档中的脚本在该文档结束时退出，不伪造保存/恢复信号。若曾进入暂停，应在安全维护中重新打开原工作台，而不是清除数据库或自动释放未知任务。工作台保留原 Origin 和原 profile。源码回退检查点 `restore/pre-managed-page-relay-20261011` 不替代用户数据备份。

## 人工接入步骤

1. 在真正使用工作台的 Chrome 配置中打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，选择上述目录。不要导入空的新 Chrome profile。
2. 复制扩展页显示的 32 位扩展 ID。ID 不是 Token；不要发送任何凭据。
3. 在该项目中执行 `node scripts/install-readonly-browser-bridge.mjs INSTALL-READONLY-BRIDGE <扩展ID>`，仅安装本机只读验收桥接。该命令要求 macOS arm64、已核对的独立 Node runtime；不接受任意来源/路径/命令。
4. 重新加载扩展，点击图标打开工作台。蓝色数字只表示当前 profile 中观察到的工作台 tab 数；`!` 表示桥接未连接，`?` 表示库存暂时未知，均不授予安装许可。

### 本机接入验证（2026-10-11）

用户在现有 Champion 配置加载扩展并提供 ID `oblgadpoaffdmipkdgimjmcgjhngajkn`，只读 native host 已安装且仅允许该 ID。实际 Chrome 初测发现 documentId 是 32 位大写十六进制，而非测试夹具的带连字符 UUID；已在扩展发送前规范化为同一 opaque UUID，非法/缺失 ID 保持 unknown，并补充真实格式及 malformed 回归。没有放宽原生报告验证。

重新加载后确认原生桥接进程持续连接，工具栏显示蓝色 `2`，与同一配置的两个工作台标签页相符。扩展按钮打开固定原 Origin 的普通窗口，原有产品与画布可见；没有编辑产品、创建空 profile、执行生成或重启服务。这是实际单 profile 接入验证，不是全窗口任务空闲或阶段 5 完整验收。只读诊断不输出 URL、标题、提示词或凭据。

本机设置仅增加 Chrome `NativeMessagingHosts/com.guanaiworkbench.browser.json`（仅允许提供的扩展 ID）及私人 `updates/browser-bridge-qa/<源码hash>/` 的固定 Node/桥接副本。已有不同 host 保留并拒绝覆盖。不修改 Chrome Preferences、代理、密钥、业务数据库或工作台服务。

## 卸载与回退

在扩展页移除本扩展即可停止连接；工作台仍可用普通 Chrome 窗口访问原地址。只读桥接不会自行运行或接管服务。确认没有其它本项目连接后，可以单独移除上面这个 NativeMessagingHosts manifest 和它指向的 QA 目录；不要删除 Chrome profile、IndexedDB、localStorage、私人 data 或整棵 updates 目录。

## 尚未完成的安装证明

当前浏览器级观测比页面自注册覆盖更广，但只有当前 profile。零 tab 数不能证明其它 profile、浏览器、BFCache/旧页面、未决 Agent/视频、编辑及存储排空。NativeMessaging 的 allowed_origins 由人工 manifest 限定，桥接脚本自身格式检查不是全部 Chrome profile 的认证证明。

还需要跨 profile/普通浏览器的完整库存、页面两步暂停与存储排空、独立协调器持续 lease、签名稳定桥接引导及生产维护切换。代码明确 `inventoryVerified=false`、`profileOnly=true`、`installAllowed=false`，未降低验收标准。本接入不读/修改真实 Keychain，也不发布新 Release。

### 新通信的隔离验证范围

实际控制器、应用 relay、内容脚本及 background 在独立 vm realms / 真 MessageChannel 中验证身份、旧页、排空、失联、重放、生命周期、乱序回复和排空期间探测；Chrome API 明确为夹具。

使用 Playwright CLI 独立临时 profile，所有页面请求离线 route 到 QA payload（其余请求 abort），不向真实 5174 服务发送页面请求：暂停后新根拒绝，旧任务完成后仍等待真实 IndexedDB 写入及读回，保存完成才确认，零计数 ABA 使确认失效，明确 resume 后恢复 active。仅保存 `guan-managed-page-qa` 的 `qa-sentinel`；不是用户数据库或实际 Chrome 扩展世界/原生协调器验收。独立 QA 浏览器和 payload 服务已关闭。隔离页 console 0 errors/0 warnings；该结论不推广至生产页面。
