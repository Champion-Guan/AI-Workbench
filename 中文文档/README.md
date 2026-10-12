# Guan AI 工作台中文说明

## 项目用途

Guan AI 工作台是运行在本机的 AI 图片、视频和无限画布工作台。项目代码与每台电脑的个人配置、浏览器数据、代理配置、生成文件和同步凭据分开保存。

## 稳定版更新

稳定版发布在私有仓库 `Champion-Guan/guan-ai-workbench`。客户端只读取正式 Stable Release，并通过内置 Ed25519 公钥和 SHA-256 清单验证下载文件。

更新前需要保存画布，确认生成任务、Agent 和 WebDAV 同步已结束，并关闭所有工作台页面。浏览器中的其他网站以及其他应用可以继续运行。页面检查失败、任务状态未知、保存失败或签名验证失败时，安装会停止并保留当前版本。

## 个人数据

个人运行数据位于 macOS 的 `~/Library/Application Support/GuanAIWorkbench/`。更新过程不会把个人 API Key、代理节点、WebDAV 凭据、画布、图片、视频或浏览器 Origin 写入代码包，也不会用默认配置覆盖已有数据。

## 文件命名约定

产品界面和说明优先使用中文。Node.js、React、Vite、GitHub API、Apple Silicon、Stable、Keychain 等协议名称、依赖目录和脚本入口保留官方写法，以保证构建、签名、启动和升级兼容。
