## 更新内容

- 全面更新启动器视觉风格，改为更柔和、轻量的健康感界面。
- 完善浅色与深色主题下的配色、背景、卡片、按钮和选中状态。
- 统一设置页、单位换算、插件宿主、添加应用、固定截图窗口等次级页面的视觉语言。
- 更新截图工具栏、OCR 面板、状态提示、完成/取消按钮和移动端横向滚动体验。
- 修复固定截图关闭按钮 hover/focus 状态仍使用旧硬编码颜色的问题。

## 验证

- 已通过 `corepack pnpm test`
- 已通过 `corepack pnpm typecheck`
- 已通过 `corepack pnpm lint`
- 已通过 `corepack pnpm build`
- 已通过 `corepack pnpm --filter @command-cabin/desktop package:dir`
- 已通过 `corepack pnpm --filter @command-cabin/desktop dist:win`
- 已生成 Windows x64 安装包、blockmap 和自动更新清单
