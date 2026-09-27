# Guan A+ 详情页工作台

这是一个完全本地的单页面静态工作台，只保留 A+/详情页功能。

启动：

```bash
npm run dev
```

默认地址：[http://127.0.0.1:5174](http://127.0.0.1:5174)

项目没有页面别名或其他工具路由。唯一入口是根路径；内部静态资源仅供该页面加载。历史版本和完整备份不放在当前项目运行路径中。

目录已经扁平化为：

- `archive/index.html`：唯一页面
- `archive/assets/_next/static`：页面运行所需的脚本、样式和字体
- `archive/assets/media`：详情页预览图片
- `archive/assets/local-brand`：本地 logo 与 favicon

## UI 保护

当前已确认的样式、动画和布局基准为：
`restore/ui-baseline-style-animation-20260924`。

后续改动前请先创建 `restore/pre-*` 回退标签，并遵守
[UI-PROTECTION.md](UI-PROTECTION.md) 中的命名空间和隔离约定。

## 图片请求的内置代理

图片请求首次始终先直连服务商；直连遇到区域策略拒绝、代理拒绝或网络连接失败时，才会重试项目管理的本地 Mihomo 代理。某个服务商一旦通过代理成功，当前服务运行期间后续请求会优先走代理；代理失效时会重新探测直连。节点内容只在运行时写入系统临时目录，不会写入仓库、日志或备份。

没有检测到代理来源时，首次打开网页会出现代理配置窗口，可上传 Clash/Mihomo 配置或填写订阅地址。点击“稍后配置”仍可使用直连；配置成功后窗口不再重复出现。上传内容仅用于启动当前进程，服务关闭时会删除临时配置。

项目本身不把平台相关的 Mihomo 二进制提交到 GitHub。启动时如果找不到本地二进制，会按当前系统和 CPU 架构从 Mihomo 官方 Release 自动下载到用户缓存目录；也可以将二进制放到 `proxy-runtime/mihomo`，或通过 `IMAGE_RELAY_MIHOMO_BIN` 指定路径。然后从环境变量提供节点来源：

```bash
# 方案一：使用远程订阅地址（推荐，不把节点写进仓库）
IMAGE_RELAY_MIHOMO_BIN=/path/to/mihomo \
IMAGE_RELAY_SUBSCRIPTION_URL='https://your-subscription.example/...' \
npm run dev

# 方案二：继续使用本机 Sub-Store 的某个订阅
IMAGE_RELAY_MIHOMO_BIN=/path/to/mihomo \
IMAGE_RELAY_SUBSTORE_API_URL='http://127.0.0.1:38324' \
IMAGE_RELAY_SUBSCRIPTION_NAME='AWS-SS-6' \
npm run dev

# 方案三：使用本地完整 Clash/Mihomo 配置文件
IMAGE_RELAY_MIHOMO_BIN=/path/to/mihomo \
IMAGE_RELAY_MIHOMO_CONFIG_FILE=/path/to/private-config.yaml \
npm run dev
```

代理监听端口默认为 `17890`，可用 `IMAGE_RELAY_PROXY_PORT` 修改。若设置了 `IMAGE_RELAY_PROXY_URL`，项目会使用该代理；未设置且没有内置代理配置时，会兼容使用本机 `127.0.0.1:7890`，但不会依赖 Clash Party 才能运行。

自动下载可用 `IMAGE_RELAY_MIHOMO_AUTO_DOWNLOAD=false` 关闭，也可用 `IMAGE_RELAY_MIHOMO_VERSION` 固定 Mihomo 版本。节点订阅和完整配置只通过环境变量或外部私有文件提供，`.env.local` 已被 Git 忽略。

最简单的迁移方式是复制 `.env.local.example` 为 `.env.local`，填入新电脑可访问的私有订阅地址或本机 Sub-Store 配置，再执行 `npm install && npm run dev`。项目会自动读取 `.env.local`，不需要修改源码。

设置中的“价格与余额”现在用于本地计费记录：图片成功返回后按实际返回张数扣减余额；余额不足一张时会提示、停用该配置，并在 Fallback 顺序中自动跳过。价格或余额留空则不参与扣减。
