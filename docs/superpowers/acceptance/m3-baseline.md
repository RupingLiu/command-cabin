# M3 验收基线（截图标注 + OCR + 翻译 + 系统命令）

- 日期：2026-09-05
- 对象：`native/artifacts/cabin-app-release.exe`（2026-09-05 11:04:33 由
  `native/scripts/build.ps1 -Release` 全新构建产出，SHA256 `CF26B61F…F46918`，
  工具链 stable-x86_64-pc-windows-gnu / cargo 1.95，全量重建 12m16s、退出码 0；
  代码含 M3 全部九项任务：截图状态机/栅格化/导出/GDI 捕获+剪贴板/OCR+翻译客户端/
  覆盖窗/编排/i18n+系统命令。无测量插桩，全部外部观测）。二进制核实：含
  `system.screenshot.capture`（×3）、`CommandCabin Screenshot`、`Capture Screenshot`
  等标记字符串，PE 头 MZ/subsystem 正常。
- 环境：Windows 11 (10.0.26100) x86_64。**与 M2 两项环境差异，均须在对比时注意**：
  1. **交互桌面处于锁定状态**（`GetForegroundWindow()` 恒为 0，keybd_event 注入不可达，
     diag 脚本证据存档）——M2 依赖的物理按键注入（Alt+Space 呼出、Esc）本轮不可用，
     全部按键类验证改走 **WM_HOTKEY / PostMessage 消息仿真**与 `--command-cabin-login-startup`
     隐藏启动路径（见第 5 节方法论）。
  2. **会话桌面几何变化**：桌面现为 1260×840 物理像素（M2 记录 2560×1707 @150%；
     本轮覆盖窗枚举 rect (0,0)-(1260,840)，选区拖拽坐标按 2.0 缩放解释）。
     窗口居中等几何类结论本轮不可与 M2 直接比较。
  `%APPDATA%\CommandCabin` 状态沿用 M2 记录：DB 434,176 B（hotkey=Alt+Space、
  screenshotHotkey=Ctrl+Alt+A、delayedScreenshotHotkey=Ctrl+Alt+D、language=zh-CN、
  hideOnBlur=true、**launchAtLogin=true（M2 遗留，仍未复位）**）、app-icons.json
  2,208,362 B（暖态，mtime 未因本轮更新——启动器未真正渲染过列表）。
- 对照目标：spec 第 1 节（常驻空闲内存 < 60MB；热键呼出 < 150ms、冷启动 < 500ms；
  安装包 < 20MB）+ M3 计划新增红线（ureq HTTP 栈体积增量 < 1.5MB）。
- 原始数据：脚本/日志/截图留存于 `%TEMP%\m3-bench\`（mem-results.json、memory-run1/2.log、
  cold-results.json、hotkey-results.txt、hotkey-sim.log、debug-screenshot.log、
  launcher-search.png（PrintWindow 首页证据）、overlay-capture-phase.png、
  overlay-ready-toolbar.png、diag-inject.log 等）。

## 1. 量化指标（vs M2，均为外部口径）

| 指标 | 目标 | M2 实测（2026-09-04） | M3 实测（2026-09-05） | 结论 |
| --- | --- | --- | --- | --- |
| 可执行体积（安装包代理） | < 20MB | 17.05 MB（17,878,016 B） | **20.39 MB**（21,380,608 B，**+3.34MB**） | **不达标**（超出 0.39MB）。M3 增量构成见下行分解；安装包实测仍是 M5 事项 |
| └ ureq/rustls/ring HTTP 栈增量 | < 1.5MB（M3 计划红线） | —（M2 无 HTTP 栈） | **见注 1**（去 ureq 对照构建实测） | 见注 1 |
| 冷启动（外部观察：Start-Process → 首个可见窗口，10ms 轮询） | < 500ms（参考） | 2250（AV 首跑）/ 61.6 / 63.2ms，warm 中位 **63.2ms** | 120.0 / 56.0 / 64.3ms（首跑轻度 AV 惩罚），**中位 64.3ms** | 无回归。口径同 M2（正常启动自动呼出，端点=首个可见窗口） |
| `Measure-Command { Start-Process }`（仅进程创建） | 参考 | 16.7ms | 49.7ms | 参考值（环境噪声级差异，不构成回归结论） |
| 热键呼出（首次） | < 150ms | **17.1ms**（keybd_event 注入 Alt+Space → 可见窗口） | **32.1ms**（WM_HOTKEY 仿真 → 可见窗口，5ms 轮询） | 达标；口径差异见注 2，无回归迹象 |
| 热键呼出（再次 ×5） | < 150ms | 10.8–14.5ms | 14.5 / 14.9 / 15.3 / 15.4 / 16.0ms | 达标区间（同注 2 口径） |
| 截图热键 Ctrl+Alt+A → 覆盖窗 | M3 新增 | —（占位热键为 no-op，M3 T8 Critical 已修） | **127ms 覆盖窗出现**（WM_HOTKEY 仿真；含 launcher 隐藏 + 16ms settle + GDI 捕获 + 解码）；Esc 收束干净 | **通过**（T8 热键接线修复的端到端证据；物理按键仍是待人工） |
| 截图热键 Ctrl+Alt+D（延时 3s 模式） | M3 新增 | — | **3139.5ms** 覆盖窗出现（≥3000ms 延时正确）；Esc 收束干净 | 通过 |
| 常驻空闲内存（窗口隐藏，托盘驻留，WorkingSet64） | < 60MB | t0=9.6 → t10=223.4（平台期）→ t60=**223.3**（PB 165.8）→ t90=223.3MB | t0=5.5/10 → t10=**314.1/314.4**（平台期）→ t60=**314.0/314.3**（PB **218.9/219.3**）→ t90=313.8/314.1MB（两次运行） | **不达标，且较 M2 再恶化 +91MB WS / +53MB PB**；截图窗不驻留断言通过（见第 2 节），增量来自非窗口开销——接替图标水合成为 M5 头号收口项（注 3） |
| 空闲 CPU（90s 采样期累计） | 参考 | 0.95s（含索引/图标后台） | 0.44 / 0.41s | 确为空闲 |
| 参考：launcher 可见状态 WS 平台 | — | 未测 | 352.4MB（t90，仅一轮，方法学探索期数据） | 信息性记录 |

注：

1. **HTTP 栈分解（去 ureq 对照构建）**：对 `cabin-platform-windows` 做 `ureq` optional
   化 + `http_post_form` 桩（返回 Network 错误，不改其余代码）后全量 release 重建
   （11m54s、退出码 0），与官方产物差值即 ureq+rustls+ring(+webpki-roots 等) 的链接级
   贡献。实测差值 **1,594,880 B = 1.52MB**（官方 21,380,608 − 桩 19,785,728）→
   M3 计划红线 < 1.5MB **边缘超标约 0.02MB（1.4%；若按十进制 MB 口径则 1.59MB，超 6%）**。
   注意：桩分支同时省去了 `http_post_form`/`transport_is_timeout` 本体（数百字节级），
   真实 HTTP 栈贡献略低于 1.52MB——超线幅度在测量噪声边缘，如实记录为**贴线/边缘超标**，
   M5 打包时可随全局 size 手段（strip/LTO）一并复测。除 HTTP 栈外的 +3.34MB 增量构成：
   M3 功能代码与三个新 Slint 窗编译产物合计 **1,907,712 B = 1.82MB**（其中内嵌
   LiberationSans-Regular.ttf 410,712 B 为最大单项，其余为 GDI 捕获/剪贴板/保存对话框/
   OCR(WinRT 投影)/状态机/栅格化/合成导出代码段）。桩构建后已还原文件并复核字节一致，
   官方产物未受影响。
2. **热键口径差异**：M2 用 keybd_event 注入物理键序列（OS 键盘识别参与）；本轮桌面锁定
   注入不可达，改为向 global-hotkey 隐藏窗（类名 `global_hotkey_app`）PostMessage
   `WM_HOTKEY`（wParam=注册 id，id 公式 `mods<<16|code` 经 vendored 源码推导：
   Alt+Space=65598、Ctrl+Alt+A=589843、Ctrl+Alt+D=589846；lParam 按 RegisterHotKey 约定）。
   该路径与 OS 投递的唯一差异是省去物理键识别（本就是遗留待人工项），应用侧
   注册表→WndProc→事件通道→pump→handler→动作 全链路真实走通。数字为上界、含 ≥5ms
   轮询粒度，与 M2 仅可做趋势比较：同量级、无回归迹象。前台归属断言（M2 有）在锁定桌面
   下不可测（fgPid 恒 0）。
3. **内存方法论与 M2 的差异**：M2 为“正常启动自动呼出 → t+2s 热键 toggle 隐藏”；本轮因
   桌面锁定改为 **`--command-cabin-login-startup` 启动（注册热键/托盘、跳过自动呼出）**，
   从进程出生即处于“窗口隐藏、托盘驻留”的同一目标状态，且全程无注入干扰。每次采样同时
   枚举四类标题窗口（CommandCabin / Screenshot / Pin / Translate），**launcher=0、
   screenshot=0、pin=0、translate=0 贯穿 t10–t90**——即增长与截图窗驻留无关（M3 计划
   要求的验证点，通过）。平台期 t10 即到达（同 M2）。嫌疑构成（未逐一归因，M5 根因分析）：
   截图控制器/会话缓冲预置、GDI+/图像解码器加载、三个新增隐藏窗口及其 Slint 组件树、
   OCR/WinRT 初始化、内嵌字体。M2 的图标水合嫌疑依然在列。

## 2. 功能验收清单

自动化可覆盖项已实测（含消息仿真路径）；需真实键鼠或需解锁桌面交互的项标“待人工”。
截图证据见 `%TEMP%\m3-bench\`。

| 项 | 结果 | 证据 / 说明 |
| --- | --- | --- |
| 第二实例静默退出 | 通过 | 主实例存活时启动第二实例：10s 内退出、退出码 0、主实例仍存活、无诊断输出（同 M2） |
| 设置 DB 文件 | 通过（文件级） | 434,176 B，头 16 字节 `SQLite format 3\0`；strings 抽到含 screenshotHotkey/delayedScreenshotHotkey 的完整 settings JSON |
| Ctrl+Alt+A 区域截图（热键→覆盖窗） | 通过（消息级） | WM_HOTKEY 仿真：覆盖窗 127ms 出现、launcher 同步隐藏、Esc 后覆盖窗消失、进程存活无 panic（见 §1 注 2）；**真实按键按压仍待人工**（M2 起积累的 beta 前清单项） |
| Ctrl+Alt+D 延时截图 | 通过（消息级） | 3139.5ms 出现覆盖窗（延时 3000ms + 捕获），Esc 收束干净 |
| 覆盖窗捕获管线（GDI 捕获→底图渲染） | 通过 | debug 路径（COMMAND_CABIN_DEBUG_SCREENSHOT=1，+1.5s 自触发）：覆盖窗 +1693.6ms 出现（=1.5s 触发点 + 16ms settle + 捕获/解码），PrintWindow 截图可见全屏暗化底图；stderr 0 字节（无 panic） |
| 指针选区（PostMessage 拖拽） | 部分（视觉） | PostMessage WM_LBUTTONDOWN/MOVE/UP 驱动后 PrintWindow 截图可见**红色选区框**（坐标按 2.0 缩放解释——锁定会话 1260×840 桌面的缩放环境差异，非代码问题）；**六工具工具栏未在无头拖拽中渲染**（T7 报告同类限制），工具栏/标注交互全链路待人工 |
| Esc/Enter 出口 | 通过（消息级） | 覆盖窗 Esc=取消（三轮验证：WM_HOTKEY 两轮 + debug 路径一轮），会话收束、launcher 恢复、进程存活；Enter=完成复制出口由 T7 冒烟覆盖（本环境未重跑 Enter，风险低） |
| 六工具/撤销重做/文字/马赛克/保存 png/jpg/复制粘贴 | 待人工 | 需真实键鼠（锁定桌面不可达）；逻辑层由 T1 状态机 134 测试、T2 栅格化像素测试、T3 导出/几何测试、T7/T8 单测覆盖 |
| OCR（zh-CN/en 可用性两路） | 待人工（有佐证） | T6 真机测试含真实 OCR 往返与语言可用性两路；本轮覆盖窗内 OCR 面板交互不可无头驱动 |
| 翻译同意门（fail-closed，无网络外发） | 通过（代码级） | `ONLINE_TRANSLATION_CONSENTED` AtomicBool 默认 false、**全仓无 setter**（仅声明+load 两处）→ 在线翻译路径在 M3 不可达、不发生 OCR/外发；未同意时返回 TS 逐字三语 consent 文案（i18n 测试 `screenshot_translation_online_consent_matches_ts` + 门测试 `online_translation_gate_denies_until_consented`） |
| 翻译（在线，含超长/空拒绝消息） | 待人工 | 网络路径依赖 M5 同意 UI（M3 无 setter）；超长/空/同语言短路的纯函数解析由 T6 测试覆盖（200,031 例差分模糊零失配） |
| 置顶图窗 | 待人工 | 入口在覆盖窗工具栏按钮，需交互；T8 单测覆盖等比缩放/落位 |
| 系统命令在搜索可见（system.screenshot.*） | 待人工（代码级通过） | 启动时装入命令表+引擎（main.rs，T9 评审通过）：四条命令 id/标题/关键词（含“截图/截圖/screenshot”）逐字移植且有测试锁定。**无头打字验证失败**：锁定桌面无 OS 焦点，PostMessage WM_CHAR 被丢弃（实验证据 `%TEMP%\m3-bench\launcher-search.png` 仍为占位符首页）——搜索 UI 端到端需解锁桌面人工复验 |
| 空查询首页（recent 组/图标/zh-CN 文案） | 通过 | PrintWindow 截图：占位符“搜索应用、命令…”、“最近使用”分组、MATLAB R2025b/ZCANPRO 行含图标与副标题、首行选中高亮（M2 视觉项在本轮等效复验） |
| 启动器 Esc 隐藏 | 通过（消息级） | PostMessage WM_KEYDOWN Esc → launcherVisible 1→0（两个会话复验） |
| 启动器热键 toggle 隐藏/呼出 | 通过（消息级） | WM_HOTKEY 仿真 6/6：首次隐藏 72.3ms、呼出 32.1ms、重复 14.5–16.0ms（§1） |
| 启动器热键设置变更后的位移回滚 | 待人工 | 设置 UI 交互项；T8 决策表纯函数 14 测试（含 swap/失败回滚/registry 轨迹）+ `screenshot_mode_to_field` 回归测试覆盖逻辑层 |
| hideOnBlur 不作用于截图会话 | 通过（代码级+旁证） | T7 会话门控 + T8 `session_active` 短路；本轮截图会话存续期间未见异常隐藏（覆盖窗在会话期持续可见） |
| launchAtLogin 注册表残留 | 不通过（遗留未收口） | DB launchAtLogin=true → HKCU Run 值仍存在且指向 artifacts exe（M2 遗留项原样持续，默认态“不存在”仍无法无头验证） |
| 磁盘红线 | **不通过（两项）** | ① `native/artifacts/cabin-app-debug.exe` **444,106,437 B（约 423.5MB）** 历史调试产物仍在（M2 时 352MB 已挂账，本轮又增 92MB）；② `native/target` 在本轮验收的对照构建期间临时存在（验收收尾时已还原官方产物并删除，复核见第 5 节）；`%TEMP%` 另有 m1/m2/m3-bench 与 cabin-smoke 残留（均为可清理临时基准数据） |

## 3. 新发现问题（随基线记录）

1. **exe 体积突破 20MB 红线（17.05 → 20.39MB，+3.34MB）**：M3 计划红线“ureq HTTP 栈
   < 1.5MB”实测 **1.52MB（边缘超标 ~0.02MB）**；其余增量 **1.82MB** 为 M3 功能代码
   （内嵌导出字体 401KB 为最大单项）。若无 HTTP 栈（18.87MB）本可在 20MB 内——M5 打包时
   以 strip/LTO/安装包实测收口，并顺带复测贴线的 HTTP 栈份额，Slint 水印/许可一并评估。
2. **常驻空闲内存再恶化：223.3 → 314.3MB WS（+91MB），PB 165.8 → 219.3MB（+53MB）**。
   M3 计划验证点“截图窗不驻留时应无增量”的**窗口部分通过**（四类截图相关窗口全程 0），
   增量来自非窗口开销；t10 即达平台期（同 M2）。接替“图标水合嫌疑”成为 M5 头号收口项，
   根因分析须覆盖：截图会话预置缓冲、GDI+/解码器、三个隐藏 Slint 窗组件树、OCR/WinRT、
   内嵌字体。目标仍 < 60MB。
3. **锁定桌面环境限制**：本轮 GetForegroundWindow 恒 0、keybd_event 不可达（M2 方法论
   大范围失效）。已用 WM_HOTKEY/PostMessage/PrintWindow/login-startup 四件套替代并产出
   等效证据，但**真实键鼠全链路**（物理 Ctrl+Alt+A/D 按压、六工具标注、保存对话框、
   置顶窗拖动、设置 UI 热键位移回滚、搜索“截图”UI 端到端）只能留待人工——为 beta 前清单
   的硬性项，不是新缺陷。
4. **artifacts 目录 423.5MB 调试产物**（cabin-app-debug.exe，M2 时 352MB → 现 444,106,437 B，
   M3 各任务 debug 构建持续复写）：磁盘红线挂账项继续恶化，建议 M5 收口时删除
   （build.ps1 的 -Test/-Debug 产物管理值得一并裁决）。
5. **会话桌面几何与缩放环境变化**（1260×840、覆盖窗 scale 2.0 vs M2 的 2560×1707@150%）：
   窗口居中、负坐标显示器选区等几何类验收本轮**不可测且不可与 M2 比较**（M3 T7 已挂账的
   混合 DPI 副屏漂移问题在单屏环境无从复现）；恢复多屏/高分辨率环境后需复验。
6. 构建/产物核实：全新构建 12m16s、退出码 0；产物含 M3 标记字符串；官方 release 产物
   SHA256 `CF26B61F…F46918`（mtime 11:04:33）与对照构建期间未被触碰（对照构建只写
   target/，验证后已还原源文件并重建复核）。

## 4. M5 收口清单（承接 M1/M2 + M3 新增）

- [ ] **常驻空闲内存 < 60MB —— M2 223 → M3 314MB，连续恶化**（本轮新增嫌疑：截图栈
      非窗口开销；图标水合嫌疑保留。头号项）
- [ ] **exe/安装包 < 20MB**：exe 代理 20.39MB 首次超标（HTTP 栈 1.52MB 贴红线
      边缘超标 ~0.02MB；其余 1.82MB 为 M3 功能代码与 401KB 字体）；M5 打包时以 strip/LTO/
      安装包实测收口，Slint 水印/许可一并评估
- [ ] **真实键鼠人工清单（beta 前硬性）**：物理 Ctrl+Alt+A/D 按压→覆盖窗→Esc；六工具
      标注+撤销重做+文字/马赛克效果；保存 png/jpg 对话框（过滤器/覆盖/取消）；复制→粘贴
      PNG 验证；OCR 面板两语言路+复制全部；置顶图窗拖动/保存/复制/多实例；设置流截图
      热键位移回滚实机演练；搜索“截图/OCR”四入口 UI 端到端执行
- [ ] **在线翻译同意 UI**（M3 fail-closed：AtomicBool 无 setter，在线路径不可达；M5 补
      Slint 确认弹层或设置项后翻译路径才可达，含超长/空/失败消息实机复验）
- [ ] 呼出窗口屏幕居中（本轮环境不可测；M2 起挂账）+ 混合 DPI 副屏 overlay 逻辑坐标漂移
      （T7 挂账）+ 负坐标多显示器选区复验（本轮单屏 1260×840 无法覆盖）
- [ ] 启动冲突通知仅 stderr（T8 Minor，无 UI 面）；启动期重复 accelerator 位移语义 vs
      TS plain register+冲突通知（T8 Minor）
- [ ] CJK 导出字形缺失静默跳过（T3 Important：系统字体回退或 CJK 子集字体裁决）；
      导出 z-order 与 TS 严格列表序的分歧裁决（T3 Minor）
- [ ] 非-截图系统命令（open-settings/copy-version）移植裁决 + 首页空查询是否列出系统命令
      （T9 范围注记）
- [ ] M3 挂账的性能/视觉小项：compose_base O(像素×屏) 与每 draft 帧克隆（4K 重选区欠账）、
      OCR 面板 176px elide vs TS wrap、尺寸徽章位置（TS 上方）、放大镜未移植、
      OCR 结果 LRU/串行队列未移植（busy 守卫自限）
- [ ] launchAtLogin=true 残留复位 + 自启动“默认不存在”复验（M2 起挂账）
- [ ] M2 人工清单余项（pinned 组视觉、UWP 图标在列、历史加成端到端排序、设置修改跨重启
      持久化、托盘语言切换）
- [ ] artifacts 423.5MB debug 产物清理 + %TEMP% m1/m2/m3-bench 清理（磁盘红线）
- [ ] （可选）恢复内部时间戳插桩复核冷启动/呼出内部值

## 5. 验证过程备注

- **方法论四件套（本轮因桌面锁定自建，脚本全部留存 `%TEMP%\m3-bench\`）**：
  1. `--command-cabin-login-startup` 启动 → 出生即“窗口隐藏+托盘驻留”态（内存口径，
     替代 M2 的热键 toggle 隐藏法；条件等价、无注入干扰，launcher 全程 0 可证）。
  2. **WM_HOTKEY 仿真**：向 global-hotkey 隐藏窗（类名 `global_hotkey_app`）PostMessage，
     id 公式与 lParam 约定经 vendored global-hotkey 0.6.4 / keyboard-types 0.7.0 源码推导
     （`id = mods.bits()<<16 | Code枚举序`；ALT=0x01、CONTROL=0x08、Space=62、KeyA=19、
     KeyD=22）。仿真使注册→WndProc→通道→pump→handler 全链路真实执行，仅省 OS 物理键识别。
  3. **PostMessage 指针/按键**：覆盖窗拖拽选区（WM_LBUTTONDOWN/MOVE/UP）、Esc
     （WM_KEYDOWN/UP）——T7 冒烟技术的延续。
  4. **PrintWindow(PW_RENDERFULLCONTENT) 窗口成像**：锁定桌面下 CopyFromScreen 只能拍到
     锁屏壁纸，PrintWindow 可对会话窗口成像（首页视觉证据即由此取得）；WM_CHAR 打字
     被丢弃（无 OS 焦点），故搜索 UI 端到端不可无头化。
- 首轮内存采样曾按 M2 法（正常启动+热键隐藏）尝试，因注入不可达失败；失败运行的数据
  （launcher 可见 352MB 平台期）作为信息性记录保留在 mem-run0（`memory-run1.log` 顶部）。
- 一次脚本缺陷导致的应用实例残留（search-capture2 中途崩溃未清理）已定位并终止；
  其后一次新实例因残留占用 Alt+Space 而启动期退出——顺带再次印证“launcher 热键注册
  失败即退出”的 M2 语义在 M3 仍然生效（预期行为，非缺陷）。最终无 cabin-app 进程残留。
- **对照构建（ureq 分解）文件处置**：仅临时修改 `cabin-platform-windows/Cargo.toml` 与
  `src/translate.rs`（均有备份，改动以 `[T10 SIZE PROBE]` 注释标记）；测量后从备份还原、
  重新增量构建并核对官方产物大小一致，`native/target` 已删除，复核无残留。
- 未执行 git commit（按要求，变更留在工作区；本轮对仓库源码的净改动为零——两处探针
  修改已原样还原）。
