# v1.0.4 正式签名发布验收

2026-10-11，Asia/Shanghai。用户单独批准发布v1.0.4，本记录仅验收发布/可信下载链，不是安装许可或跨设备自动更新完成声明。

## 已通过

- 私有仓库：`MrGuAm/guan-ai-workbench`；Release ID409090166，v1.0.4为正式非Draft、非Prerelease且latest。发布时间本地2026-10-11 01:17:17。
- 固定源码/tag提交：`b27006fb8f49cd0e780cd525dd4088f16efc43b4`，不是个人迁移包。
- [正式发布Actions38070685727](https://github.com/MrGuAm/guan-ai-workbench/actions/runs/38070685727)的质量、arm64、x64、签名发布四个job全部成功。两个架构各自执行包内Node，完成隔离启动/健康/资源核验。
- 395项本地回归、typecheck/build、Lint0错误（4条既有警告）、源码521/暂存8文件及历史扫描、独立Gitleaks通过；普通Push/tag CI38070669369/38070684493均成功。
- Ed25519公钥固定于源码，keyId为`61d0312290a5ac3688099d26d595e619161fcf34bcc582262c5ab26f1c20be00`。先签名并验证两个包，再上传Draft、核对5项资产GitHub摘要，最后转正式版。
- 使用真实readGitHubStable、StableDownload、readReleaseAsset与verifySignedStable从线上下载两包：私有API/CDN、签名、大小/hash、ZIP安全、精确347文件、版本/提交/架构、Node/helper全部通过。未执行下载代码。实际发布签名篡改、同版本更新、错误仓库测试均拒绝。
- 5项资产为两架构ZIP、guan-stable-manifest.json、guan-stable-manifest.sig和SHA256SUMS.txt；最新Release说明包含自动安装关闭及旧Mac人工引导边界。

| 架构 | ZIP字节数 | SHA-256 |
| --- | ---: | --- |
| arm64 | 45305336 | 990fe125398cb7337a97cc7b83f646dd44b4591ec484e0fd8691229e7bc113da |
| x64 | 46512992 | 16657ed24627cb900d50d7d05bb2e3f1122d2e770d28e46ecb5d2d5c37630aa8 |

## 保护与未完成项

本机线上v1.0.3仍PID10088/buildId40a1b85f6d87f6fbd0ac28d4，Origin127.0.0.1:5174、ready与代理正常；私人profile/transports/state与基线哈希一致。本次没有生产部署、重启、安装或浏览器存储写入。源码及正式签名产物备份保留，私钥不在Git/Release。

真实下载联调临时使用已有gh CLI认证，仅内存处理，未新建更新Keychain授权；不能冒充每台Mac独立最小只读权限已验证，也不能冒充生产更新UI已启用。Mac B首次引导、独立更新认证及两实体Mac需后续实测。

签名是发布清单Ed25519，不是Apple代码签名/notarization；Gatekeeper/Keychain辅助程序升级兼容未验收。独立launchd更新器、可信全窗口/任务排空、安装/服务重启/健康检查/回滚属于阶段5；阶段6跨Mac未完成。automaticInstallAllowed=false保持。

私钥本机加密备份和Keychain不是离线灾备；恢复口令安全离线保管仍待安排。现有包不能直接覆盖旧个人迁移目录或浏览器数据，不因GitHub正式发布而自动安装。
