# 双架构原生构建验收（不签名、不发布、不安装）

2026-10-11 最新授权：用户已批准单人发布，审批规则以 `STABLE-UPDATES-SINGLE-OWNER.md` 为准；下文原独立审核人阻断为历史。运行38068850021的双架构构建、原生启动和下载后只读完整性核验已通过，不等于正式签名发布验收。

日期：2026-10-11，Asia/Shanghai。此流程补齐真实 Apple Silicon 与 Intel 稳定包构造/启动证据，不是正式 Stable Release。

## 流程与边界

`.github/workflows/stable-build-qa.yml` 仅 workflow_dispatch，默认分支输入 BUILD-ONLY；先复用普通源码 CI，再于 macos-15/arm64 和 macos-15-intel/x64 执行。每个 job 固定触发时 github.sha，源码必须干净且属于已获取的默认分支，运行平台和实际 process.arch 必须匹配，不创建版本标签。

复用正式流程相同的锁定依赖安装、画布构建、本机 Swift helper 构建、官方 Node checksum 校验、stable:build 与 verify-stable-native。包内 Node 必须在对应原生机器启动隔离服务，通过 PID/version/buildId/Origin、页面资源和更新接口检查。QA 使用临时私人目录和临时端口，禁用真实代理，安装始终 false。

输出是私有 Actions artifacts（7 天保留），标识 stable-build-qa-arm64/x64；没有 Release 清单签名、发布权限、Secret、protected environment 或安装入口。自动更新客户端不读取 Actions artifacts，不能把这些未签名包当作可自动安装版本。每个包虽复用 Stable 结构，但交付必须明确 unsigned QA。

新增源码准入与约束测试包括：干净固定提交、脏源码保留、提交不符、原生架构/平台不符、默认分支不符、预发布版本拒绝、workflow 只读且无签名发布路径。用户数据、浏览器 Origin 和生产服务不参与测试。

## 发布保护外部条件

普通源码 CI 已通过（a4d6c12 / 38068188063），不等于签名发布环境已保护。当前 environments 列表为空，collaborators 仅 MrGuAm；user API 未提供 plan 信息，但 rulesets API 返回 HTTP403，提示私有仓库需升级计划才能启用规则集。

GitHub 官方文档当前说明，Free/Pro/Team 私有仓库不提供环境 required reviewers，私有环境/secret/部署分支可用性也受套餐影响。不能把空环境名称当作受保护环境，不能为了验收改为公开仓库、降低保护或偷偷把私钥放到 repo Secret。

用户明确选择保留原 GitHub 受保护环境方案，并说明只有一个账号。当前“required reviewer + 禁止自审”还缺少支持该私有保护的 GitHub 环境及独立审核人，不自行邀请任何账号、不购买升级、不允许自己审核自己，不创建正式密钥、不发布。若后续选择改变签名托管/审批方式，需用户另行确认，不自动切换到本机签名方案。

参考：[GitHub Reviewing deployments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)、[Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)。

## 验收记录

本地 385 项回归通过，Lint 0 错误/4 条既有警告。真实双架构运行结果以 GitHub Actions 和 output/phase4/native-build-actions-20261011.json 为准；未取到成功结论前，不宣称双架构或阶段4已验收。保护/签名与真实私有下载联调仍不可跳过，阶段5自动安装保持关闭。
