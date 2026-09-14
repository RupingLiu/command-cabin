# CommandCabin v1.0（原生版）发布检查清单

- 日期：2026-09-06（M5 Task 6 产出）
- 对象：`native/` Cargo 工作区 v1.0.0；发布产物
  `native/artifacts/CommandCabin-Setup-1.0.0.exe` + 同名 `.sha512`
  （尺寸/摘要见 §7）。
- 本文件是 TS 时代 `docs/product/beta-release-checklist.md` 的原生版流程改写：
  自动化门槛（§4）、已知问题与人工验证清单（§2/§3/§5）、发布动作（§6）均按
  native 栈重写；Electron 专属项（electron-builder/latest.yml/ASAR 策略等）
  不再适用，原清单保留于原文件作为历史参照。
- 环境口径：Windows 11 (10.0.26100) x86_64，锁定会话（FG=锁屏），单屏
  1260×840（截图管线报告 scale_factor=2.0）——与 m5-metrics 同态。工具链
  stable-x86_64-pc-windows-gnu / cargo 1.95。

## 0. 里程碑验收文档索引

| 里程碑 | 文档 | 结果速览 |
| --- | --- | --- |
| M1 原生启动器核心 | [m1-baseline.md](./m1-baseline.md) | exe 13.44MB、冷启动 93ms；内存 127MB 与窗口居中挂账至 M5（均已收口）；Fix 1 修复 5 项功能性缺陷 |
| M2 设置/收藏/历史/图标 | [m2-baseline.md](./m2-baseline.md) | exe 17.05MB、功能全接线；内存回归 223MB（M5 收口） |
| M3 截图/OCR/翻译 | [m3-baseline.md](./m3-baseline.md) | 截图全链路消息级实证；exe 20.39MB、内存 314MB（M5 收口） |
| M4 计算器/剪贴板/文本工具/换算 | [m4-baseline.md](./m4-baseline.md) | 四功能 + 即时动态命令；WM_KEYDOWN 消息级打字方法论 |
| M5 更新器/打包/指标 | [m5-metrics.md](./m5-metrics.md) | 内存 36.7MB、exe 15.92MB、安装包 6.08MB、冷启动 109ms、居中 0.5px、热键 29ms |

## 1. 覆盖窗标注层帧时实测（T5 审查移交，v1.0 签收门槛）

T5 审查的 Important 挂账：`push_annotation_layer` 全缓冲克隆+合成+推送的帧时
仅有 20-40ms@2560×1707 的**估算**，要求实测后签收。本轮完成：

- **方法**：临时插桩（`M5T6-FRAME` eprintln，含耗时/缓冲尺寸/选区/scale）→
  锁定桌面下以 m4-baseline §5.3 消息级套件驱动（`COMMAND_CABIN_DEBUG_SCREENSHOT=1`
  自动截图 + PostMessage `WM_LBUTTONDOWN/WM_MOUSEMOVE/WM_LBUTTONUP` 完成
  选区拖拽与 3 轮选区内矩形标注拖拽，每轮 25 个 move、20ms 间隔，标注层
  推送经 16ms 节流自然产生）→ 记录后**剥除插桩**（`grep -rn
  "M5T6-FRAME|ft_start|ft_px" native/crates` 零命中，源码 diff 复零）。
- **口径**：release 构建（opt-level "s"，与发布产物同 profile）；插桩计的
  是 app 自有热路径 = committed 全量克隆 + 草稿绘制 + SharedPixelBuffer
  逐字节拷贝 + `set_annotation_layer` 图像交接；Slint 软渲染器自身的整窗
  合成在渲染回调内，不在本插桩范围（见 §3-2 人工复核项）。
- **实测**（环境屏幕 1260×840、报告 scale 2.0，缓冲 = 选区逻辑尺寸 × 2）：

| 场景 | 缓冲（设备像素） | 首推（冷） | 稳态中位 | 稳态 p90 | 稳态最大 | 样本 |
| --- | --- | --- | --- | --- | --- | --- |
| 选区 800×450 逻辑 | 2000×1300 = 2.60M px | 23.4ms | **5.0ms** | 6.3ms | 10.2ms | 56 推（1 冷 + 55 稳态） |
| 全屏选区 1253×833 逻辑 | 2506×1666 = 4.17M px | 26.0ms | **7.6ms** | 10.8ms | 12.9ms | 41 推（1 冷 + 40 稳态） |

- **裁决**：**达标**。验收线 ≤16ms 中位（30fps+）在 4.17M px 实测 7.6ms
  （稳态最大 12.9ms 亦在线内），余量约 2×；按像素数线性外推到审查假定的
  2560×1707（4.37M px，×1.047）中位 ≈ 8.0ms、p90 ≈ 11.3ms，仍在 16ms 内。
  **T5 的 20-40ms 估算被实测推翻**（估算作出于 opt-level "s" 采纳之前）。
  首推冷成本 23-26ms 为一次性（committed 重建 + 首次图像交接），非拖拽
  稳态成本。
- **备注（诚实边界）**：本环境物理屏幕 1260×840，2560×1707 数字为线性外推
  （全缓冲 memcpy/填充为带宽主导，一阶线性是合理模型）；软渲染器整窗合成
  与真机 vsync 节奏未含在插桩内，真实键鼠手感复核（§3-2）仍是发布前硬性项。
  dirty-rect 重绘保留为实测不达标时的优化路径——当前余量下暂不立项（§5）。
  原始证据：`%TEMP%\m6-t6\ft-stderr.log`、`ft-full-stderr.log`（易失，与
  m5-bench 同列可清理尾项）。

## 2. 已知问题清单（v1.0 接受并记录，不阻塞发布）

来源：progress.md M1-M5 各任务 Minor/挂账 + m5-metrics §5 系统性汇总，
逐项核对后的存活清单（已收口项——内存/体积/冷启动/居中/maxResults clamp/
PlatformError::Index/错误级文件日志/BOM 等——不再列）：

### 2.1 行为 / 一致性

1. **软件渲染器选择备案**：femtovg → renderer-software（M5 内存收口的根因
   修复，连带冷启动 474→109ms）。用户裁决备案；回退路径 = slint 特性还原 +
   opt-level 移除（届时内存/体积红线复挂，需另寻 GPU 路径）。m5-metrics §2。
2. **format-json 浮点分歧**：整型 100.0 vs JS 100、e29 vs e+29 用户可见差异；
   文档 + 锁定测试三处记录；后续可移植 calculator 的 Number::toString 关闭。M4 T4。
3. **粘性正则分歧**：畸形 JSON 上回退错误细节与 TS 不同（模块文档已补）。M4 T4。
4. **图标索引 ",N" 后缀丢失 / isUsefulIconPath 未移植**（M1 T9 注记）：非零
   索引图标资源降级为缺图标，不崩溃。
5. **launcher 搜索占位符硬编码中文**（M1 遗留，i18n 未接）。
6. **取消固定仅设置页收藏列表可做**（brief 允许，M2.5 radar）。
7. **About 页许可文案**（M2 T10 原为自拟散文；M5 终审核实现状为仅 Slint
   署名行、无 MIT 正文——项目 LICENSE 随安装包分发已足覆盖，此项收口为
   "无需动作"；若需在 About 内文展示 MIT 全文列 M6）。
8. **[忽略] 更新横幅按钮不移植**：TS updateController 无 ignore 语义，
   按 TS 为准（M5 T3 注记收口）。
9. **launchAtLogin=true 残留复位**：用户设置项，本轮未触碰。m5-metrics §5-5。
10. **截图 UI 杂项**（M3 T7/T8 Minor）：尺寸徽章在选区下方（TS 上方
    -34px）；放大镜未移植；两套双击检测器并存；pin 窗 close-label 死属性；
    保存对话框双线程 STA。
11. **OCR/翻译杂项**（M3 T6/T8 Minor）：TryCreateFromLanguage-null 分支消息
    带语言列表（TS 裸消息）；翻译空结果缺 noText 占位；OCR 面板 176px elide
    （TS wrap）；末次 trim 用 Rust 空白集（U+0085 差异，实践不可达）；WinRT
    超时操作不 Cancel（后台跑完，无害）；大小写折叠仅 ASCII（Windows 产 tag
    均 ASCII）。
12. **应用索引 parity 缺口**（M1 T9/T10 注记，分诊接受）：命令级 identity
    去重未移植（TS id + title|target|args|workdir 复合键）；AUMID 动作类型
    规则分歧（TS aumid 存在即 open-app，Rust 按可执行扩展名）；subtitle 缺
    aumid/shortcutPath 回退；非 UTF16 安全文件名标题降级为空；启动动词硬编码
    "open" 非默认动词；桌面扫描差异（递归/未解析快捷方式/排序——brief 认可）。
13. **设置/收藏输入杂项**（M2 T3/T4/T9 Minor）：整型浮点 maxResults（20.0）
    写路径拒收而 TS 接受；normalize 通过但 to_hotkey 拒绝时错误文案误导
    （报冲突实为映射问题）；收藏日期带时区偏移输入 TS 转 UTC 存储、Rust
    原样存（双向互操作成立）。
14. **汇率 ISO 解析接受不可能日期**（2-30，M4 T6 Minor）。
15. **CJK 导出字形静默丢失**（M3 T3，v1.0 用户可见）：内嵌 Liberation Sans
    无 CJK 字形，纯中文文字标注导出为空、"a你b" 塌缩为 "ab"（含前进宽度
    丢失）；浏览器有系统字体回退而导出无。中文主场景产品的用户可见缺陷——
    修复路径（系统字体回退或 CJK 子集字体）列 §5-2，v1.0 后优先。
16. **标注 z-order 与 TS 分歧**（M3 T3/T5）：TS 严格列表序合成，native 文字
    置顶于全部栅格标注（第二矢量遍设计）；交错标注被后绘矩形覆盖时两者
    输出不同。单循环交错绘制可两全，M6 裁决。

### 2.2 健壮性 / 内部 / 测试覆盖

15. **图标 flake 家族**：3 个 shell 管道图标测试偶发 flaky（0x8000000A
    并发重试同型，M3 T6/M4 T3 记录）。
16. **更新器加固 backlog**（M5 T1 Minor，TLS+sha512 威胁模型下可接受）：
    无读量上限（size 检查在读完之后）；非常量时间摘要比较（无远程时序
    oracle）；下载 UA 未断言；size=0 时 progress (x,0)。
17. **NSIS 打包 backlog**（M5 T4 Minor）：NSIS zip 未哈希钉死；LICENSE 条目
    /nonfatal 歧义（现存在故无害）；-Version 覆盖不交叉校验 exe 实际版本；
    T4 的 34 项真机检查未逐条枚举（结论已在 m5-metrics §4 引用）。
18. **M5 T5 Minor 集**：maxResults clamp 的 warn 走 stderr（dev-only）；
    chrono_like_iso_now 无超今日期测试；居中钉 current monitor（多显示器
    预期行为注记）；并发 panic 下日志轮转竞态（error 级可接受）。
19. **图标/杂项健壮性集**（M2 T6/T7/T8、M4 T2 Minor，均记录无害）：save_
    bitmap_to_png 单次 Read 截断假设（SHCreateMemStream 实际一次全读）；
    GdiplusStartup 失败被 OnceLock 永久缓存；select_application_block 前缀
    匹配可命中容器标签（现靠回退正确）；自启动 is_enabled 仅判值存在、
    RegCreateKeyExW 有建键副作用；图标缓存键 load→flush 往返重排为字母序
    （平局驱逐可能分歧，良性）；U+2028/U+2029 字节转义测试未覆盖；剪贴板
    Entry 类型双 crate 重复 + ECMAScript 空白集三份私有拷贝（分层强制）；
    list_recent 无默认 limit 参数。
20. **编排杂项**（M1 T10/M2 T9 Minor）：invoke_from_event_loop 静默吞错
    （扫描快过事件循环启动时，实际近乎不可能）；scan.failures 未记录日志；
    历史读取失败静默降级 unwrap_or_default（仅日志）；击键重复入队图标
    任务（自限）；flush-scheduler "断连最终 flush" 注释夸大（实际不可达）。
21. **启动热键注册失败即退出进程**（M1 可接受，TS 是显示窗口）：corrupt
    hotkey 使应用无法启动且无恢复覆盖——M6 候选。

## 3. 发布前人工验证清单（解锁桌面实机；beta 前硬性）

1. **真实键鼠清单**（M3/M4 项照旧）：物理热键按压（Alt+Space / Ctrl+Alt+A /
   截图延时热键）；截图六工具全链路（矩形/椭圆/箭头/画笔/文字/马赛克 +
   撤销重做 + 保存/置顶/复制 + 文字标注交互式焦点链）；设置流实机（热键
   位移回滚、语言/主题切换）；外部复制→历史 ≤1s 浮现→pick 回写→粘贴核对；
   文本工具三变换回写与故障逐字文案；清空历史实机；托盘语言切换。
2. **软件渲染器手感复核（M5 新增）**：4K/高 DPI 大屏与截图全屏覆盖窗下的
   拖拽/重绘手感。§1 实测（消息级、锁定桌面）中位 7.6ms@4.17M px、稳态
   最大 12.9ms，余量约 2×，但软渲染器整窗合成与 vsync 节奏不在插桩口径内，
   须实机确认；若不达标，M6 走 dirty-rect 重绘（§5）。
3. **混合 DPI 副屏**：居中位置、覆盖窗逻辑坐标漂移、负坐标多显示器选区
   （纯函数测试已含负坐标/超尺寸用例，实机待验）。
4. **设置窗口打开与 About 显示**：入口仅托盘菜单，锁定会话不可达（M2 起
   同款）；About 应显示 "CommandCabin v1.0.0"（编译期 CARGO_PKG_VERSION，
   代码路径已核验）。
5. **安装/升级/卸载实机循环**：M5 T4 已有 34 项真机检查（临时前缀装/卸/
   覆盖 + %APPDATA% 保留断言 + /D= 优先于旧 InstallLocation）；本轮 exe
   换代（0.1.0→1.0.0）后建议发布前重跑一轮覆盖升级。
6. **未签名告知**：无代码签名证书，安装时 SmartScreen 提示属预期，发布说明
   记录；升级校验依赖 .sha512 边车（客户端缺校验文件即拒绝执行，安全红线）。

## 4. 发布前自动化门槛（native 流程；本轮实测记录）

在 `native/` 下执行（工具链 PATH 自举见 AGENTS.md "Native (Rust + Slint)
Workspace" 章节）：

| 门槛建 | 本轮结果 |
| --- | --- |
| `cargo test --workspace` | 628/628 通过（cabin-app 137、core 319、storage 36、platform-windows 68 regular + 2 live、platform 68） |
| `cargo clippy --workspace -- -D warnings` | 通过（0 警告） |
| `cargo fmt --all -- --check` | 干净 |
| `powershell native/scripts/build.ps1 -Release` | 成功；`cabin-app-release.exe` ≈15.9MB（<20MB ✓） |
| `powershell native/scripts/build-installer.ps1` | 成功；`CommandCabin-Setup-1.0.0.exe` + `.sha512`（§7） |
| 体积红线 | exe 15.9MB、安装包 ≈6.1MB，均 <20MB（m5-metrics §1/§3 详表） |
| 磁盘红线 | `native/target` 构建后自动清除；`native/artifacts/` 仅 release exe + Setup + .sha512；NSIS 便携缓存在 `~/.local/share/nsis`（用户工具目录，不进仓库）；仓库零新增大文件 |

版本单一来源核验：`native/Cargo.toml [workspace.package] version = "1.0.0"`
（全部 crate `version.workspace = true` 继承；Cargo.lock 随构建刷新）；
设置页 About 文案 `CommandCabin v{CARGO_PKG_VERSION}`（main.rs
`about_version_text`）为编译期 env! 注入，最终二进制含 "1.0.0" 字符串
（锁定会话无法点开设置页 UI，实机显示列入 §3-4）。

## 5. 后续里程碑（M6+ backlog，不阻塞 v1.0）

1. **dirty-rect 标注层重绘**：仅当 §3-2 实机手感复核不达标时立项（当前
   实测余量 2×，暂不立项）；连带关闭 compose_base O(像素×屏) 与全缓冲
   克隆的 4K 重选区性能欠账（M3 T7 Minor）。
2. **CJK 导出字形修复**：系统字体回退或 CJK 子集字体（§2-15 的修复路径，
   v1.0 后优先）。
3. **标注 z-order 修复**：§2-16 的单循环交错绘制方案（M3 T3 Minor）。
4. **在线翻译同意 UI**：设置开关 / 首次对话框驱动 ONLINE_TRANSLATION_CONSENTED
   （当前 fail-closed，翻译入口返回可读不可用文案；M3 T8）。
5. **启动冲突通知 UI**（当前仅 stderr；M3 T8）与**非截图系统命令移植**
   （open-settings/copy-version；M3 T9）。
6. **execute_clicked 重跑 mutation 管线**（TS 是 registry 查找——幂等但
   repo 变化时点击静默无效；M4 T7）。
7. **rate_fetch_in_flight 泄漏修复**（invoke_from_event_loop 失败时 true
   不复位，仅关机路径；M4 T7）。
8. **击键延迟 <5ms 内部插桩复测**（M4 挂账；外部口径 14-16ms 无劣化迹象）。
9. **更新器加固**（§2-16 各项）与 **NSIS 打包加固**（§2-17 各项）。
10. **体积备案**：opt-level "z"（14.88MB，再省 1.04MB）、panic="abort"
    （再省 ~1-2MB，行为风险见 m5-metrics §3）——需时与用户单独裁决。
11. **启动热键失败恢复面**（§2-21）。

## 6. 发布动作（按序执行）

1. **提交**：Mimosa 钩子拦截 commit——先 `setx MIMOSA_GIT_GATE_MODE warn`
   并重启 ZCode（或在 Mimosa 中放行），再统一提交本次改动；提交前
   `git diff --check`。
2. **打 tag**：在最终提交上打 `v1.0.0`（annotated），随提交推送。
3. **建 GitHub Release**（repo：`RupingLiu/command-cabin`）：
   - tag：`v1.0.0`；标题建议 "CommandCabin v1.0.0（原生版）"。
   - 资产（**命名精确匹配**，客户端按名索引，缺失 = 可读错误路径，单测锁定）：
     - `CommandCabin-Setup-1.0.0.exe`
     - `CommandCabin-Setup-1.0.0.exe.sha512`
   - 正文：变更日志（建议结构：亮点（体积/内存/冷启动数字）、M1-M5 功能
     清单、已知问题引用本文 §2、未签名提示与 sha512 校验说明）。
4. **验证更新器可见**（发布后）：
   - `releases/latest` 应解析出 tag 1.0.0 + 两个资产；
   - 运行 live 探针（cabin-platform-windows `#[ignore]` 测试）确认
     `installer_asset=Some(CommandCabin-Setup-1.0.0.exe)`——M5 T5 时该探针对
     0.9.0 旧命名资产返回 `None`（可读错误路径），本轮发布后应翻转；
   - 已装 1.0.0 实例手动检查 → "已是最新"（无更新横幅）；
   - 真实升级链（1.0.0 在装 → 下一版本发布 → 横幅 → 下载 → sha512 校验 →
     静默安装）留给首个补丁版本发布时验证。

## 7. 本轮（M5 Task 6）净改动与最终产物

源码/文档净改动：

1. `native/Cargo.toml`：workspace version 0.1.0 → **1.0.0**（全部 crate 继承；
   Cargo.lock 随构建刷新）。
2. `AGENTS.md`：新增 "Native (Rust + Slint) Workspace" 章节（工具链 PATH 自举、
   build/test/lint/installer 命令、分层规则、里程碑文档指针、TS 参照纪律）；
   Electron 内容原样保留（cutover 前共存）。
3. `README.md`：新增 "原生版本（开发中）" 章节与 `native/` 结构行（文案无
   竞品名）。
4. 帧时插桩：临时加入 → 实测（§1）→ **已剥除**（grep 零命中 + 源码 diff 复零）。
5. 本文档（发布检查清单）。

最终发布产物（`native/artifacts/`，构建脚本自动清场后仅存三件）：

| 文件 | 尺寸 | SHA256 |
| --- | --- | --- |
| `cabin-app-release.exe` | 16,689,664 B（15.92MB） | `016846e1bf23955385e66698a42f086f8c66f285c0a8bca0ff187df1c2480b10` |
| `CommandCabin-Setup-1.0.0.exe` | 6,375,694 B（6.08MB，压缩率 37.7%） | `21a39566c555b6c92dda0c31237f95e7f25a0358b3236c6aabd474ae1c1e4c36` |
| `CommandCabin-Setup-1.0.0.exe.sha512` | 159 B | ——（SHA512 = `e244fbe1…f25c7`，与 `sha512sum` 交叉复核一致，构建脚本内置步骤） |

二进制版本核验：`cabin-app-release.exe` 内含 "1.0.0" ×2 与 "CommandCabin v"
×1（About 的编译期 `CARGO_PKG_VERSION` 注入）。`native/target` 已随构建清除，
artifacts 仅存上表三件（磁盘红线）。
