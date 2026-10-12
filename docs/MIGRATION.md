# 发布版本与电脑迁移

## 新电脑启动

1. 安装 Node.js 18.17 或更新版本（可使用 Node.js 22 或更新版本）。
2. 完整解压发布 ZIP 到任意可写目录。不要直接在压缩包内启动。
3. macOS：双击 `scripts/start.command`；Windows：双击 `scripts/start.bat`；Linux：执行 `sh scripts/start.sh`。
4. 浏览器打开 `http://127.0.0.1:5174/`。终端必须保持开启；关闭终端停止服务。

也可在项目目录执行 `node scripts/start-portable.mjs` 或 `npm start`。
发布包包含当前已上线页面及纯 JavaScript 运行依赖，不需要重新构建画布。
若运行依赖被删除，启动器会通过 `npm ci --omit=dev --ignore-scripts` 安装，需要网络。
端口默认 5174；被其他程序占用时先关闭该程序。迁移旧浏览器数据时建议保持该端口。

## 迁移你的画布、图片、Excel 与配置

项目 ZIP **不是浏览器数据备份**。旧电脑的浏览器 localStorage / IndexedDB
不会因复制项目文件自动迁移，也不能通过直接复制此 ZIP 恢复。

迁移前，在旧工作台中：

- 在每个画布的项目菜单中使用导出功能，保留包含图片资源的 ZIP；也可使用设置中的 WebDAV 同步迁移画布和资产。“本地存储”页签目前仅展示存储统计，不提供全量备份按钮。
- 在设置面板导出配置 JSON，供新电脑导入渠道与相关设置。
- 原始 Excel 文件也单独复制一份。新电脑如未恢复工作簿数据，可重新上传。
- 在新电脑启动后，先导入配置、重新上传 Excel，再使用画布导入或 WebDAV 恢复，核对每个产品画布、图片及渠道。画布导出不等于完整生成历史、Excel 工作簿及所有浏览器状态的备份。

普通配置导出不包含 API Key、WebDAV 密码、本机 `guan-vault:` 引用、安全代理路径或自定义请求脚本；新电脑导入后需在本机重新填写并授权凭据。画布导出、WebDAV 同步和浏览器存储仍可能包含业务数据，按私人数据处理。
发布包不包含个人配置、私人代理节点、日志、浏览器测试数据或 Git 历史。
它也不包含你的 Node.js 安装或浏览器软件。

## 网络代理

发布包内的 `config/examples/default-proxy.yaml` 是空白直连模板，没有私人节点。
在新电脑的“代理设置”中重新导入自己的代理配置或订阅。
macOS / Linux 的内置代理支持自动寻找或下载 Mihomo；首次下载需要可访问 GitHub。
Windows 当前不支持内置 Mihomo 自动下载，请安装外部代理并设置本地代理地址，
或使用直连。Windows 启动脚本已提供，但本发布只在 macOS 上完成运行验证。

## 软件升级与私人数据隔离

macOS 私人文件位于 `~/Library/Application Support/GuanAIWorkbench/`：
`data/config/runtime.env`、`data/proxy/profile.yaml`、`data/proxy/state.json`、
`data/runtime/image-relay-transports.json`，以及 runtime 中的原生辅助程序、日志、备份和更新暂存。
目录使用 0700、敏感文件使用 0600。旧配置只在对应文件不存在时复制一次；
原文件保留，已有私人配置不会被新版模板覆盖。

`runtime.env` 是初始化后的唯一持久环境配置来源；从中移除的设置不会被旧
`.env.local` 再次补回。启动进程显式传入的环境变量仍优先。

更新代码不迁移浏览器数据库、不清空 localStorage、不改变访问 Origin。
请始终使用 `http://127.0.0.1:5174`，不能把 localhost、另一端口当成相同存储。
Mac A / Mac B 各自保存私人目录和各自浏览器数据，不通过软件包互相同步；
WebDAV 数据同步仍是用户明确选择的独立功能，不是代码升级的一部分。

旧 API/Agent/WebDAV 浏览器凭据路径继续保留以保障兼容；Mac A 已迁移的 OpenAI 配置用本机引用。v1.0.7 新的内置渠道保存、模型列表获取、配置导入、WebDAV 保存和 Agent 连接使用后端 Keychain 写入并验证读回，成功后才持久化引用。WebDAV 编辑完成后点击“保存 WebDAV 配置”，测试/同步使用已保存值。
未配置服务的真实远端验证、自定义脚本和任意插件兼容仍有边界；Agent 上游 query-token 协议仍有服务器 URL 日志风险。新输入与自定义脚本组合明确拒绝保存，已有配置不会自动删除。
本机 `guan-vault:` 引用和 `/local-secure-api/` endpoint 不可用普通配置导入
移到另一台电脑；新电脑须独立授权。安全迁移准备接口不会自动改用户配置。
Mac A 已接管签名 v1.0.6。自动安装偏好当前关闭；启用后每版本仍需保存/任务结束确认与工作台页面关闭。Mac B 独立接入和验收见 `Mac-B-更新验收.md`。

## 发布信息与开发

版本、构建时间与文件校验值见 `RELEASE.json` 和压缩包旁的 `.sha256` 文件。
该包包含源码和许可证材料；依赖的许可证保留在 `node_modules` 内。
画布开发依赖未打包，开发者先执行 `npm --prefix src/canvas ci`。
根目录 `npm test` 的尺寸测试依赖画布 TypeScript 开发依赖，需上述安装后运行。
不要仅凭有发布包就公开分发：对外发布前需核对原站页面与媒体的授权。
