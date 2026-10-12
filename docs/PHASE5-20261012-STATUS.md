# 阶段 5：2026-10-12 集中验收及发布阻断

结论：用户批准本机签名方案后，已从固定 f81235a 构建并发布 v1.0.5 arm64 Stable，原可信密钥签名、私有仓库实际下载及完整库存验签通过。Actions 保持停用；阶段 5 仍待首次生产安装/切换，不以发布代替整体完成。未重启当前工作台。

## 固定验收身份

- 仓库：私有 `MrGuAm/guan-ai-workbench`，所有者 ID `87700227`。
- 提交：`f81235a1c82670de312c9ea7cdac382b70338973`。
- 标签：`v1.0.5`，固定到上述提交，未移动已有标签。
- 本机集中报告：独立 QA worktree 的 `output/phase5/latest-verification.json`，UTC `2026-10-11T16:43:04.349Z`。
- sourceHash：`cedf88079343f3ca1c3450fee073e79f5a800917d2f1847f31508a88eb32801f`。

## 已通过

完整 541 项测试、Typecheck、Lint、当前/历史/暂存敏感扫描、真实用户态 launchd、独立 supervisor、manager 重启保留 supervisor、当前源码画布构建、373 文件/7 路由的未签名便携包及实际隔离运行。前后源码快照、生产健康身份和三个私人配置文件哈希不变。未签名便携包不能用于生产自动安装。

- Source CI：`38155895028`，成功。
- macOS arm64 BUILD-ONLY：`38155932572`，成功，含实际 bundled Node 原生包运行检查。
- 正式发布工作流：`38156763865`，固定同一提交。quality 成功；build 未获得 runner，publish 跳过。
- 本机独立只读更新授权已通过真实 GitHub API 验证，可读取正式 v1.0.4。Token 仅通过 Keychain/后端使用，未输出或复制进源码。更新渠道已绑定该仓库，保留 autoCheck=true、autoDownload=true、autoInstall=false。

本轮没有迁移原 Chrome 数据、真实 AI 密钥或 WebDAV 凭据。三文件校验仅证明 profile/state/transports 未变，不等于所有私人文件或 IndexedDB 已经逐项读回。原完整备份仍保留；首次接管所需的最新离线 data/Chrome 备份尚未执行。

## 本轮修正

- 原代理集成测试改用临时可执行夹具，不再 chmod 源码夹具。
- 冷启动验收尊重更新锁，只在明确 update_in_progress 时有界重试，不删除锁。
- 首次部署等待 manager 和认证 supervisor 同时就绪，不能只凭 manager socket 判断成功。
- 丢回执测试等待完整操作的回执尝试，不用固定 5ms 猜测落盘结束。
- 浏览器 census 按可执行文件名判断，不将原生桥接目录名或固定 crashpad 报告进程当成网页宿主；未知 renderer/WebView 继续否决，也不授予库存权威。
- 重型原生测试串行执行，保留全部断言及每项测试的超时限制。并发失败记录和旧 Actions 结果未隐藏，也未拿旧提交代替最终验收。

## GitHub 外部阻断证据

失败 job/check：`114522583346`。没有执行任何 build step、没有分配 runner。GitHub annotation 原文：

> The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings

这条提示不能区分具体是支付失败还是支出限额；没有据此推断额度、账单金额或购买套餐。另一条 macOS arm64 容量提示仅是 notice，不代替上述 failure 原因。

未生成正式 v1.0.5 签名、未上传 Draft/Stable、未覆盖 v1.0.4、未读取 Actions Secret 或签名私钥。未安装不可信包，也没有擅自改用离线签名或在私人 Mac 安装 GitHub self-hosted runner。

## 暂停 Actions（最新决定）

用户明确要求先跳过 GitHub Actions。已使用仓库 Actions permissions 接口关闭 `MrGuAm/guan-ai-workbench` 的 Actions，并重新读取确认 `enabled=false`；查询最近运行无未完成任务。该仓库后续 Push 不运行 Actions，但 Git 源码、工作流文件及 GitHub Releases 保留。未删除历史运行或资产，也未改动其他仓库、支付设置、签名 Secret、私人配置或生产服务。

现有 `sign-stable-release.mjs` / `publish-stable-release.mjs` 使用 CI-only 所有者审批。不得设置假的 `GITHUB_ACTIONS` 或伪造事件绕过验证。建议替代为本机原生构建、完整质量/秘密扫描、所有者明确确认、复用既有可信密钥签名、Draft 资产核验后发布；GitHub 仅负责源码和 Release 托管。此前用户选择 Actions 签名，故在明确批准本机签名替代方案前，不解密本机签名备份、不生成或轮换密钥、不发布未签名 Stable。

本机替代方案获批后仍从固定 f81235a / v1.0.5 构建，不移动标签；保持原可信公钥，实际独立只读下载与签名/完整库存验证通过后再请求新的生产维护确认。关闭 Actions 不代表关闭客户端更新检查，也不代表阶段 5 已完成。

## 原 Actions 恢复顺序（历史，当前不执行）

以下是此前 Actions 恢复计划，已由用户批准的本机发布取代。最新结果：Release `410072526`，4 个资产、非 Draft/Prerelease；包 SHA-256 `62a9308237ce75b410b8325497768af88caf8011524a1dfcb161a28e19b757b4`。本机发布入口核实真实 owner、私有仓库 admin、干净固定源码和标签；复用 Keychain 加密签名备份，不伪造 CI，不导出私钥。新增相关专项 13 项、Lint 通过，bundled Node 真实隔离启动、隔离激活通过。客户端独立只读授权下载到 `verified-efdb393c-1427-47e5-8763-885b77046ff9`，内置公钥、清单、ZIP、382 文件、提交、arm64、startupProtocol=1 全部通过；未执行下载包。真实 Token 不进入日志。

首次生产接管仍需当前维护确认与完整离线备份。旧 v1.0.4、固定 v1.0.5 标签、生产 Origin 和私人数据不改；自动安装仍关闭。

1. 由用户处理 GitHub Billing & plans 中的失败付款或 Actions 支出限制。不自动代付、增加预算或购买套餐。若改用本机离线签名，须用户另行明确批准改变原方案和安全流程。
2. 问题处理后，只重跑 `38156763865` 的失败 job，保留已通过 quality、同一 commit/input/tag；先核对不存在不确定的 Draft/Release，再恢复。不得重新创建、移动或强推 v1.0.5 标签。
3. 正式流程的原生测试、签名、Draft 摘要核验和发布全部成功后，用本机独立只读授权实际下载 v1.0.5，再验证内置可信 Ed25519 公钥、SHA-256、完整 ZIP/文件库存、commit、arm64 和 startupProtocol=1。
4. 仅准备签名 runtime；取得新的当前维护确认，确认保存、生成/Agent/WebDAV 全部结束、浏览器退出，正常停止确切旧服务，完成最新完整离线 data/Chrome 备份。
5. 执行原生首次接管，保持 Origin 5174 和私人配置。验证真实 Mihomo/helper、健康、原 Chrome 的画布/历史/配置/媒体读回后，才签收阶段 5。

每次安装仍需单独确认，未知或未决记录不清除。阶段 6 两台实体 Mac 尚未开始；实体断电没有用模拟进程退出冒充。
