# M5 指标验收收口（M1-M4 清单）

- 日期：2026-09-06
- 对象：`native/artifacts/cabin-app-release.exe`（gate 剥除后的 M5 最终构建，opt-level "s"，
  SHA256 见 §6；安装包 `CommandCabin-Setup-0.1.0.exe` + `.sha512` 同目录）
- 环境：Windows 11 (10.0.26100) x86_64，会话仍为锁定态（FG=0，单屏 1260×840）——
  与 M3 同态（物理注入不可用，沿用 WM_HOTKEY 仿真 + WM_KEYDOWN 消息级打字 +
  PrintWindow 成像口径）。工具链 stable-x86_64-pc-windows-gnu / cargo 1.95。
- 本轮对源码的净改动（全部带测试，628/628 绿，clippy workspace -D warnings、fmt 干净）：
  1. 渲染后端切换：slint 默认特性集 → **renderer-software**（剔 femtovg/glutin/glow 与
     未使用的 system-tray；**accessibility/UIA 保留**）——`crates/cabin-app/Cargo.toml`；
  2. release profile 增加 `opt-level = "s"`——`native/Cargo.toml`；
  3. 呼出窗口居中（winit 通道）：`state::centered_origin` 纯函数（2 测试）+
     `center_window_on_monitor` 接线（main.rs `show_launcher_window`）；
  4. `search.maxResults` load 裁决改 **clamp-and-warn**（storage，超 i32::MAX 钳制 +
     stderr 注记；类型错误仍拒；测试改写锁定）；
  5. `PlatformError::Index` 孤儿变体**删除**（终裁：无任何生产者）；
  6. 极简错误级文件日志（`windows_subsystem` 诊断收口）：panic/fatal →
     `%APPDATA%\CommandCabin\logs\command-cabin.log`，1MB 轮转保留一代
     （`rotate_log_if_needed` + `diag_log_rotates_when_over_cap` 测试）。
- 临时测量插桩（图标水合门 / watcher 门 / 额外窗口探针）已全部剥除，
  `grep -rn "M5_PROBE|M5-PROBE|M5-T5-TEMP-PROBE" native/crates` 零命中，最终 exe
  二进制内 `M5_PROBE` 字符串 0 处。

## 1. 指标总表（goal → 动作 → 实测 → 裁决）

| 指标 | 目标 | M4 基线 | 本轮动作 | M5 实测 | 裁决 |
| --- | --- | --- | --- | --- | --- |
| 常驻空闲内存（WS/PB @t60，login-startup 隐藏窗口径） | < 60MB | 314.6/219.4MB | **根因定位 + 渲染后端切换**（§2） | **36.7/9.6MB**（t90 稳定 36.5） | **达标**（余量 23MB） |
| exe 体积 | < 20MB | 20.54MB | opt-level s + renderer 特性裁剪（§3） | **15.92MB**（16,690,688 B） | **达标**（余量 4.08MB） |
| 安装包体积 | < 20MB | 无（M5 T4 首产） | makensis 实测 | **6.08MB**（6,375,994 B，压缩率 37.7%）+ sha512 边车复核一致 | **达标** |
| 首次热键呼出（WM_HOTKEY 仿真 → 可见，5ms 轮询） | < 150ms | 43ms | 渲染器切换后复测 | 新实例首呼 **29ms**；热进程首呼 8ms；重复 14–16ms | **达标**（注 1：构建后首次运行的 AV 冷启动单点 310ms，一次性） |
| 冷启动（Start-Process → 首个可见窗，10ms 轮询，5 轮全保留） | < 500ms | 474ms 中位（待复测） | 复测 + 渲染器切换 | 142/108/109/109/126ms，中位 **109ms** | **达标**（M4 的 GPU 首帧瓶颈诊断被本轮证实并消除，注 2） |
| 呼出窗口屏幕居中 | 居中 | 不通过（M1/M2 连续挂账） | **已实现**：winit `current_monitor()` 矩形 + `set_outer_position`（物理像素，负坐标/超尺寸钳制有测试） | rect (309,197)-(952,643)，中心 **(630.5,420)** vs 屏中心 (630,420)——0.5px 舍入差 | **达标**（多显示器/负坐标由纯函数测试覆盖；实机多屏 待人工） |
| `maxResults > i32::MAX` load 裁决（M2 T3 挂账） | clamp vs reject | reject | **clamp-and-warn**：钳到 i32::MAX + stderr 注记（数据连续性优先；写路径 patch 域不变） | 单测锁定（超限钳制 / 边界接受 / -1 仍拒）；类型错误消息逐字不变 | **收口**（行为变化点：load 不再整份拒收——比 reject 宽松，向 TS 靠拢） |
| `PlatformError::Index` 孤儿变体终裁（M1 起挂账） | 接线或删除 | 无生产者 | **删除**（复核 M1-M5 全部代码确无构造点；索引失败面由 `IndexScanResult.failures` 承载） | 编译 + 628 测试 + clippy 全绿 | **收口（删除）** |
| `windows_subsystem` 吞 debug 诊断（M2 挂账） | 文件日志 or 文档化 | 仅 stderr（不可见） | **极简文件日志**：panic 钩子 + fatal 通道 → userData/logs，1MB 轮转；普通运行日志不落盘 | 本轮全部冒烟（含一次 Enter 执行失败路径）后 `logs/` 目录不存在 = 无 panic/fatal 时的零副作用验证；轮转逻辑有单测 | **收口（实现）** |
| 更新横幅 [忽略] 按钮（计划文字 vs TS 冲突，M5 T3 注记） | 注记 | T3 裁定按 TS（无此按钮） | 维持按 TS；本注记即为收口记录 | ——（TS updateController 无 ignore 语义，不移植） | **收口（注记）** |
| 升级链路（0.9→1.0 覆盖） | 冒烟 | T4 已完成（34 项真机检查） | 本轮不重跑安装/卸载循环（脚本未变，exe 更换）；sha512 边车与产物交叉复核一致 | §4 | 沿用 T4 证据 |

## 2. 内存根因分析（头号项）——已定位并修复

M1→M4 恶化曲线 127→223→314→314MB 的根因**不是**此前嫌疑清单中的任何一项
（图标水合、watcher、剪贴板缓存、引擎/命令池、ureq agent 全部排除），而是：

> **femtovg/GL 渲染器为每个隐藏 Slint 窗口常驻 ~82MB WS**（GL 上下文 + 驱动侧分配；
> 组件树本身创建近乎免费）。5 窗口（3 急切 + 探针注入 2 个）跨平台期存活的实测
> 平台期 **490.3MB**，3 窗口基线 326.2MB，差值 164.1MB ÷ 2 = **82.0MB/窗**，
> 线性干净。分配发生在**事件循环启动**（组件实例化时 0 增量、1ms——314MB 的
> t10 onsets 与扫描/水合时间窗的重合是误导性相关）。

逐项排除证据（同一构建，env 门控，t60 WS/PB）：

| 配置 | t0 | t10 | t60 | 结论 |
| --- | --- | --- | --- | --- |
| 基线（3 隐藏窗） | 10.7/2.2 | 326.2/218.7 | 326.2/218.6 | 平台期复现 |
| 禁图标水合（解码+提取+重渲染全断） | 75.1/53.0 | 316.8/219.6 | 316.7/219.4 | **−9.5MB ≈ 噪声级**——图标水合无罪 |
| 禁剪贴板 watcher | 32.7/7.5 | 316.3/218.8 | 316.3/218.7 | **−9.9MB ≈ 噪声级**——watcher 无罪 |
| 两者同禁 | 74.8/52.9 | 316.7/219.2 | 316.6/219.1 | 排除叠加效应 |
| 5 窗口存活（femtovg） | 20.7 | 490→505 峰 | 490.3/346.5 | **+164MB = 82MB/窗** |
| SLINT_BACKEND=sw（软件渲染器探针） | 33.6/8.3 | 38.9/10.9 | 38.9/10.7 | **平台期坍缩至 <60MB 目标内** |

**修复（保留）**：slint 特性集显式化为 `renderer-software`（CPU 渲染，femtovg/glutin/glow
出编译图，`cargo tree` 复核 0 命中），accessibility/UIA 保留。最终构建平台期
**36.7MB WS / 9.6MB PB**——较 M4 下降 **88%**，指标达标。

连带收益：冷启动中位 474→109ms（M4 注 1 的 "show 后首帧 GPU/合成器路径" 瓶颈
消除——CPU 软件渲染无 GL 上下文/着色器初始化）；每隐藏窗渲染器开销 ~82MB →
软件渲染器下全应用总量 36.7MB（即每窗摊薄 <12MB，惰性创建的剩余理论收益
≤ ~25MB，实施代价高——**惰性窗口改造不再立项**，见 §5 余量说明）。

行为影响评估：软件渲染器为 Slint 官方一级路径（femtovg 失败时的既有回退）；
视觉冒烟（首页列表/图标/CJK 字体/计算器动态命令高亮/截图覆盖窗）全部正常。
CPU 渲染的代价落在首帧后的重绘上——本应用窗口小（启动器 ~644×447），重复呼出
实测 14–16ms，无可观测劣化。4K 大屏与截图全屏覆盖窗的 CPU 重绘裕度**待人工**
（解锁桌面）复核，见 §5。

## 3. 体积实验表（逐项构建实测）

| 实验 | profile / 特性 | exe 体积 | 增量 | 备注 |
| --- | --- | --- | --- | --- |
| E0 基线（M5 探针构建，M4 同 profile） | opt-level 3（缺省）+ slint 默认特性（femtovg+software+accessibility+system-tray） | 20.81MB | — | 含探针插桩 + 居中/日志新代码 |
| E1 渲染器切换 | default-features=false → std, compat-1-2, backend-winit, **renderer-software**, accessibility, unstable-winit-030 | 20.29MB | −0.52MB | femtovg/glutin/glow 出图；rlib 大头早被 LTO 剪除，故减量有限 |
| E2 = E1 + **opt-level "z"** | + `opt-level = "z"` | **14.88MB** | −5.41MB | 全 profile 重编译；尺寸最优 |
| E3 = E1 + **opt-level "s"**（**采纳**） | + `opt-level = "s"` | **15.92MB** | −4.89MB | 与 z 差 1.04MB，换计算热路径（截图栅格化/JPEG 编码/nucleo 匹配）更稳的代码生成；余量仍 4.08MB |

- `lto="thin"`、`codegen-units=1`、`strip="symbols"` 自 M3 起即在 profile 中生效
  （本轮核实 `native/Cargo.toml`，E0 的 20.81MB 即在该配置下产出）。
- `panic = "abort"`：**评估后不采纳**（记录）：代码无 `catch_unwind`，但
  `.lock().unwrap()` 中毒模式与工作线程隔离语义（图标提取线程 panic 目前仅损失
  该线程）依赖 unwind；abort 会把任意工作线程 panic 升级为全进程崩溃，行为变化
  大于体积收益。如未来需要再挤 ~1-2MB 可与用户单独裁决。
- 依赖特性审计：`ureq`（tls，无 gzip）、`image`（png/jpeg/ico 精确特性）、
  `serde_json`（preserve_order）、slint（见 E1）均已最小化；`ravif/exr` 等 image
  重编解码器仅出现在 i-slint-compiler（build/proc-macro 侧，resolver=2 不与运行时
  统一特性，不进二进制）——`cargo tree -i` 核实，非体积杠杆。

## 4. 全功能回归冒烟（最终构建，消息级口径）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 启动器搜索（打字） | 通过 | WM_KEYDOWN "1+2*3" → PrintWindow：输入框 "1+2\*3"、首行选中 "7 / Copy result to clipboard"（动态命令置顶高亮），图标（MATLAB/东莞银行）与 CJK 文本渲染正常（软件渲染器视觉冒烟） |
| 计算器 Enter 执行链 | 通过（链路） | stderr：`command execution failed: Failure { command_id: "calculator.result", action_type: CopyText, … clipboard not accessible }`——查询→动态命令→选中→执行器→OS 剪贴板写全链路真实，被锁定会话 OS 拒绝（与 M4 同款环境限制，非缺陷）；执行失败后窗口保持（TS 语义） |
| Esc 隐藏 | 通过 | WM_KEYDOWN Esc → launcherVisible→0 |
| 剪贴板 watcher 心跳 | 通过（live） | `%APPDATA%` DB：`clipboard_history` 恒 200 行（prune 上限 live 生效）；本轮冒烟期间新增 row（copied_at=2026-09-05T20:02:00Z = 本地 04:02，恰为软件渲染器冒烟时刻）——读→落库→去重 live 链路在新构建上工作；stderr 翻转沿（"clipboard read failed: … held by another party"）为锁定会话常态 |
| 第二实例静默退出 | 通过 | 185ms 退出、主实例存活、stderr 0 字节 |
| 截图捕获→取消 | 通过 | `COMMAND_CABIN_DEBUG_SCREENSHOT=1`：1.5s 后自动捕获，覆盖窗 (0,0)-(1260,840) 可见，Esc 后隐藏、进程存活（软件渲染器下截图管线回归通过） |
| 更新检查 live | 通过（生产代码路径） | 忽略级真机探针测试（cabin-platform-windows，`--ignored`）：`probe: OK in 353ms version=0.9.0 assets=3 installer_asset=None`——GitHub 可达、解析、版本比较全链路；现存 0.9.0 发布资产为旧 electron-builder 命名（`CommandCabin-0.9.0-x64-Setup.exe`），无 `CommandCabin-Setup-0.9.0.exe` → `begin_download` 将给出可读错误 "release 0.9.0 has no CommandCabin-Setup-0.9.0.exe asset"（单测锁定）= "无适用安装包" 路径；汇率端点 live 同过（USD→CNY 6.7127） |
| 设置窗口打开 | 待人工 | 入口仅托盘菜单，锁定会话托盘交互不可达（M2 起同款）；设置提交流/热键位移由 T3/T4 与单测覆盖 |
| 安装/卸载/升级循环 | 沿用 T4 | T4 34 项真机检查（临时前缀装/卸/覆盖 + %APPDATA% 保留断言）；本轮仅换 exe 重打包，脚本未动；sha512 边车与 Setup 产物 `sha512sum` 交叉复核一致；构建脚本 BOM（EF BB BF）复核在位 |

## 5. M5 余量清单（移交用户裁决 / 待人工）

1. **真实键鼠人工清单（beta 前硬性，M3/M4 项照旧）**：物理热键按压、截图六工具
   全链路、设置流实机、外部复制→历史浮现→pick 回写→粘贴、文本工具回写与故障
   文案、清空历史实机、托盘语言切换。**新增**：软件渲染器在 4K/高 DPI 大屏与
   截图全屏覆盖窗下的重绘手感复核（本轮单屏 1260×840 锁定会话）。
2. **渲染后端切换的用户裁决备案**：本轮按 M5 计划明示的"渲染后端切换…实测对比"
   权限实施并保留了 accessibility/UIA（不回退屏幕阅读器面）。若用户否决软件渲染器，
   回退 = `crates/cabin-app/Cargo.toml` slint 特性还原 + opt-level 移除（届时内存
   314MB 与体积 20.5MB 红线复挂，需另寻 GPU 路径方案）。
3. **opt-level z 备案**：14.88MB（再省 1.04MB）；`panic=abort` 备案：再省 ~1-2MB，
   行为风险见 §3。
4. 混合 DPI 副屏居中/覆盖窗漂移、负坐标多显示器选区（环境不可测，居中纯函数已
   含负坐标/超尺寸用例，实机待验）。
5. M2-M4 挂账原样保留项：launchAtLogin=true 残留复位（用户设置，未触碰）、
   execute_clicked 重跑 mutation 管线、rate_fetch_in_flight 泄漏（仅关机路径）、
   format-json 浮点分歧、CJK 导出字形、在线翻译同意 UI、启动冲突通知 UI、
   非-截图系统命令移植、图标 flake 家族（3 个 shell 管道测试）。
6. 击键延迟 <5ms 内部插桩复测（M4 挂账）：本轮外部口径 14-16ms 重复呼出无劣化
   迹象；严格 <5ms 裁决仍需内部插桩，未在本轮范围。
7. `%TEMP%\m5-bench\` 本轮证据目录（脚本/截图/JSON，~1MB）为易失数据，随
   m1-m4-bench 一并列入可清理尾项（m1-m4-bench 已按 M4 清单删除）。
8. 版本号 0.1.0 → 1.0.0 与发布流程属 M5 Task 6（本轮安装包按 workspace 版本
   0.1.0 命名，升级链路的版本门槛以 Task 6 后的正式 tag 为准）。

## 6. 验证过程备注

- 最终构建：`cargo build --release`（opt-level "s"），fmt / clippy workspace
  `-D warnings` / `cargo test --workspace` **628/628**（cabin-app 137、core 319、
  storage 36、platform-windows 68 regular + 2 live、platform 68）全部通过。
- 测量纪律：内存口径与 M3/M4 相同（`--command-cabin-login-startup` 出生隐藏，
  采样期可见窗 0）；热键/冷启动轮询粒度与 M4 相同（5ms/10ms）；全部数据轮保留
  （含 310ms AV 冷启动单点与 142ms 冷启动首跑，未剔除）。
- 原始数据留存 `%TEMP%\m5-bench\`（mem-final.json、extrawin-series.json、
  swrenderer/final 各 t-series、hotkey-final*.txt、cold-results.json、
  final-calc.png、sw-calc.png、各 stderr 日志）。
- 磁盘红线：`native/target` 已删除（峰值 10.5GB）；`native/artifacts/` 仅存
  release exe + Setup + .sha512 三文件（gitignored）；`%TEMP%` m1/m2/m3/m4-bench
  已删（M4 清单尾项）；仓库零新增大文件。
- 临时插桩剥除复核：源码 grep 零命中 + 最终二进制 `M5_PROBE` 字符串 0 处。
- 最终 exe SHA256：
  - `cabin-app-release.exe` = `a39d61bdb9bde386bf980844a79207e1d39ff24d7a09ac89dfae3357ad65e474`
  - `CommandCabin-Setup-0.1.0.exe` = `368c21dea8a56b5d3f096fb6e7bb458cf3875403e723b48c38f951fc3b067875`
