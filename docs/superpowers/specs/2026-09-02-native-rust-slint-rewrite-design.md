# CommandCabin 原生重写设计：Rust + Slint

日期：2026-09-02
状态：已确认（技术选型、许可、更新机制、平台范围均已决策）

## 背景与动机

CommandCabin 当前基于 Electron（约 3 万行 TypeScript，其中 main 8.5k / renderer 9.6k /
core 8k / 内置插件 1.5k）。Electron 的多进程 Chromium 架构导致三个可测量的问题：

1. 常驻内存高（空闲 150-300MB+），而启动器需要常驻托盘
2. 热键呼出/冷启动慢
3. 安装包体积大（80MB+）

决定彻底原生重写。已确认的约束：

- **技术栈**：Rust + Slint（声明式原生 GUI，无浏览器内核）
- **平台**：本次只实现 Windows；`cabin-platform` trait 预留跨平台结构
- **插件体系**：不保留第三方插件系统；现有 4 个内置功能（计算器、剪贴板历史、
  文本工具、快速转换）以普通模块内建
- **项目许可**：保持 MIT 不变；Slint 采用 Royalty-free 许可，在"关于"页面署名
  （显示 "Made with Slint" 及许可文本）
- **更新机制**：NSIS 安装包 + GitHub Releases 自更新（沿用现有发布渠道）

## 1. 量化目标（验收标准）

| 指标 | 现状（Electron 典型值） | 目标 |
|---|---|---|
| 常驻空闲内存 | 150-300MB | < 60MB |
| 热键呼出到可输入 | 300-800ms | < 150ms（冷启动 < 500ms） |
| 安装包体积 | 80MB+ | < 20MB |
| 功能 | 现有全部功能 | 完全对齐（范围见第 4 节） |

指标在 release 构建上实测，作为发布关口。

## 2. 总体架构：单进程 Cargo workspace

在仓库新增 `native/` 目录作为 Cargo workspace，与现有 pnpm workspace 并行存在
（Electron 版继续可用，直到原生版达标切换）：

```
native/
├── Cargo.toml             # workspace 清单
├── crates/
│   ├── cabin-core/        # 纯业务逻辑：命令模型、搜索排序、设置、收藏、历史
│   │                      # （对照移植 packages/core，不依赖任何 GUI/OS API）
│   ├── cabin-storage/     # SQLite（rusqlite）+ 迁移框架，复用现有迁移 ID 序列
│   ├── cabin-platform/    # OS 抽象层 trait：热键/托盘/剪贴板/应用索引/截图/自启动/更新
│   ├── cabin-platform-windows/  # Windows 实现（windows-rs）
│   ├── cabin-features/    # 4 个内置功能：calculator、clipboard-history、
│   │                      # text-tools、quick-converter（普通模块，非插件沙箱）
│   └── cabin-app/         # Slint UI 绑定 + 应用编排 + 入口 main
└── ui/                    # .slint 文件：启动器、设置、截图标注覆盖层、关于页（含 Slint 署名）
```

分层规则与现状一致：`cabin-core` 必须是纯逻辑（可在任何平台单测），OS 调用只能出现
在 `cabin-platform*`。这保留了现有架构中最有价值的部分——分层与测试习惯——只是换
成 Rust。

`cabin-platform` 的 trait 划分按能力域拆分（HotkeyProvider、TrayProvider、
ClipboardProvider、AppIndexer、ScreenshotCapture、AutostartManager、UpdateService），
Windows 实现独立于 trait crate，未来 macOS/Linux 实现新增 crate 即可。

## 3. 数据流（不再需要 IPC）

单进程内直接函数调用，替代现在的 IPC + preload + `window.desktopApi`：

- 热键触发 → `cabin-platform-windows` 回调 → `cabin-app` 显示启动器窗口
- 输入查询 → `cabin-core` 搜索管道（providers → 模糊匹配 → 排序加成）→ Slint 列表
  模型增量更新
- 执行命令 → `cabin-core` 的 command executor → 需要 OS 动作时经 `cabin-platform`
  trait 下发
- 所有异步 I/O（索引扫描、翻译请求）在 tokio 运行时上执行，通过 channel 回 UI 线程

`window.desktopApi` 的边界校验职责由 `cabin-app` 入口处的参数解析/校验层继承，风格
与现在的 shared API parsers 一致（拒绝未知/畸形输入后才进入 core）。

## 4. 功能迁移清单与范围裁剪

**完整迁移**：

- 启动器搜索与排序（含来源/历史/固定/最近使用/精确标题匹配的排序加成）
- 应用索引（开始菜单/桌面快捷方式扫描）
- 收藏/固定/使用历史
- 设置（主题、语言、热键、自启动）
- 托盘、单实例、开机自启
- 自动更新
- 截图标注（区域截图、画笔/矩形/文字等标注、保存/复制）
- 截图 OCR + 在线翻译覆盖层
- 4 个内置功能（计算器、剪贴板历史、文本工具、快速转换）
- i18n（zh-CN / en 字符串表）
- 应用图标解析与缓存（含 Windows AppUserModelID 图标解析）

**明确裁剪**：

- 第三方插件系统（manifest、权限、webview 沙箱、plugin host、plugin bridge）——删除，
  4 个内置功能直接内建
- Electron 专有问题域（webviewGuard、preload 桥、IPC channel 常量）——随之消失

**行为对齐基准**：搜索排序结果以现有 TS 实现的测试用例为准——把 `packages/core` 的
排序测试移植为 golden tests，确保 Rust 版排序行为不回归。

## 5. 关键技术替换对照

| 现有实现 | Rust 替换 | 附带收益 |
|---|---|---|
| Fuse.js 搜索 | `nucleo-matcher` + 移植现有排序加成逻辑 | 匹配速度提升一个量级 |
| node:sqlite | `rusqlite`（捆绑 SQLite） | 同一套迁移 ID，数据库可直接沿用 |
| PowerShell 解析快捷方式 | `windows-rs` 直调 IShellLinkW | 去掉子进程，索引提速 |
| PowerShell + Windows.Media.Ocr | `windows-rs` 直调 WinRT OCR | 去掉子进程 |
| desktopCapturer 截图 | `windows-rs` Graphics Capture / GDI | 无 Chromium 开销 |
| Google/MyMemory 翻译 fetch | `reqwest` | 逻辑基本照抄 |
| electron-updater | NSIS + `self_update`（GitHub Releases） | 安装包体积骤降 |
| electron-builder | `cargo-bundle` / 手动 NSIS 脚本 | 工具链简化 |
| React 启动器/设置页 | Slint .slint 声明式 UI | 无浏览器内核 |
| electron tray/globalShortcut | `tray-icon` / `global-hotkey` crate | — |

OCR 的超时与降级行为对齐现有常量（如 `DEFAULT_OCR_TIMEOUT_MS = 10_000`、翻译
6 秒超时、翻译文本 2000 字符上限）。

## 6. 错误处理

- `cabin-core` / `cabin-storage`：`thiserror` 定义强类型错误枚举（对齐现有 TS 的判别
  联合风格）
- `cabin-app` / platform 层：`anyhow` 聚合，用户可见错误走统一的 toast/状态栏通道
- 索引扫描、OCR、翻译等外部操作全部带超时和降级路径；单个应用索引失败不阻塞整体索引
- panic = bug：UI 线程不允许 `unwrap`，code review 卡点

## 7. 测试策略

- `cargo test` 逐 crate 单测；`cabin-core` 对照移植 `packages/core` 全部测试用例
- 排序行为 golden tests：排序层（rankSearchCandidate 移植版）对相同输入必须与 TS 版
  产出逐项相同的分数与分量；端到端结果序列用人工审阅的固定语料（fixture corpus）验证
  ——因为 Fuse.js 替换为 nucleo-matcher 后原始 fuzzy 分数语义不同，不做跨实现逐分比对
- Windows 集成测试（快捷方式解析、OCR、热键注册、图标解析）在 CI windows runner 上跑
- UI 层用 Slint 软件渲染器做无头 smoke 截图测试（不追求像素级）
- 验收关口：第 1 节三项量化指标在 release 构建实测达标

## 8. 迁移与发布策略

1. **并行期**：`native/` 与 Electron 版共存；Electron 版只修 bug 不加功能
2. **里程碑**：
   - M1 启动器核心（搜索 + 执行 + 应用索引 + 热键 + 托盘 + 单实例）
   - M2 设置 / 收藏 / 历史 / 自启动 / i18n / 应用图标解析与缓存
   - M3 截图标注 + OCR 翻译
   - M4 内置功能补全（计算器、剪贴板历史、文本工具、快速转换）
   - M5 更新器 + NSIS 打包 + 指标验收
3. **数据连续性**：数据库 `command-cabin.sqlite` 直接沿用（迁移 ID 序列一致，用户无感）；
  设置 JSON 提供一次性导入
4. **切换**：原生版达标后作为 v1.0 发布，Electron 版归档维护一个版本周期

## 9. 已确认的决策

1. **Slint 许可**：Royalty-free，"关于"页署名，项目保持 MIT
2. **更新机制**：NSIS 安装包 + GitHub Releases 自更新
3. **平台**：仅 Windows 实现，`cabin-platform` trait 预留跨平台结构

## 风险与缓解

- **Slint 生态成熟度**：组件丰富度低于浏览器生态。缓解：启动器 UI 形态简单
  （搜索框 + 列表 + 设置页），M1 先做 UI 原型验证可行性，不达标可及时转向
  Avalonia 方案
- **重写工作量**（约 1.8 万行平台无关代码需移植）：缓解：core 逻辑有完整测试对照，
  里程碑切分保证每阶段可演示
- **WinRT/COM 互操作复杂度**（windows-rs 学习曲线）：缓解：快捷方式解析、OCR 均为
  成熟路径，有公开示例可循
- **图标解析**：Windows 图标格式（.ico/.lnk 关联图标/AppUserModelID）在原生侧反而更
  直接，但需移植现有缓存与回退逻辑及测试
