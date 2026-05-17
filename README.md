# CommandCabin

CommandCabin 是一款轻量化的电脑快捷命令台。它把常用应用、文件、文件夹、网址、剪贴板、文本处理和插件命令集中到一个快速唤起的桌面入口里，让你用键盘完成查找、执行和切换。

[English README](README.en.md)

## 产品定位

CommandCabin 面向日常桌面效率场景，强调轻、快、本地优先：

- 轻量化：聚焦快捷启动和命令执行，不把桌面工作流做得臃肿。
- 快捷命令台：通过全局热键呼出，一个输入框完成搜索、选择和执行。
- 本地优先：应用索引、收藏、历史记录和设置优先保存在本机。
- 插件优先：核心能力保持简洁，更多场景通过内置或本地插件扩展。
- Windows 优先：当前版本优先打磨 Windows 桌面体验。

## 核心能力

- 全局快捷键唤起启动器。
- 搜索应用、收藏文件、文件夹和网址。
- 统一的命令注册、搜索排序和执行流程。
- 本地设置、命令历史和剪贴板历史存储。
- 内置计算器、剪贴板历史、文本工具和快捷换算能力。
- 本地插件运行时和插件页面承载能力。

## 技术栈

- Electron
- TypeScript
- React
- Vite
- SQLite
- Fuse.js
- Vitest
- electron-builder

## 开发

安装依赖：

```powershell
corepack pnpm install
```

启动桌面应用：

```powershell
corepack pnpm dev
```

常用检查：

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format
```

构建：

```powershell
corepack pnpm build
```

## 当前状态

项目处于开发阶段，Windows 端 MVP 正在持续完善。更详细的设计和验证记录可查看：

- `docs/superpowers/specs/`
- `docs/product/beta-release-checklist.md`
