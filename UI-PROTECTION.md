# UI 保护约定

当前工作台的样式、布局、主题反色、交互动画和弹窗层级以
`restore/ui-baseline-style-animation-20260924` 为保护基准。

除非用户明确提出视觉或交互修改，后续开发必须遵守以下规则：

1. 新功能使用独立的命名空间。已有 `local-*` 类名、`data-local-*` 属性、
   工作台布局选择器、主题选择器和动画名称不得复用或覆盖。
2. 新增 CSS 放在独立文件或独立的功能区块中，避免修改现有规则的选择器、
   变量、层级、`z-index`、`transition` 和 `animation`。
3. 新增脚本只能挂载自己的 DOM 节点和事件，不得改变现有按钮、侧边栏、
   设置面板、画布、主题切换和弹窗的行为。
4. 每次改动前先创建回退标签：

   ```bash
   git tag -a restore/pre-<简短描述>-$(date +%Y%m%d) \
     -m "Before <简短描述>"
   ```

5. 改动完成并验证后再创建对应的 `restore/post-*` 标签。若改动不是用户
   明确要求的 UI 变化，应确认受保护文件相对于基准没有非预期差异：

   ```bash
   git diff -- server.mjs \
     playground-settings/src/settings.css \
     playground-settings/src/components \
     playground-settings/dist/assets/index.css \
     playground-settings/dist/assets/index.js
   ```

6. 如果用户明确要求修改现有 UI，先保留当前回退标签，再在新标签上继续；
   不要覆盖或删除已有 `restore/*` 标签。

## 受保护范围

- `server.mjs` 中的工作台布局、侧边栏、设置按钮、生成按钮、主题反色、
  弹窗层级和动画规则。
- `playground-settings/src/settings.css` 及设置组件中的现有交互。
- `playground-settings/dist/assets/index.css` 和 `index.js` 中已构建的设置面板。
- `archive/` 中的本地页面和媒体资源路径。

本文件只记录开发约定，不会被运行时加载，也不会改变页面显示。
