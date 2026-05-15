# CommandCabin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开发 CommandCabin，一款跨平台桌面效率工具，用户通过全局快捷键呼出命令面板，快速搜索应用、文件、命令和插件能力，并支持后续扩展为插件平台。

**Architecture:** 采用 Electron + TypeScript 构建跨平台桌面壳，React 负责启动器、设置页和插件页面容器，主进程提供系统能力、插件运行时、搜索索引和本地存储。第一版以 Windows 优先，抽象系统能力接口，为 macOS 和 Linux 预留实现。

**Tech Stack:** Electron, TypeScript, React, Vite, Zustand, SQLite, better-sqlite3, Fuse.js, Vitest, Playwright, electron-builder, ESLint, Prettier.

---

## 1. 产品定位

这款工具的核心不是“做一个搜索框”，而是做一个桌面命令中心。用户按下全局快捷键后，可以在一个轻量窗口里完成应用启动、文件打开、文本处理、剪贴板检索、系统命令执行和插件功能调用。

第一版目标是做出稳定可用的本地 MVP，验证三个关键体验：

- 呼出足够快：快捷键到窗口可输入状态在 150ms 内完成。
- 搜索足够准：应用、内置命令、插件命令可以统一排序和执行。
- 扩展足够顺：内置插件和第三方插件使用同一套插件协议。

## 2. 目标用户

- 高频使用桌面应用、文件和脚本的知识工作者。
- 开发者、产品经理、设计师、运营等需要快速切换工具的人。
- 愿意通过插件、快捷命令和自动化提升桌面效率的进阶用户。

## 3. MVP 范围

MVP 必须包含：

- 全局快捷键呼出和隐藏主窗口。
- 命令面板搜索 UI。
- 统一命令注册与执行。
- 应用扫描和启动。
- 收藏文件、文件夹和 URL。
- 内置命令：计算器、剪贴板历史、文本处理、系统命令。
- 插件清单解析、插件安装、插件启用/禁用、插件命令注册。
- 设置页：快捷键、主题、插件管理、数据目录、搜索排序。
- 本地数据存储：配置、历史、插件信息、剪贴板记录、索引缓存。
- 基础打包：Windows 安装包。

MVP 不包含：

- 插件市场。
- 账号体系。
- 云同步。
- 团队管理。
- 远程插件审核。
- 复杂 AI Agent 能力。
- 跨设备配置同步。

## 4. 成功指标

- 冷启动到可搜索窗口小于 2s。
- 已启动状态下快捷键呼出到输入可用小于 150ms。
- 搜索 5000 条命令/应用/收藏记录时，结果刷新小于 50ms。
- 插件安装后无需重启即可注册命令。
- 主进程崩溃率低于每 1000 次启动 1 次。
- 10 个高频流程均有端到端测试覆盖。

## 5. 推荐仓库结构

```text
command-cabin/
  package.json
  pnpm-workspace.yaml
  electron-builder.yml
  tsconfig.base.json
  apps/
    desktop/
      package.json
      src/
        main/
          index.ts
          window/
          hotkey/
          ipc/
          tray/
          updater/
        preload/
          index.ts
        renderer/
          index.html
          src/
            app/
            launcher/
            settings/
            plugin-host/
            shared/
  packages/
    core/
      src/
        command/
        search/
        plugin/
        storage/
        indexer/
        permissions/
    plugin-api/
      src/
        index.ts
        types.ts
    built-in-plugins/
      calculator/
      clipboard-history/
      text-tools/
      quick-open/
  tests/
    unit/
    integration/
    e2e/
  docs/
    product/
    developer/
    architecture/
```

## 6. 核心架构

### 6.1 主进程

主进程负责所有系统级能力：

- 应用生命周期。
- 单实例锁。
- 全局快捷键。
- 托盘菜单。
- 主窗口创建、隐藏、置顶和失焦关闭。
- 文件系统访问。
- 应用扫描。
- 插件加载。
- IPC 路由。
- 数据库连接。
- 崩溃日志。
- 自动更新。

主进程不直接渲染 UI，也不承载复杂视图状态。

### 6.2 渲染进程

渲染进程负责所有用户界面：

- 命令面板。
- 搜索结果列表。
- 详情预览区。
- 插件页面容器。
- 设置页。
- 插件管理页。
- 快捷键录制控件。
- 主题切换。

渲染进程只能通过 preload 暴露的白名单 API 调用系统能力。

### 6.3 Core 包

`packages/core` 提供跨进程共享的纯业务逻辑：

- 命令注册表。
- 搜索排序。
- 插件清单校验。
- 权限模型。
- 存储模型。
- 索引数据结构。

Core 包尽量不依赖 Electron，保证可单测。

### 6.4 Plugin API 包

`packages/plugin-api` 暴露给插件开发者：

- 类型定义。
- 插件生命周期。
- 命令注册方法。
- 安全 API 类型。
- 插件上下文对象。

第一版插件 API 只覆盖必要能力，避免过早承诺难以兼容的接口。

## 7. 数据模型

### 7.1 Settings

```json
{
  "hotkey": "Alt+Space",
  "theme": "system",
  "language": "zh-CN",
  "launchAtLogin": false,
  "hideOnBlur": true,
  "search": {
    "maxResults": 20,
    "historyBoost": 1.4,
    "pluginBoost": 1.0,
    "appBoost": 1.2,
    "fileBoost": 0.9
  }
}
```

### 7.2 Command

```ts
type CommandSource = "system" | "app" | "file" | "url" | "plugin";

interface Command {
  id: string;
  source: CommandSource;
  title: string;
  subtitle?: string;
  keywords: string[];
  icon?: string;
  pluginId?: string;
  action: {
    type: "open-app" | "open-path" | "open-url" | "copy-text" | "run-plugin" | "run-system";
    payload: Record<string, unknown>;
  };
}
```

### 7.3 Plugin Manifest

```json
{
  "id": "com.example.text-tools",
  "name": "Text Tools",
  "version": "0.1.0",
  "description": "常用文本转换工具",
  "main": "dist/main.js",
  "ui": "dist/index.html",
  "permissions": ["clipboard.read", "clipboard.write"],
  "commands": [
    {
      "id": "uppercase",
      "title": "转换为大写",
      "keywords": ["uppercase", "大写", "文本"]
    }
  ]
}
```

## 8. 插件安全策略

第一版插件分为两类：

- 内置插件：随应用发布，拥有受控的本地能力。
- 本地开发插件：用户手动安装，默认只允许白名单 API。

安全规则：

- 渲染进程关闭 `nodeIntegration`。
- 开启 `contextIsolation`。
- 插件不能直接访问 Electron 主进程。
- 插件通过 `pluginContext` 请求能力。
- 所有敏感 API 必须声明权限。
- 第一次启用插件时展示权限说明。
- 插件数据按 `pluginId` 隔离存储。
- 插件异常不能导致主应用退出。

第一版不承诺支持未审核远程插件市场，因此不用做复杂审核链路。

## 9. 搜索与排序策略

搜索数据源：

- 系统命令。
- 应用索引。
- 用户收藏。
- 历史记录。
- 插件命令。
- 剪贴板历史。

排序分数：

```text
finalScore =
  fuzzyScore * sourceWeight
  + historyBoost
  + exactMatchBoost
  + recentUsedBoost
  + pinnedBoost
```

排序规则：

- 完全匹配标题优先。
- 最近使用优先。
- 用户固定命令优先。
- 应用和系统命令优先于低频文件结果。
- 插件可声明默认权重，但不能超过系统上限。

## 10. 里程碑计划

### Milestone 0: 项目初始化，1-2 天

交付物：

- Monorepo 初始化。
- Electron + React + TypeScript 可运行。
- 基础 lint、format、test 脚本。
- Windows 本地开发命令。

验收标准：

- 运行 `pnpm dev` 能打开桌面窗口。
- 运行 `pnpm test` 能执行至少一个单元测试。
- 运行 `pnpm lint` 无错误。

### Milestone 1: 桌面壳与快捷键，3-5 天

交付物：

- 单实例启动。
- 全局快捷键。
- 主窗口居中呼出。
- 失焦隐藏。
- 托盘菜单。
- 基础设置持久化。

验收标准：

- 按 `Alt+Space` 可以呼出窗口。
- 再次按快捷键可以隐藏窗口。
- 失焦时窗口按设置决定是否隐藏。
- 退出托盘菜单可以关闭应用。

### Milestone 2: 命令面板 UI，5-7 天

交付物：

- 搜索输入框。
- 结果列表。
- 键盘上下选择。
- 回车执行。
- 空状态。
- 错误状态。
- 加载状态。
- 主题基础变量。

验收标准：

- 输入关键词后实时显示结果。
- 键盘可以完整操作，不依赖鼠标。
- 执行命令后窗口隐藏并记录历史。

### Milestone 3: 命令系统和搜索核心，1 周

交付物：

- Command Registry。
- Command Executor。
- Fuse.js 模糊搜索。
- 历史权重。
- 收藏权重。
- 搜索性能测试。

验收标准：

- 5000 条命令搜索耗时小于 50ms。
- 命令来源可扩展。
- 执行失败时 UI 有明确提示。

### Milestone 4: 本地索引，1-2 周

交付物：

- Windows 应用扫描。
- 用户收藏路径。
- URL 收藏。
- 索引刷新。
- 索引缓存。

验收标准：

- 能搜索并启动常见 Windows 应用。
- 能收藏文件、文件夹和 URL。
- 应用重启后索引仍可用。

### Milestone 5: 插件运行时，2 周

交付物：

- 插件目录结构。
- Manifest 校验。
- 插件安装。
- 插件启用/禁用。
- 插件命令注册。
- 插件页面加载。
- 插件日志。
- 插件异常隔离。

验收标准：

- 安装一个本地插件后能立即搜索到它的命令。
- 禁用插件后命令消失。
- 插件抛错不会导致主应用崩溃。

### Milestone 6: 内置插件，2 周

交付物：

- 计算器。
- 剪贴板历史。
- 文本转换。
- 快速打开。
- 系统命令。

验收标准：

- 每个内置插件都通过插件 API 注册命令。
- 插件 API 能覆盖真实使用场景。
- 每个插件都有独立配置和测试。

### Milestone 7: 设置与插件管理，1 周

交付物：

- 设置首页。
- 快捷键设置。
- 主题设置。
- 插件列表。
- 插件详情。
- 权限展示。
- 数据目录入口。

验收标准：

- 用户可以修改快捷键并立即生效。
- 用户可以启用、禁用、卸载本地插件。
- 设置修改后应用重启仍保留。

### Milestone 8: 打包、更新与 Beta，1-2 周

交付物：

- Windows 安装包。
- 自动更新基础链路。
- 崩溃日志。
- 性能埋点。
- 用户反馈入口。
- Beta 发布说明。

验收标准：

- 干净 Windows 环境可安装运行。
- 卸载后不残留运行进程。
- 崩溃日志可定位到主进程或渲染进程。

## 11. 详细任务拆分

### Task 1: 初始化 Monorepo

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `apps/desktop/package.json`
- Create: `packages/core/package.json`
- Create: `packages/plugin-api/package.json`

- [ ] Step 1: 初始化 pnpm workspace。
- [ ] Step 2: 配置 TypeScript project references。
- [ ] Step 3: 配置 ESLint、Prettier、Vitest。
- [ ] Step 4: 添加根命令：`dev`、`build`、`test`、`lint`、`format`。
- [ ] Step 5: 提交初始化代码，提交信息使用 `chore: initialize desktop launcher workspace`。

### Task 2: 搭建 Electron 桌面壳

**Files:**

- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/window/createMainWindow.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/src/app/App.tsx`

- [ ] Step 1: 创建 BrowserWindow，设置 `show: false`、`frame: false`、`alwaysOnTop: true`。
- [ ] Step 2: 关闭 `nodeIntegration`，开启 `contextIsolation`。
- [ ] Step 3: preload 暴露 `window.desktopApi`。
- [ ] Step 4: 渲染进程显示基础启动器界面。
- [ ] Step 5: 验证 `pnpm dev` 可以打开窗口。

### Task 3: 全局快捷键和窗口行为

**Files:**

- Create: `apps/desktop/src/main/hotkey/registerGlobalHotkey.ts`
- Create: `apps/desktop/src/main/window/windowVisibility.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Create: `packages/core/src/storage/settings.ts`

- [ ] Step 1: 默认注册 `Alt+Space`。
- [ ] Step 2: 实现呼出时居中、聚焦输入框。
- [ ] Step 3: 实现再次触发快捷键隐藏。
- [ ] Step 4: 实现失焦隐藏开关。
- [ ] Step 5: 添加快捷键冲突提示。

### Task 4: 本地存储

**Files:**

- Create: `packages/core/src/storage/database.ts`
- Create: `packages/core/src/storage/migrations.ts`
- Create: `packages/core/src/storage/settingsRepository.ts`
- Create: `packages/core/src/storage/historyRepository.ts`
- Create: `packages/core/src/storage/pluginRepository.ts`

- [ ] Step 1: 使用 SQLite 保存配置和历史。
- [ ] Step 2: 创建 migrations 表。
- [ ] Step 3: 创建 settings、command_history、plugins、plugin_data 表。
- [ ] Step 4: 添加 repository 单元测试。
- [ ] Step 5: 验证应用重启后设置保留。

### Task 5: 命令注册表

**Files:**

- Create: `packages/core/src/command/types.ts`
- Create: `packages/core/src/command/commandRegistry.ts`
- Create: `packages/core/src/command/commandExecutor.ts`
- Create: `tests/unit/commandRegistry.test.ts`
- Create: `tests/unit/commandExecutor.test.ts`

- [ ] Step 1: 定义 Command 类型。
- [ ] Step 2: 实现注册、注销、按来源清理。
- [ ] Step 3: 实现命令执行分发。
- [ ] Step 4: 添加重复 ID 检测。
- [ ] Step 5: 添加执行失败结果类型。

### Task 6: 搜索核心

**Files:**

- Create: `packages/core/src/search/searchEngine.ts`
- Create: `packages/core/src/search/ranking.ts`
- Create: `packages/core/src/search/tokenize.ts`
- Create: `tests/unit/searchEngine.test.ts`
- Create: `tests/unit/ranking.test.ts`

- [ ] Step 1: 接入 Fuse.js。
- [ ] Step 2: 标题、关键词、副标题分配不同权重。
- [ ] Step 3: 加入历史、置顶、最近使用加权。
- [ ] Step 4: 添加 5000 条数据性能测试。
- [ ] Step 5: 搜索结果返回可解释的 `matchedBy` 字段，便于调试排序。

### Task 7: Launcher UI

**Files:**

- Create: `apps/desktop/src/renderer/src/launcher/LauncherPage.tsx`
- Create: `apps/desktop/src/renderer/src/launcher/SearchInput.tsx`
- Create: `apps/desktop/src/renderer/src/launcher/ResultList.tsx`
- Create: `apps/desktop/src/renderer/src/launcher/ResultItem.tsx`
- Create: `apps/desktop/src/renderer/src/launcher/useLauncherController.ts`

- [ ] Step 1: 输入框自动聚焦。
- [ ] Step 2: 输入时调用搜索 API。
- [ ] Step 3: 上下键切换选中项。
- [ ] Step 4: 回车执行选中命令。
- [ ] Step 5: Escape 隐藏窗口。
- [ ] Step 6: 展示空状态、加载状态和错误状态。

### Task 8: Windows 应用索引

**Files:**

- Create: `packages/core/src/indexer/appIndexer.ts`
- Create: `packages/core/src/indexer/windows/startMenuScanner.ts`
- Create: `packages/core/src/indexer/indexCache.ts`
- Create: `tests/unit/startMenuScanner.test.ts`

- [ ] Step 1: 扫描开始菜单目录。
- [ ] Step 2: 解析 `.lnk` 快捷方式。
- [ ] Step 3: 生成应用命令。
- [ ] Step 4: 缓存扫描结果。
- [ ] Step 5: 设置定时刷新和手动刷新入口。

### Task 9: 收藏和快捷打开

**Files:**

- Create: `packages/core/src/indexer/favoritesRepository.ts`
- Create: `packages/core/src/command/builtInFavorites.ts`
- Create: `apps/desktop/src/renderer/src/settings/FavoritesSettings.tsx`

- [ ] Step 1: 支持添加文件、文件夹、URL。
- [ ] Step 2: 支持编辑标题和关键词。
- [ ] Step 3: 支持删除收藏。
- [ ] Step 4: 收藏项进入命令注册表。
- [ ] Step 5: 执行收藏命令后记录历史。

### Task 10: 插件清单和校验

**Files:**

- Create: `packages/core/src/plugin/pluginManifest.ts`
- Create: `packages/core/src/plugin/validateManifest.ts`
- Create: `packages/core/src/plugin/pluginPaths.ts`
- Create: `tests/unit/validateManifest.test.ts`

- [ ] Step 1: 定义 manifest schema。
- [ ] Step 2: 校验插件 ID、版本、入口文件、权限和命令。
- [ ] Step 3: 拒绝缺少必填字段的插件。
- [ ] Step 4: 拒绝声明未知权限的插件。
- [ ] Step 5: 返回面向用户的错误信息。

### Task 11: 插件运行时

**Files:**

- Create: `packages/core/src/plugin/pluginRuntime.ts`
- Create: `packages/core/src/plugin/pluginLifecycle.ts`
- Create: `packages/core/src/plugin/pluginCommandAdapter.ts`
- Create: `packages/plugin-api/src/index.ts`
- Create: `packages/plugin-api/src/types.ts`

- [ ] Step 1: 加载插件 manifest。
- [ ] Step 2: 创建插件上下文。
- [ ] Step 3: 注册插件命令。
- [ ] Step 4: 启用和禁用插件。
- [ ] Step 5: 捕获插件异常并写入插件日志。

### Task 12: 插件页面容器

**Files:**

- Create: `apps/desktop/src/renderer/src/plugin-host/PluginHost.tsx`
- Create: `apps/desktop/src/renderer/src/plugin-host/pluginBridge.ts`
- Modify: `apps/desktop/src/preload/index.ts`

- [ ] Step 1: 用 WebView 或 BrowserView 承载插件页面。
- [ ] Step 2: 限制插件页面导航。
- [ ] Step 3: 通过 bridge 暴露白名单能力。
- [ ] Step 4: 插件页面关闭后释放资源。
- [ ] Step 5: 插件页面异常时回到 Launcher。

### Task 13: 内置插件 - 计算器

**Files:**

- Create: `packages/built-in-plugins/calculator/package.json`
- Create: `packages/built-in-plugins/calculator/src/index.ts`
- Create: `packages/built-in-plugins/calculator/src/evaluateExpression.ts`
- Create: `tests/unit/calculator.test.ts`

- [ ] Step 1: 输入数学表达式时生成计算器结果。
- [ ] Step 2: 支持加减乘除、括号、小数。
- [ ] Step 3: 回车复制结果到剪贴板。
- [ ] Step 4: 非法表达式不注册结果命令。
- [ ] Step 5: 添加表达式解析测试。

### Task 14: 内置插件 - 剪贴板历史

**Files:**

- Create: `packages/built-in-plugins/clipboard-history/src/index.ts`
- Create: `packages/built-in-plugins/clipboard-history/src/clipboardWatcher.ts`
- Create: `packages/built-in-plugins/clipboard-history/src/clipboardRepository.ts`
- Create: `tests/unit/clipboardHistory.test.ts`

- [ ] Step 1: 监听文本剪贴板变化。
- [ ] Step 2: 保存最近 200 条文本记录。
- [ ] Step 3: 搜索 `clip` 时展示剪贴板历史。
- [ ] Step 4: 执行结果时复制该历史内容。
- [ ] Step 5: 设置页提供清空历史按钮。

### Task 15: 内置插件 - 文本处理

**Files:**

- Create: `packages/built-in-plugins/text-tools/src/index.ts`
- Create: `packages/built-in-plugins/text-tools/src/transforms.ts`
- Create: `tests/unit/textTools.test.ts`

- [ ] Step 1: 支持大小写转换。
- [ ] Step 2: 支持去除空行。
- [ ] Step 3: 支持 JSON 格式化。
- [ ] Step 4: 支持 URL encode/decode。
- [ ] Step 5: 对非法 JSON 显示错误，不覆盖剪贴板。

### Task 16: 设置页

**Files:**

- Create: `apps/desktop/src/renderer/src/settings/SettingsPage.tsx`
- Create: `apps/desktop/src/renderer/src/settings/HotkeySettings.tsx`
- Create: `apps/desktop/src/renderer/src/settings/ThemeSettings.tsx`
- Create: `apps/desktop/src/renderer/src/settings/PluginSettings.tsx`
- Create: `apps/desktop/src/renderer/src/settings/DataSettings.tsx`

- [ ] Step 1: 添加设置页路由。
- [ ] Step 2: 实现快捷键录制。
- [ ] Step 3: 实现主题切换。
- [ ] Step 4: 实现插件启用、禁用、卸载。
- [ ] Step 5: 实现打开数据目录。

### Task 17: 打包和发布

**Files:**

- Create: `electron-builder.yml`
- Modify: `apps/desktop/package.json`
- Create: `docs/product/beta-release-checklist.md`

- [ ] Step 1: 配置 Windows NSIS 安装包。
- [ ] Step 2: 设置应用图标和应用名称。
- [ ] Step 3: 配置用户数据目录。
- [ ] Step 4: 生成安装包。
- [ ] Step 5: 在干净 Windows 用户环境验证安装、启动、退出和卸载。

## 12. 测试策略

### 单元测试

覆盖：

- Manifest 校验。
- 命令注册表。
- 搜索排序。
- 设置存储。
- 历史权重。
- 内置插件纯函数。

命令：

```bash
pnpm test
```

### 集成测试

覆盖：

- 主进程 IPC。
- 设置读写。
- 插件安装和启用。
- 命令执行分发。
- 应用索引刷新。

命令：

```bash
pnpm test:integration
```

### E2E 测试

覆盖：

- 启动应用。
- 快捷键呼出窗口。
- 搜索内置命令。
- 执行命令。
- 修改设置。
- 安装本地插件。

命令：

```bash
pnpm test:e2e
```

### 性能测试

覆盖：

- 5000 条命令搜索耗时。
- 10000 条剪贴板历史检索耗时。
- 插件安装耗时。
- 快捷键呼出耗时。

目标：

- 搜索小于 50ms。
- 快捷键呼出小于 150ms。
- 插件安装小于 1s。

## 13. 质量门槛

每个里程碑完成前必须满足：

- `pnpm lint` 通过。
- `pnpm test` 通过。
- 新增核心逻辑有单元测试。
- 手动验证核心用户流程。
- 没有主进程未捕获异常。
- 插件异常能被捕获并显示在日志中。

Beta 发布前必须满足：

- Windows 安装、启动、退出、卸载验证通过。
- 快捷键冲突时不会让应用进入不可用状态。
- 插件禁用后不会残留命令。
- 数据库迁移可重复执行。
- 用户数据目录路径可在设置页查看。

## 14. 风险与应对

### 风险 1: 插件权限过大

应对：

- 第一版只开放白名单 API。
- 插件必须声明权限。
- 插件 API 经过主进程代理。
- 本地开发插件显示明显信任提示。

### 风险 2: 搜索结果不准

应对：

- 搜索结果记录 `matchedBy` 和分数。
- 设置可调整来源权重。
- 历史行为自动提升常用项。
- 提供固定命令功能。

### 风险 3: 文件和应用索引卡顿

应对：

- 索引在后台执行。
- 首次启动只扫描应用，不全盘扫描文件。
- 文件搜索优先做收藏和最近文件。
- 索引刷新限流。

### 风险 4: Electron 包体积较大

应对：

- 第一版接受体积换开发效率。
- 使用代码分割。
- 避免引入大型 UI 框架。
- 后续稳定后再评估 Tauri 版本。

### 风险 5: 跨平台差异

应对：

- Windows 优先实现。
- 系统能力封装成平台适配层。
- macOS 和 Linux 单独建适配任务。
- 不在 MVP 同时承诺三端完整一致。

## 15. 开发节奏建议

建议 8-10 周完成可用 Beta：

- 第 1 周：项目初始化、桌面壳、快捷键。
- 第 2 周：Launcher UI、命令注册表。
- 第 3 周：搜索排序、本地存储、历史权重。
- 第 4 周：应用索引、收藏、快捷打开。
- 第 5-6 周：插件运行时、插件 API、插件页面容器。
- 第 7 周：内置插件。
- 第 8 周：设置页、插件管理。
- 第 9 周：打包、性能、崩溃日志。
- 第 10 周：Beta 修复、文档和发布。

## 16. 团队分工建议

如果 1 人开发：

- 先完成 Milestone 0-4。
- 再做插件系统。
- 最后补内置插件和打包。

如果 2-3 人开发：

- A 负责 Electron 主进程、快捷键、打包。
- B 负责 Launcher UI、设置页、交互体验。
- C 负责 Core、搜索、插件运行时、测试。

如果 4 人以上开发：

- 增加插件开发者体验负责人。
- 增加 QA 和发布负责人。
- 提前建立 Beta 用户反馈渠道。

## 17. 开发者文档计划

MVP 需要准备以下文档：

- `docs/product/mvp-scope.md`：MVP 范围和非目标。
- `docs/architecture/process-model.md`：主进程、渲染进程、插件运行时关系。
- `docs/developer/plugin-manifest.md`：插件清单字段说明。
- `docs/developer/plugin-api.md`：插件 API。
- `docs/developer/create-plugin.md`：创建第一个插件。
- `docs/product/beta-release-checklist.md`：Beta 发布检查清单。

## 18. Beta 验收清单

- [ ] Windows 安装包可安装。
- [ ] 应用可正常启动和退出。
- [ ] 全局快捷键可呼出窗口。
- [ ] 搜索框输入无明显卡顿。
- [ ] 应用搜索和启动可用。
- [ ] 收藏文件、文件夹、URL 可用。
- [ ] 计算器插件可用。
- [ ] 剪贴板历史插件可用。
- [ ] 文本处理插件可用。
- [ ] 本地插件安装、启用、禁用、卸载可用。
- [ ] 设置修改后重启保留。
- [ ] 插件异常不会导致主应用崩溃。
- [ ] 打包产物通过干净环境测试。

## 19. 后续路线图

Beta 之后再考虑：

- macOS 支持。
- Linux 支持。
- 插件市场。
- 插件签名。
- 插件评分和审核。
- 配置云同步。
- AI 命令插件。
- 工作流自动化。
- 团队共享命令。
- 企业策略和权限管理。

## 20. 第一阶段最小行动清单

开始编码前，先完成这 5 件事：

- [ ] 确认应用 ID，例如 `com.commandcabin.app`。
- [ ] 确认第一版只做 Windows，还是同时保留 macOS 验证。
- [ ] 确认默认快捷键。
- [ ] 确认插件第一版是否允许第三方用户安装。
- [ ] 确认是否使用 Electron + React + TypeScript 作为第一版技术栈。
