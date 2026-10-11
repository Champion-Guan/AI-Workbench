# 阶段 5 第一版安全安装与接管

2026-10-11。用户明确接受“每次安装前确认，先完成安全版”。本文件取代其它历史记录中把任意旧插件/外部 Agent 全自动库存作为第一版必过项的安排；不取代数据安全标准。阶段 5 仍待正式包、备份与生产接管验收，不能以此文或源码模块完成宣布整阶段完成。

## 安装许可

默认检查和下载开启，自动安装默认关闭且可设置。即使开启，每一个新版本仍须点击“确认并准备安装”，明确确认画布已保存、生成/Agent/WebDAV全部结束，然后退出所有浏览器。确认只绑定确切旧/新签名身份、服务实例、任务和写入 revision，30分钟失效，不授权下一版本。取消弹窗不授权；“稍后安装”持久暂缓未开始的许可，不能取消已经 claimed 的事务。

进程 census 只提供否决，不授予全浏览器库存。原生账本缺失/损坏/有pending、文件锁不明、保存失败、浏览器重开、任务或写入ABA、服务所有权失联均拒绝。人工确认不能清除上述证据。旧页及任意插件的保存/远端结束由本次操作者确认承担，不声称已实现机器自动权威证明。

独立 manager 每5秒检查许可及设置。实际 coordinator 经独立 supervisor 的认证继承IPC冻结确切后端，连续核对账本、写入、instance/epoch/revision和浏览器状态，再执行签名复核、停止、原子版本切换、隔离启动、健康核对和激活；激活后再次检查。失败回滚旧签名版本。不能安全恢复时保留journal、版本、原配置及备份，停止更新，不删记录解锁，也不强杀或领养未知PID。

## 本轮新增接入

| 文件 | 作用 |
| --- | --- |
| `update-operator-authority.mjs` | 私人每版本确认记录、claim、TTL、revision及owned服务校验；bootstrap仅原生入口 |
| `update-closed-browser-coordinator.mjs` | 真实后端冻结、连续许可与明确恢复，未知时保持暂停 |
| `update-install-scheduler.mjs` | 独立于浏览器的有限调度，尊重关闭/暂缓，不自动清理未知记录 |
| `update-deployment.mjs` | 严格用户态launchctl、签名独立runtime的两job安装、manager升级及部署回滚 |
| `update-maintenance-backup.mjs` | 离线复制私人data和原Chrome树、逐文件hash及源前后复核，备份仅本机0700/0600 |
| `bootstrap-stable-updater.mjs` | 固定原生prepare/bootstrap/upgrade-manager入口，拒绝网页路径/URL/命令输入 |

这些模块位于 `src/server/`，原生脚本位于 `scripts/`。HTTP只新增固定acknowledgement的approve和无参数defer；不开放install/recover/bootstrap/freeze/任意系统命令。现有设置页/版本Hook继续复用，UI独立更新命名空间。

## 独立更新器升级边界

签名runtime不可变，manager升级从另一个可信原生installer执行，仅替换manager job；旧签名supervisor继续持有确切应用ChildProcess，应用PID不变。启动或健康失败恢复原manager。不得修改共享 `~/Library/LaunchAgents` 的目录权限或其它job。

supervisor协议1的自身替换是单独停止服务维护流程，不与每次应用升级捆绑，不在当前版本自动替换。supervisor崩溃或系统重启后发现陌生端口/孤儿进程时拒绝领养；此时需要新的维护诊断和备份，不能承诺无人参与恢复所有未知状态。过期claimed记录也保持阻断，由新的明确维护确认和严格所有权检查处理，不能删账本或journal绕过。

正常重新登录/重启仅重新启动已完成安装、确认completed且精确对应终态journal/activated bootstrap的当前签名版本，不切换版本，不复用过期确认授权新安装。原生未决任务持续保留以便打开工作台诊断，仍阻止更新；缺失或损坏账本、未完成事务、陌生listener、非active已有服务则拒绝自动恢复。只有端口确实空闲、确切owner且再次验签才启动，不根据保存PID领养。

## 首次引导顺序

1. 仅使用正式签名且startupProtocol=1的arm64包。历史v1.0.4可只读验签/暂存，不能启动、bootstrap或作回滚基线，不覆盖历史资产。
2. `node scripts/bootstrap-stable-updater.mjs --prepare verified-UUID 1.0.5` 仅复核和准备独立runtime，不安装job或切换服务。
3. 再次取得当前维护确认；用户保存并确认任务全部结束，退出所有浏览器。确认后正常停止精确旧服务，不强杀未知进程。
4. 执行 `--bootstrap verified-UUID 1.0.5`，原生TTY须新输入“确认首次接管”。自动安装设置必须关闭，避免daemon与首次installer争用。完整离线data/Chrome备份成功后才部署；原profile、Origin5174、配置和生成文件不迁移、不清空。
5. 已存在的账本/锁/未知记录不重新seed、不清除；缺账本只允许首次明确维护边界初始化。新旧版本全部重新验签，jobs核对固定程序/参数/目录。
6. 原Chrome读回画布、历史、配置及媒体，真实代理/helper兼容、健康和Origin核对成功后才完成生产接管验收。自动安装后续可由用户开启，每次仍需单独确认。
7. 应用升级后的本机manager升级使用 `--upgrade-manager`：仅当前确切签名版本、已完成且仍有效的本次确认、浏览器退出、原生revision不变和owned服务证明；不接受任意目标路径。不修改supervisor或私人数据。

卸载不删除业务数据：关闭自动安装，完成新的维护确认，正常停止确切应用及两个属于本项目的job；只移除核实属于本项目的LaunchAgent plist。版本/数据/Chrome/Keychain与备份保留。不要按宽泛目录或标签通配删除。

## 验证与当前未完成项

真实用户态随机QA双job、独立Node、实际项目后端、随机测试签名，已经验证首次bootstrap、正常升级、启动失败自动回滚及manager升级后应用PID不变。闭浏览器与首次备份确认在该整链测试中为显式QA夹具，不冒充生产census/用户数据证明。单独备份回归真实复制及验hash，但不是原Chrome生产备份。

Playwright独立profile、临时Origin、真实构建UI/HTTP/Unix/验签/authority已验证开关不自动授权、下载中按钮禁用、取消不授权、确认后等待浏览器退出、稍后持久暂缓；GitHub/Keychain/owned服务为夹具，payload不执行。既有两个logo404不声称已消失。

最终批量结果以 `output/phase5/latest-verification.json` 为准。正式v1.0.5签名/私有下载、新的当前维护确认/完整备份、原Chrome读回和真实代理/helper生产接管尚未完成。实体两Mac属阶段6；物理断电测试没有用进程退出夹具冒充。
