# 阶段 5：独立更新器（实施中）

2026-10-11。用户批准开始阶段5，并将后续平台范围限定为macOS arm64。**本阶段尚未整体验收，生产自动安装仍关闭。** 不把隔离事务测试称为完整无人值守安装。

## 本轮实现

| 文件 | 作用 |
| --- | --- |
| `src/server/update-manager.mjs` | 独立于Web服务的安装事务核心、版本目录、签名暂存、当前版本指针、持久journal、健康校验、回滚与中断恢复 |
| `scripts/lib/signed-stable.mjs` | O_NOFOLLOW有界读取、签名与精确包验证、磁盘预检、从同一份已验证字节复制，不重新读取可替换的下载输入 |
| `src/server/update-manager-ipc.mjs` | 0600用户态Unix socket，只允许status和严格身份的stage；不接受路径、URL、Token、安装/删除/命令执行 |
| `scripts/run-update-manager.mjs` | 独立daemon入口，不读取runtime.env，不依赖Web服务生命周期，当前不接入安装协调器 |
| `src/server/update-launchd.mjs` | 生成用户态LaunchAgent plist，固定独立manager的Node/入口，不跟随应用current指针变化；不实际安装或运行launchctl |
| `src/server/update-startup.mjs`、`index.mjs` | 新版本启动隔离：仅健康检查可访问，所有业务/更新/静态页面返回503；只有继承的Node IPC精确nonce可激活，无HTTP解锁接口 |
| `scripts/create-release.mjs` | 白名单包含独立入口及其验证依赖，不把测试、开发工具或私人目录装入包 |
| `tests/update-manager*.test.mjs`、`update-startup.test.mjs`、`helpers/signed-update.mjs` | 签名ZIP、失败/回滚、实际子进程退出、Unix协议、plist、真实隔离后端的启动隔离回归 |

## 安装目录及数据边界

```text
~/Library/Application Support/GuanAIWorkbench/
  data/                         # 原私人配置、runtime/helper、代理，更新器不写
  updates/packages/verified-*/   # 已有下载器的私有下载目录
  updates/u.sock                # 独立更新器受限本地通信
  installation/
    versions/<版本-commit-包hash>/
    records/<同一身份>/          # 原签名、清单、ZIP，复核提取后的文件真实性
    current.json                # 原子/fsync更新的版本指针，不修改版本目录
    transaction.json            # prepared/stopping/switching/starting/...恢复记录
    manager.lock                # 跨进程互斥；活PID/坏记录/不确定状态拒绝
```

私有根及已存在的data保持原位置，不迁移IndexedDB/localForage/localStorage；Origin固定`http://127.0.0.1:5174`。root不能包含data、位于data之下、位于项目内，或是系统根/主目录；版本和记录目录不能是链接。签名ZIP/原记录保留，不自动清理旧版本、中断目录或业务文件。

每个stage从内置公钥重新验证仓库、版本、commit、平台、arm64、ZIP安全、精确内外文件清单及Node/helper架构。检查空间后从已验证快照复制，并重新核对目标。记录中保留原签名ZIP；不能只相信解压后可被改写的RELEASE.json或自算hash。

当前指针首次建立是**单独的bootstrap流程**。事务核心在current不存在时拒绝install；不能把旧工作目录、一个PID或浏览器零计数直接当成已接管的旧版本。只有测试fixture直接建立模拟旧版本指针，不存在生产绕过API。

## 事务和恢复规则

1. 重验旧版和新版，拒绝同版、降级和未知身份。
2. 可信协调器必须发放覆盖完整库存/epoch/排空/持久化/冻结的持续租约；缺失即拒绝。当前daemon未接入此协调器，永远不会安装。
3. 写prepared，再写stopping；停止必须由精确拥有该服务的适配器完成并确认，不根据端口/PID猜测强杀其它服务。
4. 再验租约，写switching，原子更新current，写starting，隔离启动新服务，校验ready、版本、buildId和稳定Origin。
5. 写committed以后才允许激活业务入口。激活确认丢失可能意味着已开放业务，不能直接降级；保留新版与租约，进入activation-required等待可信协调器核对。
6. committed之前启动/健康失败：记录rolling-back，停止受控进程，恢复旧current，启动/验证旧版，记录rolled-back。回滚失败保留journal和暂停租约，不释放新任务入口。
7. 重启后，非终态journal只有在服务适配器明确证明recoverySafe时才回滚；未知服务/冲突current/坏记录一律拒绝。不自动执行不可逆数据迁移。

文件/目录同步和原子rename降低中断窗口；实际子进程退出测试验证journal恢复逻辑，不声称已模拟物理断电、磁盘控制器故障或APFS全部故障。文件锁只自动处理明确不存在的PID；PID被复用等不确定情况会保守阻断。

## 已完成验证

- 完整`npm test`：419/419通过。TypeScript和Vite构建通过；Lint 0错误、4条既有noInlineConfig警告。既有bridge/混合import/大bundle提示保留。
- 合成包采用真实Ed25519签名、ZIP、精确清单和Mach-O头；不执行合成payload。覆盖签名/文件/RELEASE篡改、低/未知磁盘空间、无协调器/伪造/失效租约、停止未确认、启动失败、版本/Origin/buildId/ready不符、激活确认丢失、回滚失败、降级和未引导安装拒绝。
- 在prepared、stopping、switching、starting、committed五个fsync边界真实终止独立Node子进程。重建manager：非终态恢复旧指针并验证数据保留，committed保留新版。服务启动/停止在这些事务测试中是受控fixture，不是launchd或真实生产服务。
- 真实隔离后端临时端口/独立私人目录、禁用真实Mihomo：health展示maintenance=true，业务路由503；错误nonce不解锁，继承IPC激活后health/首页正常。测试不是原Chrome/外部Agent/完整多窗口验收，0付费请求。
- 原已发布v1.0.4 arm64签名包经新manager实际stage与目标复核，347文件、buildId`61fc653824dc4e84e1716ee8`，current仍null，未执行其payload，未安装。脱敏结果在`output/phase5/real-arm64-staging.json`。
- 本轮未签名便携样包352文件、7个HTTP路由的隔离启动验证通过；直接从解压包启动独立daemon，独立临时私人根的Unix status正常且installAllowed=false，随后正常停止。该样包形成于最后文档加入前，不是新Stable；最终原生QA将从提交源码重新构建。
- 已运行源码/历史扫描，原精确历史占位例外保留；发布前仍需独立扫描、暂存扫描和实际CI。规则扫描不是所有秘密绝不存在的保证。
- 代码提交`8d9707bd9ddfa1b0f5083fff4471790dedac032a`已推送私有main。普通质量CI [38104370214](https://github.com/MrGuAm/guan-ai-workbench/actions/runs/38104370214)通过；arm64-only Build-QA [38104395187](https://github.com/MrGuAm/guan-ai-workbench/actions/runs/38104395187)的quality及唯一`build (macos-15, arm64)`均成功，包含实际内置Node/资源/更新状态启动验证。没有Intel任务、签名Secret或发布任务。旧Actions Node20强制Node24、Go缓存缺少go.sum及arm64队列提示仍在，不影响本次通过。

## 下一批必须完成后才能验收阶段5

1. **可信协调器**：完整窗口/Excel shell/缓存iframe/旧页库存；普通编辑/导入/恢复、旧插件的准入与实际存储排空；断线/刷新/BFCache、已开始Agent与远端未决任务处理。自注册和浏览器零计数不授权安装。未连接且未使用Agent不要求其不存在的源码。
2. **真实进程适配器与launchd接管**：独立manager自身稳定安装位置、应用服务的精确拥有权、启动隔离及继承IPC、graceful stop、健康超时；不能强杀不明进程。将启动/停止fixture替换为实际签名包和launchd隔离演练。
3. **终态激活协调**：committed后进程退出、IPC确认丢失时，查明真实服务状态，幂等完成激活；不能使用目前no-recovery-needed结果直接开放任务。冷启动不能抹掉未决任务或坏journal。
4. **首次bootstrap和客户引导**：维护窗口、原配置/浏览器完整备份及核对、旧服务正常停止；不能直接拿旧Mac个人包覆盖安装目录或依赖git pull。
5. **后端/UI接入**：Web后端只能传downloadId/version到Unix socket，展示安装/恢复状态；生产不开放路径/命令。当前尚未从软件更新UI自动调用stage或install，autoInstall仍false。
6. **Keychain helper兼容**：更新器不覆盖私人runtime中的helper。新helper替换/ACL必须独立验证，不以同源码重新编译视作可安全覆盖。真实AI/Agent/WebDAV浏览器凭据尚未自动迁移。
7. **完整故障演练**：实际服务与代理重启、磁盘不足/下载中断/意外关机/版本切换故障、浏览器备份读回及原数据保留。阶段6仍需两台实体arm64 Mac，不用fixture代替。

## 生产与发布状态

本轮不提升版本、不创建/修改标签、不发布Release、不迁移数据库、不安装LaunchAgent、不启动真实manager、不重启生产、不写原浏览器或私人配置。当前生产仍v1.0.3/PID10088、Origin不变、代理正常；v1.0.4历史Intel资产保留。

更改前源码归档`pre-phase5-arm64-20261011.tar.gz`，SHA256`fd43f90a68f785bf8faa3c3e277d8815ca2fb790182e9d3e17226a9b6eef6f85`。原完整项目/代理/浏览器备份持续保留；本轮源码检查点不是新增完整用户数据备份，也不是离线灾备。

改动后提交源码归档`phase5-arm64-core-8d9707b.tar.gz`，SHA256`fb01374f8fc25f27a4c0b9d5385375e4b19578409ab54c19cca7fffe27db3a68`。改动前522文件、改动后532文件均解压与对应Git提交逐文件比较一致。该归档固定功能提交，不包含本节随后加入的CI验收说明；不移动v1.0.4标签或改写旧Release。
