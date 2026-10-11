# 受管理 Chrome 窗口接入

用户已批准保留现有 Chrome 数据，并允许受限扩展及本机桥接。以下为开发验收接入，不是正式签名安装器，也不代表阶段 5 完成。

## 权限与数据边界

- 扩展在 `browser/managed-workbench`，点击扩展按钮打开同一 Chrome 配置中的工作台窗口。地址固定 `http://127.0.0.1:5174`，不创建或复制 profile，不迁移 IndexedDB/localStorage。
- 唯一 Host 权限是该 Origin；没有 `tabs`、`debugger`、Cookies、浏览器历史、任意 URL 或内容脚本权限。
- `webNavigation` 枚举该工作台的 frame/document 身份；`nativeMessaging` 连接唯一 `com.guanaiworkbench.browser`；没有浏览器 `storage` 权限。不会读取其他网站内容。
- 只向本机桥接发送 tab/window/frame/document ID、生命周期、递增 revision；不发送网址路径、标题、查询参数、提示词、API Key、图片或画布内容。
- 桥接只读观察、原生 stdio 有界消息，没有 HTTP、系统命令、更新安装、启动/停止服务或凭据 API。记录目前仅在该桥接进程内存中，不通过浏览器自报授予安装许可。

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
