# 阶段 3：私有 GitHub 认证、版本检测和更新界面

日期：2026-10-10，Asia/Shanghai。

状态：本地实现及隔离验证通过；真实私有仓库授权、Release 联调及生产启用尚未完成。仓库尚未创建，不自行创建、提交、推送或发布。阶段 2 的原范围验收保持通过，不把阶段 3 外部条件倒算为阶段 2 未完成。

## 实现

- 复用 `use-version-check.ts` 和 `VersionReleaseModal`，移除原项目公开仓库 VERSION/CHANGELOG 请求；前端只访问本机 `/local-app/updates/*`。
- 现有设置增加“软件更新”：当前/最新版本、渠道、检查时间、仓库、独立授权说明、自动检查/下载偏好、禁用的自动安装、更新网络、手动检查、原更新日志弹窗、最近 30 次检查记录。记录是检查历史，不冒充安装历史。
- Node 后端在启动及每 6 小时检查；自动检查默认开，可关闭。多窗口/iframe 手动请求合并，同仓库一分钟内不重复外部检查。自动下载默认偏好开，但阶段 4 下载验证链未完成前不生效；自动安装始终关闭，浏览器不能打开。
- 严格 SemVer，包含预发布优先级、build metadata 等价和大整数；不提示降级。遍历最多 10 页，每页 100 条，截断库存明确失败；不猜测完成。
- Stable 只接纳正式、非 Draft/Prerelease 的合法非预发布 tag，且必须有唯一已上传的 `guan-stable-manifest.json` 与 `guan-stable-manifest.sig`。这是阶段 4 的渠道契约，不是签名可信证明。普通 Push、无标记 Release、个人迁移包不能进入更新候选。
- Token 只由 macOS 终端隐藏输入，经原生辅助程序 stdin/stdout 存入 Keychain；不经浏览器、命令行参数、环境变量或 URL。每次重新授权使用新 UUID，旧账户保留，避免破坏在途请求。元数据绑定单一仓库，切仓库不能借用其它仓库凭据。
- GitHub 请求限定 `https://api.github.com/repos/{owner}/{repo}/releases`，固定 REST API 版本/Accept，禁止重定向，30 秒超时、每页 4 MiB。所有失败返回固定错误码，丢弃上游异常/body；发布说明纯文本展示并过滤当前 Token。
- 更新使用自己的 Undici 请求及独立 ProxyAgent，不改变 Mihomo 核心/配置。可选自动（有代理则走代理）、直连、必须代理；代理不可用报错，不能破坏当前工作台。不会为失败请求静默换渠道或写代理设置。
- 同源受限接口仅提供状态/检查/偏好，不接受 Token、下载 URL、系统命令、安装请求；Host/Origin、方法、JSON 字段和 4 KiB 请求体严格验证。更新失败不阻止画布和生成工作。

## 文件与私人存储

| 文件 | 作用 |
| --- | --- |
| `src/server/stable-version.mjs` | SemVer 和 owner/repository 校验 |
| `src/server/update-auth.mjs` | Keychain 引用、仓库绑定与读回验证 |
| `src/server/github-stable.mjs` | GitHub API、候选过滤、分页、有界读取和脱敏 |
| `src/server/software-updates.mjs` | 偏好、检查记录、启动/周期调度、并发合并和网络策略 |
| `src/server/update-http.mjs` | 同源受限 API |
| `src/server/index.mjs` | 初始化更新服务、路由接入、退出时停止计时器；已有 UI 模板不改 |
| `scripts/authorize-updates.mjs` | macOS 隐藏输入授权，不接受非终端输入或 Token 参数 |
| `src/canvas/services/software-updates.ts` | 本地请求/状态类型和中文错误说明 |
| `src/canvas/hooks/use-version-check.ts` | 复用原 Hook，只读取本地状态；周期 GitHub 请求由后端负责 |
| `src/canvas/components/layout/config-software-updates.tsx` | 设置页更新功能，复用原开关与原日志弹窗 |
| `app-config-modal.tsx` / `version-release-modal.tsx` / `use-config-store.ts` | 新页签、原弹窗状态说明、页签类型；其它渠道/生成业务不变 |
| `scripts/create-release.mjs` / `scripts/verify-release.mjs` | 公共授权脚本白名单、隔离包更新路由检查 |
| `scripts/verify-software-updates.mjs` | 一次性 QA UI→真实路由→真实服务→合成 GitHub；禁止真实网络/Keychain |
| `tests/software-updates.test.mjs` | 14 项安全/兼容专项回归 |

私人文件均在 `~/Library/Application Support/GuanAIWorkbench/updates/`：

- `preferences.json`：仓库、网络与开关，version 1。
- `github-auth.json`：仓库及 Keychain UUID，不含 Token。
- `check-history.json`：最近 30 次检查的时间/结果/版本/错误码，不含 Token。

0700 目录、0600 原子文件；有界读取、不跟随文件软链接，坏文件保留并失败。原业务数据库、配置和 Origin 不变；更新凭据不参与普通配置导入、WebDAV 同步或个人包分发。旧 Keychain 账户回收和跨进程授权管理需后续受控流程，不静默删账户。

## 授权使用流程（仓库创建后）

1. 用户指定 GitHub Private 仓库 `OWNER/REPOSITORY`，在软件更新页保存；本阶段不会替用户创建仓库。
2. 每台 Mac 自己创建 Fine-grained Token，只选择该仓库及 Contents: Read-only。GitHub REST Releases 文档确认读接口需要此权限；组织可能另需审批/SSO。客户端不能证明用户没有授予额外权限，应按说明最小化权限。
3. 确认原生 helper 已安全安装，在该机项目终端运行 `node scripts/authorize-updates.mjs OWNER/REPOSITORY`。Token 隐藏输入，不发聊天、不放 shell 命令历史；网页没有 Token 输入框。
4. 手动检查验证实际访问；401 提示重新授权，403/404 提示权限/仓库不可访问，429/限流及网络故障保留当前软件。
5. 阶段 4 确认签名/发布契约及双架构包后才开放可信下载；阶段 5 完整空闲协调、launchd、切换/回滚通过后才允许安装。

参考：GitHub 官方 REST Releases 文档 https://docs.github.com/en/rest/releases/releases 。本轮读取确认 Contents read、per_page 最大 100；没有使用任何真实 GitHub Token。

## 验证证据

- 全量 `npm test`：358/358；其中本阶段 14 项专项，涵盖 SemVer、正式通道、凭据读回、异常文件、调度、偏好重载、检查历史、降级、错误保留、合并请求、网络选择和真实 HTTP 同源保护。
- TypeScript typecheck 和 Vite build 通过；既有非 module bridge、混合 import 和大 bundle 警告保留，不等于阶段 4 可发布验收。
- 当前秘密扫描 951 候选无发现，暂存区为空，历史 1,359 blob 仅原两条精确旧占位例外；规则扫描不是绝对无秘密证明。没有改写历史或轮换真实凭据。
- 独立 Playwright Origin `127.0.0.1:65290`：现有设置→软件更新，显示当前 1.0.3/合成最新 1.0.4；手动检查、原日志弹窗、自动检查开关操作成功。刷新后 autoCheck=false、history=2、latest=1.0.4；Token 未进入 localStorage，installAllowed=false、canInstall=false。原生 Keychain 在阶段 2 有 QA 证明，本轮使用内存 vault，不冒充真实 GitHub/Keychain 授权。
- 此浏览器测试使用实际最新 UI/Hook/HTTP/SoftwareUpdates/GitHub 响应解析，但 GitHub 是后端合成响应，不对外发请求。新 Origin 配置路由拦截；初次测试根路径误拒绝后已修复。纯静态 QA 缺 logo.svg 的404及原 password/form 提示保留，不宣称 console 零错误。测试浏览器和服务已关闭。
- 本地未签名包 330 文件；独立进程/数据根启动、6 静态路由及更新状态接口检查。包 SHA-256 `229236fed4071049fb2ea9a293795da6b02b1441e2740113564fa3df8e4fed69`，不是 Stable、没有签名/安装。新增本记录前构建，最终记录包/检查点见私人备份说明，不覆盖既有包。
- 真实服务只读健康仍 PID10088、buildId40a1b85f6d87f6fbd0ac28d4、Origin `http://127.0.0.1:5174`、代理正常。本阶段源码未向真实进程启用，不重启正在运行的工作台。

## 尚未验收

真实私有仓库及每台 Mac GitHub Token/组织权限/真实代理网络联调、生产维护启用尚待条件具备。未消除原 AI/Agent/WebDAV 浏览器凭据风险；阶段 4 签名可信包、阶段 5 安装/回滚、阶段 6 双实体 Mac 验证仍未完成。没有用本地合成成功冒充整个阶段真实联调或自动更新系统完成。
