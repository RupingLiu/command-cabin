# M1 验收基线（Rust + Slint 原生重写）

- 日期：2026-09-03
- 对象：`native/artifacts/cabin-app-release.exe`（由 `native/scripts/build.ps1 -Release` 产出，
  工具链 x86_64-pc-windows-gnu / cargo 1.95，构建时代码含 TEMP-BENCH(T11) eprintln 插桩，
  插桩未提交、对测量无实质影响）
- 环境：Windows 11 (10.0.26100) x86_64，主屏 2560x1707；机器开始菜单/桌面共 240 个 .lnk
- 对照目标：spec 第 1 节（常驻空闲内存 < 60MB；热键呼出 < 150ms、冷启动 < 500ms；安装包 < 20MB）
- 原始数据：stderr 日志与截图留存于 `%TEMP%\m1-bench\`（cold1/2/3.err.log、visual.err.log、
  A-before.png / B-shown.png / C-after-esc.png）

## 1. 量化指标

| 指标 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 可执行体积（安装包代理，M1 无安装包） | < 20MB | **13.44 MB**（14,089,728 B） | 达标 |
| 冷启动（main-enter → event-loop-ready，内部时间戳） | < 500ms | 94 / 90 / 93 ms，中位 **93ms** | 达标 |
| 冷启动（外部观察：Start-Process → 日志出现 ready，25ms 轮询粒度，含进程创建/杀软扫描） | 参考 | 720 / 695 / 865 ms，中位 720ms | 参考值（上界） |
| 冷启动（brief 粗测 `Measure-Command { Start-Process }`，仅进程创建） | 参考 | 59 / 17 / 19 ms | 参考值 |
| 热键呼出（hotkey-fired → window-shown，内部时间戳） | < 150ms | 启动后首次 **157ms** / 96ms（两次运行）；再次呼出 **3ms** | 首次呼出临界/略超，列入 M5 收口 |
| 常驻空闲内存（窗口未呼出，托盘驻留 WorkingSet64） | < 60MB | t0=63.2MB → t30=127.5 → t60=**127.4** → t90=127.4MB；PrivateBytes t60=89.3MB | **不达标**，列入 M5 收口 |

注：

- 内存采样期间进程 CPU 累计 0.7s，确为空闲；启动后 30s 内 WS 从 63MB 涨到 127MB 后稳定，
  与后台索引扫描/结果缓存的时间窗重合，根因分析留待 M5（候选：索引结果驻留、COM/图像库
  缓存、Slint 软件渲染缓冲）。
- "安装包 < 20MB" 一项 M1 尚无安装包，按任务说明以 release exe 体积作为代理并记录。

## 2. 功能验收清单

自动化可覆盖项已实测；需交互项标注"待人工"。截图证据见 `%TEMP%\m1-bench\B-shown.png`。

| 项 | 结果 | 证据 / 说明 |
| --- | --- | --- |
| Alt+Space 呼出窗口 | 通过 | keybd_event 注入 Alt+Space 后窗口出现（截图 B），日志 hotkey-fired → window-shown |
| 窗口置顶 | 通过 | WS_EX_TOPMOST 置位（exstyle & 0x8） |
| 窗口居中 | **不通过** | 实测窗口 rect (329,329)-(973,776)，屏幕 2560x1707，偏左上，未居中 |
| 输入框聚焦 | **不通过** | GetForegroundWindow ≠ 启动器 hwnd；窗口 show 后未激活，按键进入其他前台应用。Slint `forward-focus` 指向 LineEdit，但窗口本身未获得前台/焦点 |
| 空查询显示应用列表 | **不通过** | 截图 B 列表为空。根因已定位：`show_window()` 调 `refresh_query_reset()` 把 results 置空模型后不再 `refresh_results`（main.rs），`set_current_query("")` 不触发 `edited` 回调，故每次呼出列表必为空，直到用户键入 |
| 模糊搜索（"vsc" 命中 Visual Studio Code） | 待人工 | 无头环境无法安全打字（窗口无焦点，按键会进入其他应用） |
| ↑/↓/Enter 导航执行；鼠标点击执行 | 待人工 | 键盘路径受聚焦问题阻断 |
| Esc 隐藏 | **不通过**（自动化条件下） | 注入 Esc 后窗口仍在（截图 C 与 B 一致）；因窗口无焦点，Slint 按键处理收不到 Esc |
| 再次呼出查询已清空 | 通过（代码级） | `show_window` 先 `set_current_query("")`；实机效果待人工复核 |
| 托盘菜单"显示 CommandCabin"/"退出" | 待人工 | 进程驻留即托盘构造成功；菜单交互未自动化 |
| 第二个实例启动后静默退出 | 通过 | 第二实例 10s 内退出、仅剩 1 个进程，stderr 仅 main-enter 一行（静默 Ok 返回） |
| 卸载类快捷方式不出现在结果中 | 通过（代码+单测） | `is_uninstaller` 过滤（unins 前缀 / uninstall / 卸载），单测 `uninstaller_shortcuts_are_skipped` 覆盖；实机显示受空列表问题阻断 |
| 迁移 rerun 不报未知迁移 | 通过（类比验证） | M1 应用未接 storage（DB 接入在 M2）；`cargo test -p cabin-storage` 4/4 通过，含 `rerun_applies_nothing` 与 `unknown_applied_migration_is_rejected`（2026-09-03 复跑确认） |

## 3. 新发现问题（随基线记录）

> 以下为基线测量当日（2026-09-03 上午）发现的问题。其中 1/2/4/5 已于同日由
> M1 缺陷修复（Fix-1）解决并复测通过，此处保留原始记录；当前状态见第 4 节。

1. **空列表缺陷**（功能项阻断）：`show_window` → `refresh_query_reset` 清空结果后不重填，
   每次呼出均为空列表。影响"空查询显示应用列表"及搜索体验起点。
   【已修复】Fix-1：`show_window` 改走与 `edited` 回调一致的 `refresh_results`，
   每次呼出重填（冒烟截图确认列表非空）。
2. **窗口不聚焦**：show 后非前台窗口，导致 Esc/键盘导航/打字全部不可达；呼出后无法直接输入。
   【已修复】Fix-1：`with_winit_window(focus_window)` + 显式 `focus-input()`，
   冒烟验证每次呼出 `foreground=True`，注入 Esc 可隐藏窗口。
3. **窗口不居中**：当前固定出现在 (329,329) 附近，未按屏幕居中。
   【未修复】稳定 Slint 无屏幕尺寸 API，保留至 M5。
4. **热键回调每次触发两次**：`WindowsHotkeys` 事件泵未过滤 `GlobalHotKeyEvent.state`，
   按下+抬起各回调一次（bench 日志中 hotkey-fired/show-enter 成对出现）。当前 show 幂等，
   属隐患而非故障。
   【已修复】Fix-1：泵线程仅分发 `HotKeyState::Pressed`，单测
   `only_pressed_events_are_dispatched` 覆盖。
5. **release exe 为 console 子系统**：未设 `#![windows_subsystem = "windows"]`，
   从资源管理器/Start-Process 启动会附带控制台窗口（截图 B 中启动器背后的终端窗）。M5 打包收口。
   【已修复】Fix-1：已加 `#![windows_subsystem = "windows"]`，PE subsystem=2，
   冒烟确认无控制台窗口。
6. 隐藏窗口对 `IsWindowVisible` 仍返回 true（4x4 桩窗口于 (0,0)），且每次 show 重建 HWND——
   仅作测量方法备注，不计缺陷。

## 4. M5 收口清单（不达标项汇总）

- [ ] 常驻空闲内存 127MB → 目标 < 60MB（根因分析 + 瘦身）
- [ ] 首次热键呼出 157ms 临界超标（目标 < 150ms；再次呼出 3ms 已达标）
- [x] ~~空查询列表为空~~（Fix-1 已修复并冒烟确认）
- [x] ~~呼出窗口聚焦/前台~~（Fix-1 已修复并冒烟确认）
- [ ] 呼出窗口屏幕居中（稳定 Slint 无屏幕尺寸 API，M5 评估 winit 途径）
- [x] ~~热键事件按 Pressed 过滤，消除双触发~~（Fix-1 已修复，含单测）
- [ ] 产出安装包并按 < 20MB 实测（console 子系统问题已由 Fix-1 修复；安装包本身属 M5）

## 5. 验证过程备注

- `cargo fmt --check`：通过（2026-09-03）。
- `cargo clippy -p cabin-core -p cabin-storage -p cabin-platform -p cabin-platform-windows -- -D warnings`：通过。
  基线测量时 cabin-app 因含 TEMP-BENCH 插桩且需重建 Slint 全量依赖未纳入 clippy；
  Fix-1 剥除插桩后已补跑 `cargo clippy --workspace -- -D warnings`（含 cabin-app）：通过。
- 基线测量用的 release exe 为当日上午 build.ps1 产物的复用（已核实无更新源码）；
  Fix-1 后的修复验证构建另行进行，两者的测量背景已在 Fix-1 报告中注明。
- TEMP-BENCH 插桩已于 Fix-1 全部剥除（基线测量完成后）。
- 构建包装器已按其约定在构建后删除 `native/target`；各次验证产生的 `native/target`
  均已在结束后删除（硬盘红线）。
