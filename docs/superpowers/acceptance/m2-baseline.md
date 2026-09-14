# M2 验收基线（Rust + Slint 原生重写）

- 日期：2026-09-04
- 对象：`native/artifacts/cabin-app-release.exe`（2026-09-04 17:55 由
  `native/scripts/build.ps1 -Release` 全新构建产出，工具链 stable-x86_64-pc-windows-gnu /
  cargo 1.95，全量重建 7m49s；代码含 M2 设置窗口 + 图标水合 + 历史 + 自启动 + i18n +
  收藏。无测量插桩——M1 的 TEMP-BENCH eprintln 已在 Fix-1 剥除且未恢复，故本次全部
  外部观测）。二进制核实：含 M2 设置字段字符串（`delayedScreenshotHotkey`/`hideOnBlur`）、
  PE subsystem=2（GUI）。
- 环境：Windows 11 (10.0.26100) x86_64，主屏 2560x1707 物理（150% 缩放）；机器开始菜单/
  桌面 .lnk 数量沿用 M1 记录（240）。`%APPDATA%\CommandCabin` 含此前 M2 任务验证遗留状态：
  DB 434,176 B（hotkey=Alt+Space、language=zh-CN、hideOnBlur=true、**launchAtLogin=true**）、
  app-icons.json 起始 2,170,674 B（约 240 个图标缓存，暖态）。
- 对照目标：spec 第 1 节（常驻空闲内存 < 60MB；热键呼出 < 150ms、冷启动 < 500ms；安装包 < 20MB）
- 原始数据：脚本/日志/截图留存于 `%TEMP%\m2-bench\`（cold-results.json、mem-results-v2.json、
  hotkey-results.txt、launcher-home.png、build.log；该目录另含同日早前其他 M2 任务验证的
  产物，见第 5 节备注）

## 1. 量化指标（vs M1）

| 指标 | 目标 | M1 实测（2026-09-03） | M2 实测（2026-09-04） | 结论 |
| --- | --- | --- | --- | --- |
| 可执行体积（安装包代理，M2 仍无安装包） | < 20MB | 13.44 MB（14,089,728 B） | **17.05 MB**（17,878,016 B，+3.61MB） | 达标；增量来自图标水合（image 解码器）/设置 UI/存储层，上限余量收窄至 ~3MB |
| 冷启动（main-enter → event-loop-ready，内部时间戳） | < 500ms | 中位 **93ms** | 无法复测（无插桩；按要求不重加） | —（仅外部口径可比，见下行） |
| 冷启动（外部观察，上界） | 参考 | Start-Process → 日志 ready：720 / 695 / 865 ms，中位 720ms | Start-Process → 首个可见启动器窗口（10ms 轮询）：**2250 / 61.6 / 63.2 ms**，warm 中位 **63.2ms** | 上界参考；无回归迹象。口径差异见注 2 |
| 冷启动（`Measure-Command { Start-Process }`，仅进程创建） | 参考 | 59 / 17 / 19 ms | **16.7 ms** | 参考值 |
| 热键呼出（首次） | < 150ms | **157ms** / 96ms（内部时间戳） | **17.1ms**（外部上界：keybd_event 注入 → 可见窗口，含 ≥5ms 轮询粒度） | 上界已落在目标内；M1 的临界超标项按可达测量精度视为消除，内部值复核列 M5 可选项 |
| 热键呼出（再次） | < 150ms | **3ms**（内部时间戳） | 13.4 / 11.7 / 10.8 / 12.4 / **14.5ms**（外部上界，同上） | 达标区间（口径不可直接与 M1 的 3ms 内部值比较） |
| 常驻空闲内存（窗口隐藏，托盘驻留，WorkingSet64） | < 60MB | t0=63.2 → t30=127.5 → t60=**127.4** → t90=127.4MB；PrivateBytes t60=89.3MB | t0=**9.6** → t30=**223.4** → t60=**223.3**（PB **165.8**）→ t90=**223.3**MB；**t10 即达平台期 223.4MB** | **不达标，且较 M1 恶化 +95.9MB（+75%）**，列 M5 收口头号项（见第 3 节） |

注：

1. **内存方法论**：与 M1 的“窗口未呼出”条件对齐——应用正常启动会自动呼出启动器，
   t+2s 经全局热键（Alt+Space，DB 存储值）toggle 隐藏；可见性按**标题为 CommandCabin
   的可见窗口计数**判定（4x4 桩窗口于 (0,0) 的 IsWindowVisible 仍恒为 true，M1 备注 #6
   延续，不能作判据），hide 后 90s 内每 10s 采样均 launcherVisible=0。进程 CPU 累计
   0.95s / 92s，确为空闲。另一次 corroborating 运行（v1）t0=9.6 / t30=216.3 / t60=216.1
   （PB 160.7）/ t90=242.5MB——其 t90 采样时启动器窗口重新可见（live 桌面外部干扰），
   未采纳为平台值。图标缓存为**暖态**（此前会话已建立约 240 图标缓存）；冷缓存首轮
   提取的额外增量未单独测量。
2. **冷启动口径差异**：M1 外部端点是“日志出现 ready”（event-loop 就绪，且当时 exe 为
   console 子系统、附带控制台分配）；M2 无日志，端点为“首个可见启动器窗口”（就绪 +
   自动呼出，更晚的事件但不含控制台）。首跑 2250ms 为对新产物的杀软扫描惩罚
   （Start-Process 本身 939.6ms 才返回），warm 后 62–63ms。两者均为上界，仅可下结论
   “无回归迹象”，不做精确差值比较。
3. 热键注入共 6/6 次成功呼出，且每次呼出后 `GetForegroundWindow` 属应用进程
   （M1 Fix-1 的前台/焦点行为在 M2 保持）。

## 2. 功能验收清单

无头可覆盖项已实测；需交互项标注“待人工”。截图证据见 `%TEMP%\m2-bench\launcher-home.png`。

| 项 | 结果 | 证据 / 说明 |
| --- | --- | --- |
| Alt+Space 呼出窗口 | 通过 | keybd_event 注入 6/6 次窗口出现（launcher 标题窗口计数 0→1），首次 17.1ms，均取得前台 |
| 呼出后窗口聚焦 | 通过 | 每次 invoke 后 GetForegroundWindow 属应用进程（fgPid=应用 pid） |
| Esc 隐藏 | 通过 | 注入 Esc 后 launcherVisible=0（两个会话复验；M1 Fix-1 行为保持） |
| 空查询首页 recent 组 | 通过 | 截图：分组头“最近使用” + 6 行（ZCANPRO/东莞银行网银/MATLAB R2025b/WPS Office/draw.io/UGit），行含标题/副标题/图标/固定按钮，首行默认选中高亮 |
| 空查询首页 pinned 组 | 待人工 | 视口内未见 pinned 分组（recent 行数多或收藏为空时不渲染——`home_sections` 在 pinned 为空时省略分组头）；代码与单测覆盖，视觉确认需交互 |
| 图标出现在列表 | 通过 | 截图 6 行渲染出 6 个不同应用的位图图标（图标水合 + 磁盘缓存命中路径生效） |
| 图标含 UWP 应用 | 待人工 | DB 历史含 UWP 行（HP Printer Control，`shell:AppsFolder\AD2F1837.HPPrinterControl_...`，此前交互会话写入）证明 UWP 可索引可执行；其图标在本轮截图视口内未确认 |
| 历史加成影响排序 | 待人工（有佐证） | 首页 recent 顺序与 DB 历史行一致（此前执行的 UGit/东莞银行网银在列）；“执行后排名上升”的端到端闭环需交互打字，按 M1 同样理由未自动化 |
| zh-CN 文案（首页 + 搜索框） | 通过 | 截图：“搜索应用、命令…”、“最近使用”、“固定到首页”（i18n 接线生效） |
| 设置读写持久化（重启保持） | 待人工（读取侧通过） | 启动读取链路每次运行均验证：按 DB 设置注册 Alt+Space、zh-CN 文案、hideOnBlur 隐藏行为。经设置 UI 修改后跨重启保持需人工 |
| 热键修改生效 + 冲突拒绝 | 待人工 | 设置 UI 交互项（`apply_settings_patch` 的 normalize→查重→注册回滚→持久化链路）；启动期“按存储热键注册成功”已验证 |
| 自启动注册表写 / 删 | 部分通过 | HKCU\...\Run 值 `CommandCabin` 存在且格式正确：`"...cabin-app-release.exe" --command-cabin-login-startup`，与 DB launchAtLogin=true（此前交互测试置位）一致——**写/同步路径验证**。删除路径与“默认不存在”因当前 DB 非默认状态无法无头验证，待人工（UI 关闭开关后复查） |
| 第二个实例启动后静默退出 | 通过 | 主实例存活时启动第二实例：≤10s 退出、退出码 0、主实例仍存活、无诊断输出 |
| 进程常驻稳定 | 通过 | 92s 采样期存活且基本零 CPU（0.95s 含索引/图标后台） |
| settings DB 文件 | 通过（文件级） | `%APPDATA%\CommandCabin\command-cabin.sqlite` 434,176 B，头 16 字节为 `SQLite format 3\0`；应用存活即证明迁移与设置读取成功。行级校验待人工（机器无 sqlite3 CLI；以只读 strings 抽取到完整 settings JSON 与 4 条历史行作为辅助证据） |
| app-icons.json 体积记录 | 通过 | 实测 **2,208,362 B**（~2.11MB），且在本轮热键测试运行中由应用更新（mtime 17:59:33），证明图标磁盘缓存写路径在 M2 exe 中生效 |
| 托盘菜单（显示/设置/退出）与语言切换 | 待人工 | 进程驻留且启动序列托盘构造成功（失败即启动失败）；菜单交互与语言切换后的托盘文案需人工 |
| 呼出窗口屏幕居中 | **不通过** | 实测 rect (405,405)-(1049,852) 与另一次 (152,152)-(1118,822)（物理像素，屏 2560x1707），持续偏左上且逐次位置不定，未居中——承接 M1 |
| 磁盘红线 | 通过 | `native/target` 由构建包装脚本于构建后删除，复核无残留；临时产物仅 `%TEMP%\m2-bench\`（见第 5 节） |

## 3. 新发现问题（随基线记录）

1. **常驻空闲内存回归（头号问题）**：窗口隐藏托盘驻留的 WorkingSet 平台期
   **223.3–223.4MB**（PrivateBytes 165.8MB），较 M1 的 127.4MB（89.3MB）**恶化约 +96MB**，
   且平台期在 **t10 即到达**（M1 为 t30）。时间窗与后台索引完成 + 首轮图标水合重合，
   首要嫌疑：约 240 个图标的磁盘缓存读入与解码位图驻留、渲染缓冲随列表内容增大；
   `MEMORY_CACHE_MAX_ENTRIES` 的有界集合未阻止增长。根因分析与瘦身列 M5 收口，
   升级为头号项（目标仍 < 60MB）。
2. **exe 体积 +3.61MB（13.44 → 17.05MB）**：仍在 < 20MB 目标内，但余量收窄；来源为
   image 解码器（图标水合）、设置窗口与存储层。安装包实测仍是 M5 事项。
3. **Slint 品牌水印**：release 窗口右下角出现 “Made with Slint”（截图可见）。M1 时期
   推断已存在（非本次回归），属 Slint 许可证/品牌事项，列 M5 打包收口评估。
4. **冷启动首跑杀软惩罚**：新产物首次启动 Start-Process 即耗时 939.6ms、可见窗口
   2250ms；warm 后 62–63ms。环境因素，非缺陷，但提示安装包/ whitelisting 对首发体验
   的影响（M5 打包时留意）。
5. **无头可见性判定备注**：4x4 桩窗口 (0,0) 仍 `IsWindowVisible=true`（M1 备注 #6 延续），
   本次起改用“launcher 标题可见窗口计数”作判据；自动化隐藏统一走全局热键 toggle
   （Esc 依赖前台，已另行复验可用）。
6. **构建期间并发 cargo 异常**：本次全新构建期间检测到另一 cargo 实例并行编译同一
   workspace（另一任务的验证构建）。已核实最终产物 mtime（17:55:00）与本次构建完成
   时间一致、且含 M2 标记字符串；如需严格复现建议串行重跑构建。

## 4. M5 收口清单（承接 M1 + M2 新增）

- [ ] **常驻空闲内存 < 60MB —— M2 恶化：127 → 223MB**（图标水合首要嫌疑；根因分析 + 瘦身，头号项）
- [x] ~~首次热键呼出临界超标（M1 157ms）~~ —— M2 外部上界 17.1ms（含注入 + 轮询粒度）
      已低于 150ms；内部时间戳复核列为可选项
- [ ] 呼出窗口屏幕居中（M2 复测仍不通过，位置且逐次不定）
- [ ] 产出安装包并按 < 20MB 实测（exe 代理 17.05MB，余量 ~3MB；Slint 水印/许可事项一并评估）
- [ ] 待人工/交互项清单：pinned 组视觉、UWP 图标在列、历史加成端到端排序、
      设置 UI 修改跨重启持久化、热键修改生效 + 冲突拒绝、托盘语言切换、
      自启动删除路径与“默认不存在”复验
- [ ] （可选）恢复内部时间戳插桩以复核冷启动/呼出的内部值（M1 93ms/3ms 口径）

## 5. 验证过程备注

- `native/scripts/build.ps1 -Release` 在 Windows PowerShell 5.1 下正常解析并执行
  （BOM 修复有效），全新全量 release 重建 7m49s、退出码 0，`native/target` 由脚本
  在 finally 中删除，复核无残留；无其他构建残留进入仓库（`native/artifacts/` 下另有
  此前任务产出的 `cabin-app-debug.exe` 352MB，非本次产物，未处置）。
- 测量口径：M1 的内部 eprintln 标记未恢复（按要求），本次全部外部观测——
  Start-Process + 5–10ms 轮询（EnumWindows/IsWindowVisible/GetWindowRect）+
  keybd_event 注入（Alt+Space 全局热键、Esc），所有时间均为**上界**；与 M1 对比仅在
  外部↔外部之间进行，端点定义不同处已逐条注明。
- `%TEMP%\m2-bench\` 中 17:01–17:33 的文件（m2-bench.ps1、bench-run-*.log、
  `command-cabin.sqlite.pre-baseline-backup`、`app-icons.json.set-aside` 等）为此前
  其他 M2 任务验证所留，非本次产物；本次新增文件为 cold-start.ps1、memory-sample*.ps1、
  hotkey-invoke.ps1、functional-checks.ps1、visual-check.ps1、common-win.ps1、
  build.log、cold-results.json、mem-results-v2.json、hotkey-results.txt、
  launcher-home.png（均属可清理的临时基准数据）。
- 运行期间遗留过一次未清理的应用实例（首次功能脚本因 DB 文件占用异常退出所致），
  已定位并终止后重跑全部功能项；最终无 cabin-app 进程残留。
- 未执行 git commit（按要求，变更留在工作区）。
