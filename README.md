# CommandCabin

<p align="center">
  <img src="./apps/desktop/build/brand/command-cabin-icon-256.png" width="92" alt="CommandCabin logo" />
</p>

<h1 align="center">CommandCabin</h1>

<p align="center">
  <strong>Windows 优先的本地桌面快捷命令台。</strong>
  <br />
  用一个输入框快速唤起应用、执行命令、处理文本、访问插件能力。
</p>

<p align="center">
  <a href="./README.en.md">English README</a>
  ·
  <a href="#功能亮点">功能亮点</a>
  ·
  <a href="#快速开始">快速开始</a>
  ·
  <a href="#开发">开发</a>
  ·
  <a href="#版本策略">版本策略</a>
</p>

<p align="center">
  <img src="./docs/assets/screenshots/launcher-home.png" alt="CommandCabin launcher home screenshot" width="920" />
</p>

## 项目定位

CommandCabin 是一款轻量化桌面效率工具，目标是把常用应用、文件、文件夹、网址、剪贴板、文本处理和插件命令集中到一个快速唤起的入口里。它更像一个安静、可靠、反应灵敏的桌面控制台，而不是一个复杂的工作流平台。

设计原则：

- 本地优先：设置、历史、收藏和索引数据优先保存在本机。
- 键盘友好：全局快捷键唤起，输入、方向键选择、回车执行。
- Windows 优先：当前阶段集中打磨 Windows 桌面体验、快捷方式解析、系统托盘和安装流程。
- 插件扩展：核心保持克制，更多场景通过内置命令和本地插件扩展。
- 体验优先：启动、搜索、图标展示、语言、主题和窗口行为都按真实桌面使用场景打磨。

## 功能亮点

| 能力         | 说明                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| 快速唤起     | 默认 `Alt+Space` 呼出启动器，快捷键可在设置中修改。                             |
| 应用搜索     | 扫描 Windows 开始菜单、桌面快捷方式和常见安装位置，支持模糊搜索与排序。         |
| 首页入口     | 首页优先展示常用应用，并提供单位换算、截图等常用工具入口。                      |
| 固定应用管理 | 支持手动添加应用，固定项可右键编辑或移除。                                      |
| 图标解析     | 优先解析真实可执行文件图标，并对快捷方式、AppUserModelID 和图标缓存做兜底处理。 |
| 快捷换算     | 输入长度、重量、货币等表达式时显示结果；单位换算页支持重量和长度双向换算。      |
| 系统托盘     | 关闭窗口后可隐藏到系统托盘继续运行，托盘菜单跟随界面语言。                      |
| 开机自启动   | 可在设置中开启或关闭登录后自动启动，并支持启动时收纳到托盘。                    |
| 截图工具     | 支持全局快捷键截图、延时截图、矩形选区、标注、马赛克、文字、OCR、贴图和保存。   |
| 版本与更新   | 可在设置中查看当前版本，基于 GitHub Releases 检查、下载并手动确认安装更新。     |
| 多语言       | 支持简体中文、繁体中文、英文，默认简体中文。                                    |
| 主题         | 支持浅色、深色和跟随系统主题。                                                  |
| 插件运行时   | 内置插件能力与本地插件安装入口，插件命令统一进入搜索和执行流程。                |

## 快速开始

### 安装使用

当前 Windows 安装包由 `electron-builder` 生成，默认面向 64 位系统：

- 最新安装包可在 [GitHub Releases](https://github.com/RupingLiu/command-cabin/releases) 下载。
- 默认安装目录：`C:\Program Files\command-cabin`
- 安装时可选择安装路径。
- 如果检测到旧版本，安装流程会先处理旧版本再继续安装。
- 安装后可通过桌面图标、开始菜单或全局快捷键打开 CommandCabin。

启动后可以：

1. 按 `Alt+Space` 呼出启动器。
2. 输入应用、命令、换算内容或插件命令。
3. 用方向键移动选中项，按 `Enter` 执行。
4. 点击右上角齿轮进入设置，配置主题、语言、快捷键、开机自启动和版本更新。

### 常用操作

| 操作         | 方式                             |
| ------------ | -------------------------------- |
| 打开启动器   | 默认 `Alt+Space`                 |
| 执行选中命令 | `Enter`                          |
| 移动选中项   | `Up` / `Down` / `Left` / `Right` |
| 清空搜索     | 输入框右侧清空按钮               |
| 添加固定应用 | 首页“添加应用”入口               |
| 管理固定应用 | 右键固定应用卡片                 |
| 单位换算     | 首页“单位换算”入口               |
| 截图         | 默认 `Ctrl+Alt+A`                |
| 延时截图     | 可在设置中自定义                 |
| 隐藏到托盘   | 关闭窗口或通过托盘菜单控制       |

## 项目结构

```text
command-cabin/
├─ apps/
│  └─ desktop/                 Electron 主应用、预加载脚本和 React 渲染端
├─ packages/
│  ├─ core/                    命令模型、搜索排序、设置、存储、索引和插件运行时
│  ├─ plugin-api/              对外插件类型定义
│  └─ built-in-plugins/        内置命令提供方
├─ tests/
│  └─ unit/                    跨包单元测试和打包烟测
├─ docs/
│  ├─ product/                 产品策略、版本策略和发布检查清单
│  └─ assets/screenshots/      README 和文档使用的截图资源
└─ release/                    本地打包产物
```

## 技术栈

| 层级   | 技术                             |
| ------ | -------------------------------- |
| 桌面壳 | Electron                         |
| 渲染端 | React, Vite                      |
| 语言   | TypeScript, ESM, NodeNext        |
| 搜索   | Fuse.js 与 CommandCabin 排序增强 |
| 存储   | SQLite                           |
| 测试   | Vitest                           |
| 打包   | electron-builder                 |
| 包管理 | pnpm workspace                   |

## 开发

所有命令都建议在仓库根目录执行，并使用 `corepack pnpm`。

安装依赖：

```powershell
corepack pnpm install
```

启动桌面应用：

```powershell
corepack pnpm dev
```

构建所有包：

```powershell
corepack pnpm build
```

常用质量检查：

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format
```

生成 Windows 安装包：

```powershell
corepack pnpm --filter @command-cabin/desktop dist:win
```

只打包桌面应用目录：

```powershell
corepack pnpm --filter @command-cabin/desktop package:dir
```

## 开发约定

- 仓库使用 TypeScript 项目引用和 ESM 模块。
- 相对 TypeScript 导入保持 `.js` 后缀。
- 非 Electron 业务逻辑优先放在 `packages/core`。
- 渲染端通过 `window.desktopApi` 调用主进程能力，不直接使用 Electron API。
- IPC 边界需要做输入校验，拒绝未知或不合法数据。
- 存储迁移位于 `packages/core/src/storage/migrations.ts`，已应用的迁移 ID 视为追加不可改。
- 触及 IPC、持久化、插件运行时、打包或共享核心契约时，需要配套更充分的测试。

## 版本策略

CommandCabin 使用严格的 `x.y.z` 版本号：

| 段位 | 含义                                                                 |
| ---- | -------------------------------------------------------------------- |
| `x`  | 重大架构变更，或产品方向上的破坏性调整。                             |
| `y`  | 用户可见的功能新增，例如新的导入方式、分析能力、报告能力或界面功能。 |
| `z`  | Bug 修复、协议规则修正、文案或体验优化、测试补强等不新增功能的改动。 |

详细规则见 [docs/product/versioning-policy.md](./docs/product/versioning-policy.md)。

## 当前状态

项目处于 Windows 桌面 MVP 持续完善阶段。当前重点包括：

- 应用索引和图标解析的稳定性。
- 启动器交互速度和键盘导航体验。
- 设置项、语言、主题和托盘行为的一致性。
- 插件运行时、安全边界和插件管理体验。
- 安装、升级、卸载、自动更新和发布流程。

更多设计和验证记录可查看：

- [docs/product/beta-release-checklist.md](./docs/product/beta-release-checklist.md)
- [docs/superpowers/specs](./docs/superpowers/specs)

## 许可证

本项目基于 MIT 许可证开源。详见 [LICENSE](./LICENSE)。
