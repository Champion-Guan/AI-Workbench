# 阶段 4：稳定版构建、签名与可信下载

2026-10-11 最新授权：已调整为单人所有者发布，当前审批规则以 `STABLE-UPDATES-SINGLE-OWNER.md` 为准。下方受保护环境/独立审核人的描述保留为原方案历史，不再是当前阻断。双架构原生 QA 已通过，正式签名引导、具体版本发布和私有下载联调仍待批准/验收；自动安装关闭。

状态：本地核心实现及隔离验证通过，阶段 4 整体发布验收仍待外部条件。2026-10-11 已获用户授权创建私有仓库 `MrGuAm/guan-ai-workbench` 并上传源码，普通 Actions CI 已触发；正式签名密钥与 Stable 发布链仍未配置或执行。本文件不声明正式 Stable 已发布或双架构运行通过。生产服务不重启，安装始终关闭。

## 发布边界

- 普通 Push/PR 仅执行 typecheck、增量 ESLint、单元测试、当前源码构建、自定义当前/历史秘密扫描及独立 Gitleaks，不发布版本。
- Stable 仅 `workflow_dispatch`，输入已有版本标签及 `RELEASE-STABLE`。只从默认分支发起，标签必须指向触发时的默认分支提交并与根 package.json 一致，源码干净。构建和签名 checkout 同一个不可变 github.sha，而非稍后可被移动的标签。上传前及转正式版前再核对远端标签；仓库仍必须禁止标签变更，以防最后一次检查后的竞态。
- 分别在原生 `macos-15` arm64 与 `macos-15-intel` x64 构建，实际 process.arch 不符就停止。每个包包含官方 Node v24.16.0、许可证、锁定的 Undici、最新画布和本机 Keychain helper；不复制 Homebrew Node、私人配置或 Mihomo 核心。
- 受保护 `stable-release` 环境才可访问 Ed25519 私钥和发布权限。**必须由仓库管理员配置 Required reviewers、禁止自审、仅默认分支，并保护默认分支/版本标签；YAML 本身不能创建这些权限规则。** 未配置前不要设置签名 Secret 或发布。
- Actions 固定到已核对的 commit。运行时从 Node 官方 HTTPS 端点取得并核对官方 SHA256，构建后在各原生架构隔离启动；这不是独立上游签名验证，供应链仍需依赖审查和官方摘要审查。
- 发布先上传 Draft；核对 GitHub 每个资产 SHA-256 digest 后转为正式版。失败保留 Draft，不执行删除。发布请求超时可能产生不确定结果，重试前需检查 GitHub。

## 签名与首次引导

`src/server/stable-trust.mjs` 当前信任集为空，客户端安全拒绝下载。正式 Ed25519 私钥必须由用户在安全环境创建、离线备份，仅放受保护 Actions Secret。经人工核对的公钥及 SHA256(SPKI DER) keyId 必须先提交到源码；下载清单、偏好或环境变量不能添加信任。生产密钥没有由本次任务生成。

签名清单是规范化 JSON（两空格缩进、结尾换行），限定仓库、稳定版本、commit、构建时间、两个 macOS 架构和文件名/大小/hash/runtime 元数据；签名为原始 64 字节 Ed25519。客户端先验证内置信任，再使用 SHA256，不相信同源裸 checksum。

Mac B 旧个人包需要备份后一次人工引导安装，保留 `http://127.0.0.1:5174` 和原浏览器数据库。个人迁移包、未签名便携包不可作为 Stable。公钥轮换必须先由已信任版本发布双信任过渡，不能用远程文件替换公钥。

首次接入时，签名与包核验后按受控引导安装 Keychain helper；包内 `runtime/node scripts/install-keychain-helper.mjs` 为 copy-once，不替换已有不同 helper。已有安装的 Keychain ACL/升级兼容须在阶段 5 核验，不能因为包含二进制就宣称已完成 helper 升级。

## 本地命令

```sh
npm run lint
npm test
npm --prefix src/canvas run typecheck
npm run build:canvas
npm run native:build
npm run stable:runtime -- arm64 # Intel 机器使用 x64
npm run stable:build
node scripts/verify-stable-native.mjs
```

Stable 构建拒绝脏工作目录；不得为满足它而自动暂存/提交用户源码。当前开发仍可用 `npm run release -- --canvas-build --native-helper` 生成未签名 QA 包。

签名脚本仅在受保护 CI 中从 Secret 读取私钥，不接受命令行/聊天私钥。验证入口 `verify-signed-stable.mjs DIRECTORY OWNER/REPO VERSION ARCH` 先验签/包 hash 再验证 ZIP 和精确资源清单，不执行下载包。只有已验证清单的 runtime/node 允许超过通用 32MiB 文件扫描限制，且必须精确匹配独立签名的大小/hash；其它文件不豁免。

## 下载与数据保护

后端经 Keychain 获取仓库只读凭据，使用固定 GitHub 资产 API；凭据不转发到 CDN，只允许两个已知 HTTPS GitHub CDN 域。下载有超时、大小上限、磁盘余量检查，0600 暂存文件/0700 随机目录。签名、版本、仓库、架构、包大小及 SHA256 全部通过后显示已验证；不解压、不执行、不安装。

设置页复用原“软件更新”，新增下载按钮与进度、失败说明；默认自动下载只接纳可信包。当前未配置公钥，不会尝试下载包。失败保留当前软件和业务数据，只清理本次 partial。已验证包和失败残留目录保留，暂未提供跨进程续传、过期缓存回收或重启恢复 ready 状态。阶段 5 安装前必须重新验证签名/hash/ZIP，不可相信内存 ready。

## 待验收

真实私有 GitHub 授权、Release/CDN 与代理联调；受保护环境、正式签名公钥 bootstrap、真实 Actions 和 Intel 原生运行；首次客户引导。阶段 5 的可信空闲协调、launchd、安装、健康检查和回滚未实现，不以下载完成冒充安装成功。

## 2026-10-10 本地验证记录

- 全量回归、typecheck、增量 ESLint、最新源码构建和自定义三类秘密扫描通过。ESLint 只有 4 个既有 hooks 注释因 noInlineConfig 而无效的警告；没有借此改动原业务组件。Vite 既有非 module bridge、混合 import、大 chunk 警告保留。
- 官方 Node v24.16.0 的 arm64/x64 均经 HTTPS 下载、官方 checksum、Mach-O 架构及缓存精确 hash 验证。直连超时后显式使用现有 127.0.0.1:7890 代理，未改代理配置。arm64 binary hash `1ee75375e33b94fc34b3b19aede049e11dae90efb63b374dc96d6bdace70c4b8`，x64 hash `47483a524a057d93e246bb0e63867e2b4d189810aef53a6978d9e708a3d0f453`。
- arm64 QA 版使用同一稳定包构造函数，在独立私人目录/端口通过内置官方 Node 实际启动、PID/version/buildId/Origin 健康检查、页面/资源/更新路由；安装 false。工作目录脏，正式 Stable CLI 正确拒绝。QA 包虽为同一结构，**未签名且 commit 标签不证明这些未提交源码已进入 Git，不允许发布或自动安装**。Intel 只有运行时格式/hash 验证，没有 Intel 原生执行。
- 采用临时内存 Ed25519 密钥验证双架构合成包、精确清单、大小/hash、超过 32MiB 的特定 runtime 绑定、ZIP 遍历/链接、损坏签名、未知公钥、降级/仓库/架构错误、下载中断/取消及空间不足。不是正式密钥或真实发布链。
- Playwright 和全链路验证技能用于实际最新软件更新页 → 真 HTTP handler/SoftwareUpdates/StableDownload → 合成 GitHub/临时签名 → 私人暂存 → UI。点击后显示进度并达到已验证 100%，latest.verification=verified，Token 未进入 localStorage，install.allowed=false；修正了原先已验签仍显示“等待签名”的描述。隔离 Origin 51385，0 真实 GitHub/Keychain/付费生成请求。QA 缺 logo/favicon 的404保留，不宣称 console 零错误；测试服务/浏览器关闭。
- Gitleaks 8.24.3 官方工具包完整 SHA256 验证后才执行。首次网络下载中断的工具没有执行。全历史 24 条 generic-api-key 命中逐条核对 UTF-8 字节位置及原 Git blob，均为 `useNewApiKey: x.useNewApiKey === void 0 ?` 的默认值表达式，而非字面密钥；`.gitleaksignore` 仅列旧 commit/path/rule/line 指纹，`config/security/gitleaks-reviewed.json` 绑定 blob/字节位置，回归逐条核验。无全路径或通用规则豁免，换 scanner 版本需重新复核。复查全历史零未解决命中；当前实际源码与前端构建独立目录扫描也零命中。规则扫描仍不是所有秘密绝不存在的证明。
- YAML 语法与发布约束静态测试通过；Actions 未执行，不能据此确认环境审批、artifact/签名/上传或 GitHub digest API 实际兼容。
- 原 5174 服务仍 PID10088/buildId40a1b85f6d87f6fbd0ac28d4、ready=true、代理正常。没有生产发布/重启、真实凭据迁移、Git 提交/推送、GitHub 创建/正式 Release 或自动安装；旧配置、浏览器数据和全部备份保持。

最终数量、资源指纹及 QA 包位置见 `output/phase4/verification.json`，该文件明确 fullPhase4Accepted=false。真实仓库/正式签名引导、GitHub 网络和 Actions 联调、Intel 原生启动、两台 Mac 验收及阶段 5 安装协调仍不能跳过。当前已消除官方运行时网络准备和独立成熟本地扫描的前置待办，不把它们继续误列为未验证。

最终收尾回归为 378/378，包含服务停止后晚到检查不得启动下载的回归。当前源码扫描 978 候选，独立 Gitleaks 扫描 505 个实际源码文件及最新画布构建均无未解决命中。最新便携 QA 包为 `guan-ai-workbench-v1.0.3-20261010-155654.zip`，341 文件与 7 路由验证通过；相同运行源码构造的 `native-qa-checkpoint` arm64 包通过内置官方 Node 启动。构建时间标识为 UTC，不是新正式版本。源码检查点及改动前归档均在既有私人备份目录，校验见该目录 BACKUP-README；不替代最初用户数据备份。生产进程仍为 PID10088，未启用本阶段代码。

## 2026-10-11 首次 GitHub CI 联调

首次源码提交 `ff201e8` 已上传至私有仓库 main；仅推送 main，不推送恢复标签，不发布 Release。当前树 505 文件，503 个暂存变更经过秘密扫描；提交后的全 refs Gitleaks 无未解决命中。个人配置、运行数据、依赖、QA 输出和备份均未进入当前 Git 树。

首次 Actions 运行 `38067634635` 在画布 `npm ci` 处失败：已锁定的 `@ant-design/pro-components@3.0.0-beta.3` 声明 antd `^5.11.2` peer，但既有项目使用 antd 6。普通 CI 和 Stable build 显式增加 `--legacy-peer-deps`，仍使用原 lockfile 和 `--ignore-scripts`，不升级/降级依赖、不改业务 UI；新增约束断言，防止两个构建流程的安装策略漂移。独立空白目录安装 1,153 包通过，没有修改本机工作台依赖。此项为兼容现有依赖图的可复现安装策略，不代表上游正式支持 antd 6；待单独验证兼容新版后应移除此选项。

修复后的真实 CI 结果、提交号与链接以 GitHub Actions 和私人验收记录为准，不能用首次触发或本地安装成功冒充远端质量门禁通过。普通 CI 通过也不等于真实私有更新授权、签名、双架构 Stable 发布或客户安装验收。

第二次运行 `38067897890` 的安装/typecheck/Lint 已通过，378 测试中仅历史复核对象测试失败。24 条精确历史记录中的 1 条来自本机恢复标签而非 main；不为了测试上传恢复标签。将该固定提交显式标记 localRestoreOnly：本机存在时仍验证原 blob/字节；干净克隆确无此对象且全部 refs 不包含它时，仅免除这一不可读取对象的测试要求，23 条 main 历史证明全部保留。Gitleaks 仍扫描全部实际获取的 refs，指纹排除仍是原来的精确记录，未增加规则/路径豁免。

进一步对照官方 `gitleaks/gitleaks` v8.24.3 的 go.mod，确认其声明的模块路径仍为 `github.com/zricethezav/gitleaks/v8`。CI 改为此精确模块版本，继续由 Go checksum database 验证，不以仓库重命名后的 URL 猜测模块标识；增加约束回归。真实 CI 门禁不减少。
