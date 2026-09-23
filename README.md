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
