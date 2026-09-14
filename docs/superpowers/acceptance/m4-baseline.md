# M4 验收基线（计算器 / 剪贴板历史 / 文本工具 / 快速转换 / 即时命令接线）

- 日期：2026-09-05
- 对象：`native/artifacts/cabin-app-release.exe`（2026-09-05 22:29 由
  `native/scripts/build.ps1 -Release` 全新构建产出，SHA256
  `bec62021…e04fa8`，工具链 stable-x86_64-pc-windows-gnu / cargo 1.95，全量重建
  13m52s、退出码 0；代码含 M4 全部八项任务：计算器、剪贴板仓储+命令、读取 trait+轮询、
  文本工具、快速转换静态、汇率缓存+货币动态、即时动态命令接线、i18n/设置收尾。
  无测量插桩，全部外部/消息级观测）。二进制核实：含 `calculator.result`、
  `quick-converter.result`、`clipboard-history.entry`、`text-tools.uppercase`、
  `text-tools.format-json`、`text-tools.url-decode`、`frankfurter`、
  `exchange-rates.json` 等标记字符串，PE 头 MZ 正常。
- 环境：Windows 11 (10.0.26100) x86_64。**交互桌面本轮处于"锁屏覆盖"态**
  （`GetForegroundWindow()` 返回 LockApp 窗口而非 0，与 M3 的"安全锁定 FG=0"不同）：
  1. **物理按键/鼠标注入（keybd_event/SendInput）被 UIPI 静默丢弃**（实验证据：注入
     Alt+Space 后注册热键不触发、前台保持 LockApp）——M2 物理注入法仍不可用。
  2. **剪贴板对后台进程整体关闭**：`OpenClipboard` 恒返回 err=5（拒绝访问）、
     `GetOpenClipboardWindow` 为空；应用自身的 watcher 轮询同样周期性报
     "held by another party"（stderr 翻转沿日志为证）。**外部 Set-Clipboard 注入
     45s 重试全程失败**。剪贴板类端到端（复制注入→pick 回写→粘贴验证）本轮不可无头化。
  3. **方法论升级（本轮关键突破）**：M3 只试过 `WM_CHAR`（被丢弃）；本轮实测
     **PostMessage `WM_KEYDOWN/WM_KEYUP`（VK + lParam 扫描码）可真实驱动 Slint
     LineEdit 输入**——查询打字、Enter 执行、Esc 隐藏全部消息级可驱动，M3 的
     "搜索 UI 端到端不可无头化"结论在本轮被推翻并升级为可复现工具（脚本留存）。
  4. 会话桌面几何仍为 1260×840 单屏（同 M3），几何类结论不可与 M2 比较。
  `%APPDATA%\CommandCabin` 沿用既有状态：DB 434,176 B（hotkey=Alt+Space、
  screenshotHotkey=Ctrl+Alt+A、delayedScreenshotHotkey=Ctrl+Alt+D、language=zh-CN、
  hideOnBlur=true、**launchAtLogin=true（M2 遗留，仍未复位）**）、app-icons.json
  2,208,362 B、exchange-rates.json 122 B（Electron 时代遗留，fetchedAt 2026-06-08，
  本轮验收中被原生端重写，见 §2 货币项）。
- 对照目标：spec 第 1 节（常驻空闲内存 < 60MB；热键呼出 < 150ms、冷启动 < 500ms；
  安装包 < 20MB）+ M4 计划性能项（每击键延迟增量 < 5ms，抽样记录）。
- 原始数据：脚本/日志/截图留存于 `%TEMP%\m4-bench\`（mem-results.json、cold-results.json、
  hotkey-results.txt、watch-results.txt、second-instance.txt、startup-anatomy.txt、
  mem-stderr.log、keydown-test.png、calc-before-enter.png、calc-timed.png、
  calc-timed2.png、converter-static.png、currency-t0.png、texttool-*.png 等）。

## 1. 量化指标（vs M3，均为外部/消息级口径）

| 指标 | 目标 | M3 实测（2026-09-05，锁屏 FG=0） | M4 实测（2026-09-05，锁屏 LockApp 前台） | 结论 |
| --- | --- | --- | --- | --- |
| 可执行体积（安装包代理） | < 20MB | **20.39 MB**（21,380,608 B） | **20.54 MB**（21,532,672 B，**+152,064 B ≈ +0.15MB**） | **不达标**（超出 0.54MB）。M4 四个功能模块 + 动态接线仅增 0.15MB（无新重依赖，符合预期）；<20MB 仍是 M5 strip/LTO/安装包实测收口项 |
| 冷启动（外部观察：Start-Process → 首个可见窗口，10ms 轮询） | < 500ms（参考） | 120.0 / 56.0 / 64.3ms，中位 **64.3ms** | 719 / 471 / 376 / 474 / 530 / 605 / 437ms（7 轮），中位 **474ms** | **数值大幅走高，但环境不可比 + 机理指向渲染而非启动逻辑**，见注 1；M5 须在可比桌面态复测后再下回归结论 |
| └ 启动解剖（补充探针） | — | 未测 | 窗口创建（含隐藏窗）**80ms**；进程创建 47.3ms；**可见 705ms**；首 1.9s CPU **0.81s** | 增量在 show 后首帧（GPU/合成器路径），非启动期逻辑（注 1） |
| 热键呼出（WM_HOTKEY 仿真 → 可见窗口，5ms 轮询） | < 150ms | 首次 **32.1ms**；重复 14.5–16.0ms | 首次 **43ms**；重复 **15 / 15 / 17 / 15 / 15ms** | 达标；与 M3 同口径同量级，无回归。物理按键注入仍不可达（UIPI），前台归属断言不可测（fg=LockApp） |
| 常驻空闲内存（--command-cabin-login-startup，窗口隐藏，托盘驻留，WorkingSet64 / PrivateMemorySize64） | < 60MB | t60=**314.0/314.3** WS（PB **218.9/219.3**） | t0=74.7/53.9 → t10=**314.6**/219.6（平台期）→ t60=**314.6/219.4** → t90=314.3/219.4MB | **不达标（目标 <60MB），但较 M3 持平（+0.3~0.6MB WS / +0.1~0.5MB PB，噪声级）**——M4 新增 watcher 定时器、剪贴板命令、动态命令槽、汇率缓存**未再推高平台期**；314MB 根因分析仍是 M5 头号收口项（嫌疑清单不变，M4 因素可基本排除） |
| 空闲 CPU（90s 采样期累计） | 参考 | 0.44 / 0.41s | **0.44s** | 确为空闲（watcher 1s 轮询未产生可测开销） |
| 每击键延迟增量（M4 计划项；WM_KEYDOWN → PrintWindow 像素变化，4ms 轮询） | < 5ms 增量 | —（无此口径） | "1+2*3" 5 键：21/18/21/19/22ms；"74258" 6 键：23/22/18/**532**/20/19ms | **外部口径无法严格验证 <5ms**：本口径含 PrintWindow 采样+哈希开销（≥15–20ms/帧），典型值 18–23ms 即为上界；532ms 单点离群疑似图标水合重渲染落入采样窗（未归因实锤）。结论：击键管线上界与 M2/M3 渲染路径同量级、无可观测劣化；**严格 <5ms 需内部插桩，列入 M5**（见 §2 末行） |

注：

1. **冷启动口径不可比 + 机理拆解**：M3 的 64.3ms 测于"安全锁定（FG=0）"会话；本轮为
   "锁屏覆盖（LockApp 前台）"会话，DWM/GPU 合成路径真实参与首个可见帧。启动解剖显示
   **窗口与事件循环 80ms 即就绪**（与 M3 同量级），70x 差值全部发生在 `show()` 之后到
   首帧可见之间（含 focus_window 与 5 个急切创建的 Slint 窗的首帧 GPU 初始化；
   1.9s 内 CPU 0.81s 亦与此相容）。二次呼出重复实测 15–17ms（热键行），说明一次性
   首帧成本而非每击键/每呼出劣化。**本轮不给"冷启动回归"定论**，M5 须在真实桌面
   （解锁、无锁屏覆盖）复测并与 M2 口径（63.2ms）对齐比较。
2. **内存口径延续 M3**：`--command-cabin-login-startup` 出生即"窗口隐藏+托盘驻留"，
   全程无注入干扰；采样期枚举确认 launcher/screenshot 可见窗全程 0（急切创建的
   CommandCabin / CommandCabin Screenshot / 设置三窗均隐藏）。**M4 增量≈0 的正面结果**
   ：watcher 定时器（1s）、剪贴板命令组（200 条上限）、动态槽与汇率缓存均在既有
   314MB 平台期精度内。314MB 本身的根因（截图栈非窗口开销、图标水合等 M3 嫌疑清单）
   仍未收口，维持 M5 头号项。
3. **热键仿真口径**：同 M3 §1 注 2（向 `global_hotkey_app` 隐藏窗 PostMessage
   WM_HOTKEY，Alt+Space id=65598，注册→WndProc→通道→pump→handler 全链路真实）。
   本轮补充实验：keybd_event/SendInput 注入在 LockApp 前台态被 UIPI 丢弃（M2 物理注入
   法在当前锁屏形态下不可用），故无 M2 口径对照数字。

## 2. 功能验收清单

自动化可覆盖项已实测（消息级 = WM_HOTKEY + PostMessage WM_KEYDOWN + PrintWindow 成像）；
需真实键鼠、解锁桌面或可写剪贴板的项标"待人工"。截图证据见 `%TEMP%\m4-bench\`。

| 项 | 结果 | 证据 / 说明 |
| --- | --- | --- |
| 第二实例静默退出 | 通过 | 主实例存活时启动第二实例：**152ms 退出、主实例仍存活、stderr 0 字节**（另有手工探针验证退出码 0） |
| 计算器 "1+2*3" → "7" 复制 | **通过（消息级）** | WM_KEYDOWN 打字后 PrintWindow 截图：输入 "1+2\*3"、**首行选中 "7 / Copy result to clipboard"**（动态命令位列第一，与管线测试一致）；Enter 后 stderr 实证执行链：`command execution failed: Failure { command_id: "calculator.result", action_type: CopyText, … "The native clipboard is not accessible…" }`——查询→动态命令生成→首行选中→Enter→执行器 CopyText 全链路真实走到 OS 剪贴板写入，**被锁屏态 OS 拒绝**（环境限制，非代码缺陷）；实际复制→粘贴验证待人工（解锁桌面） |
| 计算器裸数字恒等（附加） | 通过（消息级） | "74258" → 首行 "74258 / Copy result to clipboard"（ECMA toString 恒等格式） |
| "10cm" 即时转换（静态） | **通过（消息级）** | 首行 "10 厘米 = 100 毫米 = 0.1 米 = 3.93701 英寸"（TS 标题格式逐字；"1024 mb to gb" 非本插件查询形态——无数据单位别名，简报"或 TS 样例查询"以 "10cm" 实测） |
| 文本工具三入口（uppercase / format-json / url-decode） | **通过（消息级，浮现）** | 三张截图：查询 "uppercase"/"format json"/"url decode" 均以对应命令为选中首行（"Text: Uppercase / Convert text to uppercase"、"Text: Format JSON / Format JSON with indentation"、"Text: URL Decode / URL decode text"，TS 标题/副标题逐字） |
| └ 文本工具执行 + url-decode 故障消息 | 待人工（有执行链佐证） | Enter 执行 uppercase 实证 run-system 分支可达：`command execution failed: Failure { command_id: "text-tools.uppercase", action_type: RunSystem, … clipboard not accessible }`（pluginId 校验通过、读剪贴板被 OS 拒绝）；**变换成功回写与故障逐字消息**（"Invalid JSON: …"/"Invalid URL encoded text: …"）需解锁桌面人工复验，逻辑层由 T4 单测逐字节锁定 |
| 剪贴板复制 → 1s 内历史浮现 → pick 回写 | **部分（watcher 落库实证 + 注入受阻）** | **live 落库证据**：watcher 首次成功轮询把当前剪贴板原文写入 DB——row 5668 `copied_at=2026-09-05T14:39:39.000Z`（恰为验收实例 t+90s 内"read recovered"窗口），且此后 ~15 分钟同文本轮询**零重复行**（去重语义 live 生效）、表总数恒 200（prune 上限 live 生效）；stderr 翻转沿日志证明 1s 定时器持续在拍。**外部复制注入不可行**：Set-Clipboard 45s 重试全失败（OpenClipboard err=5，锁屏态 OS 拒绝后台进程）→ "外部复制后 ≤1s 浮现"与 "pick 回写"待人工；间隔/去重/落库逻辑由 watcher 单测 + `clipboard_watch_poll_saves_new_texts_to_repository` 集成测试 + T7 isolated-APPDATA 冒烟覆盖 |
| 清空剪贴板历史（设置 UI） | 待人工 | 入口仅在设置窗口（托盘菜单 → 设置），锁屏态托盘交互不可达；仓储半步 `clear()` 由集成测试覆盖（清空后归零断言），设置流错误文案（clearError 三语）由 i18n 键覆盖 |
| 货币查询（在网，live 端点） | **通过（消息级）** | 查询 "100 usd"：截图首行 "100 美元 ≈ 671.27 人民币 / 缓存汇率 · 更新时间 2026-09-05"；**`%APPDATA%\CommandCabin\exchange-rates.json` 于 22:46:42 被原生端重写**（fetchedAt 2026-09-05T14:46:42Z、rate 6.7127、provider Frankfurter，形状逐字、无临时文件残留 = 原子写生效）——即 stale 缓存（Jun-8 的 6.7693）先行出命令 + 后台 frankfurter.dev 取数 + ingest 落盘 + 重渲染全链路 live 走通。（"旧值先行显示"瞬态帧未单独截图——取数在成像前完成，语义由单测锁定；重渲染后副标题按 source=Cache 显示"缓存汇率"，与实现语义一致） |
| 货币查询（离线降级） | 待人工（代码级通过） | 无缓存→本次无命令+触发后台刷新、取数失败→缓存不变下次重试、转换不可用消息逐字，均由 T6/T7 单测锁定；锁屏态无法安全制造断网环境，未做 live 演练 |
| 汇率缓存 TTL/形状/原子写 | 通过（文件级+单测） | 重写后文件形状逐字（122 B 四字段）；目录无 .tmp 残留；TTL 1h/损坏文件/原子写为 T6 单测锁定项 |
| 启动器 Esc 隐藏 | 通过（消息级） | PostMessage WM_KEYDOWN Esc → launcherVisible → 0（本轮复验；M3 同项结论维持） |
| 启动器热键呼出/隐藏 toggle | 通过（消息级） | WM_HOTKEY 仿真 7/7 成功（首次 43ms + 隐藏 + 重复 5 轮，§1） |
| M3 功能不回归（截图/OCR/翻译/设置承载） | 通过（承载面） | M3 全部窗口/控制器随 M4 重构存续：截图热键注册路径未变（启动无冲突告警）、内存采样期四类窗零可见驻留、设置窗口创建正常（"设置"标题在枚举中）。截图标注全链路维持 M3 结论（本轮未重测，无相关改动） |
| 每击键延迟增量 < 5ms | 待人工（外部上界已记录） | §1 末行：外部口径 18–23ms 为含采样开销的上界，严格 <5ms 需内部插桩（M5）；代码层论据：动态槽=两个纯函数解析 + engine upsert/remove，与 M2/M3 渲染同路径 |
| launchAtLogin 注册表残留 | 不通过（遗留未收口） | DB launchAtLogin=true 原样持续（M2 起挂账，本轮未触碰设置） |
| 磁盘红线 | **通过（本轮处置后）** | `native/target` 不存在（build.ps1 构建后自动清除）；**`cabin-app-debug.exe`（446,882,024 B ≈ 426.3MB，M4 各任务 debug 构建复写产物）已在本轮验收中删除**；artifacts 现仅存 release exe 一个文件。`%TEMP%` 残留 m1/m2/m3/m4-bench 共约 8MB（790K/4.9M/1.8M/601K，可清理基准数据，M5 收口时一并裁决） |

## 3. 新发现问题（随基线记录）

1. **冷启动外部数字走高（中位 474ms vs M3 64.3ms）——本轮不下回归定论**：桌面态
   不可比（安全锁定 vs 锁屏覆盖）且启动解剖把增量定位于 show→首帧（GPU/合成器），
   启动逻辑 80ms 不变。M5 必须在真实桌面复测；若届时仍 >500ms 红线，嫌疑集中在
   5 窗急切创建 + 首帧渲染路径（惰性创建/首帧简化为候选手段）。
2. **exe 体积 20.54MB（+0.15MB），红线未收口**：M4 四功能+接线的体积代价仅 0.15MB
   （无新重依赖），说明增量管理有效；但 20MB 红线连续两轮超标，M5 strip/LTO +
   安装包实测是唯一收口路径（M3 拆解显示仅 ureq 栈就占 1.52MB）。
3. **常驻内存 314MB 平台期精确持平（+0.3~0.6MB）**：M4 因素（watcher/剪贴板命令/
   动态槽/汇率缓存）可从 314MB 根因嫌疑清单中**基本排除**——根因收窄至 M3 已列
   嫌疑（截图栈非窗口开销/图标水合/Slint 组件树/内嵌字体/OCR WinRT）。M5 头号项
   的排查面因此变小，这是本轮最有信息的负面结果之一。
4. **锁屏覆盖态的两项 OS 拒绝**（物理注入 UIPI 丢弃 + 剪贴板后台关闭）：比 M3 的
   "FG=0"多探明一层环境行为，剪贴板拒绝同时影响测量进程与应用自身（stderr 互证）。
   全部剪贴板端到端与物理键鼠清单继续 待人工，解锁桌面后按 §2 表复验。
5. **方法学升级：WM_KEYDOWN 消息级打字**（M3 只试 WM_CHAR 而误判"搜索 UI 不可
   无头化"）：VK+lParam 扫描码可驱动 Slint LineEdit，查询/Enter/Esc 全链路消息级
   可驱动。M5 人工清单中"搜索 UI 端到端"项可用此法先行无头复验，人工只保留
   真实键鼠手感与前台归属断言。注意坑：标点须按 VK 表映射（'.'≠0x2E——那是
   VK_DELETE，本轮踩过）。
6. **击键延迟 532ms 单点离群未归因**：疑似图标水合 on_extracted → UI 线程重渲染
   落入采样窗（与 M2 已挂账的"击键重复入队图标任务"同族）；不影响功能，M5 插桩
   时一并核实。
7. 构建/产物核实：全新构建 13m52s、退出码 0；产物含全部 M4 标记字符串；本轮对
   仓库源码净改动为零（仅新增验收文档），无测量插桩残留。

## 4. M5 收口清单（承接 M1/M2/M3 + M4 新增，已与 M3 清单去重）

- [ ] **常驻空闲内存 < 60MB**：M2 223 → M3 314 → **M4 314（持平）**；M4 因素排除，
      根因收窄至截图栈非窗口开销/图标水合/Slint 窗组件树/内嵌字体/OCR WinRT
      （头号项，排查面已收窄）
- [ ] **exe/安装包 < 20MB**：M3 20.39 → **M4 20.54MB**（M4 增量仅 0.15MB）；M5 打包
      以 strip/LTO/安装包实测收口（ureq 1.52MB 贴线份额、Slint 水印/许可一并评估）
- [ ] **冷启动复测（新）**：真实桌面（解锁）下重测 Start-Process→可见；若仍 >500ms，
      排查 5 窗急切创建 + 首帧 GPU 路径（M3 的 64.3ms 与本轮 474ms 的桌面态差异须
      一并厘清）
- [ ] **真实键鼠人工清单（beta 前硬性，M3 项 + 本轮新增剪贴板项）**：物理
      Ctrl+Alt+A/D 按压、六工具标注/保存/置顶全链路、设置流热键位移回滚实机、
      M3 人工余项照旧；**新增**：外部复制 → 剪贴板历史 ≤1s 浮现 → pick 回写 →
      粘贴验证；计算器/快速转换 Enter 复制 → 粘贴核对结果；文本工具三变换回写 +
      format-json/url-decode 故障消息实机；设置窗口"清空历史"实机（成功无消息/
      失败 clearError 文案）
- [ ] **货币离线路由实机复验（新）**：断网/端点不可达下的 无缓存→无命令、失败→缓存
      不变、unavailable 消息（单测已锁，缺 live 演练）
- [ ] **击键延迟 <5ms 目标内部插桩复测（新）**：外部口径（含采样开销上界 18–23ms、
      532ms 单点离群）不足以裁决；顺带核实图标水合重渲染与击键的交错（M2 挂账同族）
- [ ] **[radar→M5] execute_clicked 重跑 mutation 管线**（M4 T7：TS 是 registry 查找；
      幂等但 repo 变化后点击静默无效）
- [ ] **[M5] rate_fetch_in_flight 泄漏**（invoke_from_event_loop 失败时恒 true，
      仅关机路径）
- [ ] **[radar] 图标 flake 家族**（3 个 shell 管道测试无重试，0x8000000A 同型；M4
      T3/T7 两次挂账）
- [ ] **[M5] format-json 浮点格式化分歧收口**（整型浮点 100.0 vs JS 100、e29 vs
      e+29；可用 calculator 的 Number::toString 移植关闭）+ 粘性正则回退在畸形 JSON
      上错误细节分歧（已文档化，裁决是否对齐）
- [ ] CJK 导出字形缺失静默跳过（M3 T3 Important，原样保留）+ 导出 z-order 分歧裁决
      （M3 T3 Minor）
- [ ] 在线翻译同意 UI（M3 fail-closed，AtomicBool 无 setter）+ 启动冲突通知 UI 面 +
      accelerator 位移语义裁决（M3 项原样保留）
- [ ] 呼出窗口屏幕居中 + 混合 DPI 副屏漂移 + 负坐标多显示器选区（环境不可测项，
      原样保留）
- [ ] 非-截图系统命令（open-settings/copy-version）移植裁决（M3 T9 挂账）
- [ ] launchAtLogin=true 残留复位 + 自启动"默认不存在"复验（M2 起挂账）
- [ ] M2 人工清单余项（pinned 组视觉、UWP 图标在列、历史加成端到端排序、设置修改
      跨重启持久化、托盘语言切换）
- [ ] %TEMP% m1/m2/m3/m4-bench 清理（磁盘红线尾项；native/target 与 debug exe 本轮
      已清）
- [ ] （可选）恢复内部时间戳插桩复核冷启动/呼出内部值；剪贴板仓储 list_recent
      默认 limit 参数、Entry 类型双 crate 重复（M4 T2 Minor，顺手项）

## 5. 验证过程备注

- **消息级驱动套件（本轮成型，脚本全部留存 `%TEMP%\m4-bench\`）**：
  1. `--command-cabin-login-startup` 启动 → 出生即"窗口隐藏+托盘驻留"态（内存口径，
     同 M3）。
  2. **WM_HOTKEY 仿真**（M3 §5.2 方法论原样复用）：向 `global_hotkey_app` 隐藏窗
     PostMessage，Alt+Space=65598；本轮 7/7 成功。
  3. **WM_KEYDOWN/WM_KEYUP 消息级打字（新）**：VK + lParam 扫描码（bit16-23）+
     release 位 30/31；Slint LineEdit 真实接收（PrintWindow 截图为证）；Enter=VK 0x0D、
     Esc=VK 0x1B。与 M3 WM_CHAR 失败的差异：winit 从 WM_KEYDOWN 经 ToUnicode 派生
     字符。标点须查 VK 表（'+'=VK_ADD 0x6B、'\*'=VK_MULTIPLY 0x6A；'.' 误用 0x2E 即
     VK_DELETE——本轮踩坑记录）。
  4. **PrintWindow(PW_RENDERFULLCONTENT) 成像 + 像素哈希**：查询结果截图证据与
     击键延迟变化的检测器。
  5. **sqlite3 CLI（Android platform-tools）直读 `%APPDATA%\CommandCabin\
     command-cabin.sqlite`**：watcher 落库/去重/prune 的 live 验证手段（WAL 模式下
     并发读安全）。
- **冷启动测量纪律**：7 轮全量保留（含首发 719ms），未以"AV 预热"名义剔除；补充
  startup-anatomy 探针（any-window/visible/CPU 三点）把口径差异摊开（§1 注 1）。
- **剪贴板拒绝的证据链**：测量进程 OpenClipboard err=5 + GetOpenClipboardWindow 空 +
  45s Set-Clipboard 重试失败 + 应用 stderr 同文错误 + watcher "recovered" 翻转沿——
  环境限制结论由五路独立证据支撑。
- **watcher live 证据的取得纯属环境馈赠**：锁屏间歇放行剪贴板时 watcher 首拍成功落库
  （row 5668），使"读→产出→落库"链路免于纯静态证明；去重与 prune 由 15 分钟零重复
  与恒 200 行佐证。
- 一次脚本缺陷（'.' → VK_DELETE）导致 "742.58" 变为 "74258"，顺带完成裸数字恒等
  命令验证；未影响其他测量。
- 磁盘处置：构建后 `native/target` 由 build.ps1 自动清除；验收收尾删除
  `cabin-app-debug.exe`（426.3MB）；artifacts 仅存 release exe；应用实例全部终止
  （0 残留进程）。
- 未执行 git commit（安全钩子拦截为已知状态）；本轮对仓库源码净改动为零，新增
  文档仅 `docs/superpowers/acceptance/m4-baseline.md`（本文件）与
  `.superpowers/sdd/task-9-report.md`（任务报告，gitignored 路径）。
