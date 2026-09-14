# CommandCabin 工程代码逻辑优化分析报告

- **日期**：2026-08-13
- **范围**：`apps/desktop`（主进程 / preload / 渲染层 / shared）、`packages/core`、`packages/built-in-plugins`、`packages/plugin-api`
- **方法**：5 个并行子代理分模块只读分析（搜索与命令 / 存储与插件运行时 / 桌面主进程 / 渲染层 / 内置插件与 Plugin API），并由人工对核心热路径逐文件复核交叉验证
- **性质**：只读分析，未修改任何代码。所有行号以分析时的仓库状态为准

---

## 0. 结论摘要（TL;DR）

整体工程质量良好：安全边界（无 eval、IPC sender 校验、解析器复用）、数据库用法（连接单例、statement 预编译、WAL、嵌套事务、迁移框架）、错误隔离（插件运行时、命令执行器）与测试覆盖都相当规范。真正的优化空间集中在两类：

1. **搜索热路径的重复劳动**——每次按键最多 4 次全量重建 Fuse 索引 + 2 次同步 DB 读 + 可能 1 次网络等待，且渲染端无防抖。这是用户体感最直接的问题，也是修复收益最大的问题。
2. **进程/文件资源型开销**——每个 `.lnk` 一个 `powershell.exe`、图标解析无在途去重、图标缓存整文件重写、OCR 无队列复用、每次聚焦触发更新检查等。

另有一批低风险的正确性/维护性问题（插件并发 enable 竞态、模块加载超时不可恢复、Plugin API 缺错误契约等）值得列入排期。

**建议实施顺序**（详见第 6 节路线图）：

- **P0（搜索响应性）**：消除每次按键的全量索引重建 + 防抖；设置/历史读取缓存；汇率 TTL。
- **P0（资源风暴）**：快捷方式批量解析、图标在途去重、更新检查节流、OCR 队列。
- **P1**：深拷贝链削减、tokenize/ranking 重复规范化、剪贴板热路径、插件运行时竞态、渲染层细项。
- **P2**：健壮性边界、死代码清理、文档补齐。

---

## 1. 高优先级发现（P0）

### 1.1 每次按键 4 次全量重建 Fuse 索引，且全链路无防抖（最高优先级）

- 【`apps/desktop/src/main/launcher/launcherCommandService.ts:891-922`】`searchCommands()` 每次被调用都执行：`refreshAppCommands()`（:892）→ `refreshCalculatorCommand(query)`（:898）→ `await refreshQuickConverterCommand(query)`（:899）→ `refreshClipboardHistoryCommands()`（:900）。这 4 个函数各自以 `refreshSearchIndex()`（:545-547）结尾，即 `searchEngine.update(registry.list())` 整库重建。
- 【`packages/core/src/search/searchEngine.ts:400-407`】`update()` 对每条命令执行 `createSearchDocument`（:97-120：`cloneCommand` 深拷贝 + title/subtitle/keyword 逐一 NFKD 映射规范化），然后 `new Fuse(...)` 整体重建并清空 `fuseResultsCache`（:406）。**查询结果缓存也因此全部作废**。
- 【`apps/desktop/src/renderer/src/launcher/useLauncherController.ts:1011-1053`】搜索 effect 对每次 `state.query` 变化直接发 IPC，无防抖；主进程侧【`apps/desktop/src/main/index.ts:751-764`】IPC handler 原样透传，无节流。快速打字 = IPC 风暴 + 主进程连续整库重建。
- 叠加放大因素：`appIndexer.getCommands()` 深拷贝全部命令 → `commandRegistry.register` 再克隆 → `registry.list()` 再克隆 → `createSearchDocument` 再克隆，单次按键约 6+ 次 JSON 往返深拷贝。现有 perf 测试（`searchEngine.test.ts:377-428`）只测 `search()` 不测 `update()`，掩盖了该问题。
- **建议**：
  1. 渲染端（或主进程）加 80-150ms 防抖；
  2. 为 appIndexer / favorites / clipboard 引入数据代际（版本号），`searchCommands` 只在代际变化时重建索引，否则直接复用现有 Fuse（顺带保留结果缓存）；
  3. 计算器 / 单位换算这类"每次查询内容都变"的动态命令改用 `searchEngine.upsert`（:409-413）替换 1-2 条文档，而非整库 `update`；
  4. 将同一次搜索中的多次 `refreshSearchIndex()` 合并为最后一次统一重建。
- **预期收益**：高。每按键主进程阻塞从数百 ms 级降到个位数 ms 级，且随命令数增长不再线性恶化。

### 1.2 汇率查询每次按键 await 网络请求，离线时阻塞最多 1.2s

- 【`apps/desktop/src/main/launcher/exchangeRateCache.ts:186-206`】`getUsdToCnyRate()` 每次调用都**先发网络请求**（`DEFAULT_TIMEOUT_MS = 1200`，:5），失败或超时才回退磁盘缓存；无 TTL、无 in-flight 去重。哪怕 10 分钟前刚取到汇率，下次查询照样重新请求。
- 【`packages/built-in-plugins/quick-converter/src/index.ts:172-208`】货币类查询（如 `100美元`）走 `await getUsdToCnyRate`（:188）；【`launcherCommandService.ts:899`】`searchCommands` 又 `await refreshQuickConverterCommand(query)`——**货币查询的每次编辑都在搜索路径上同步等待网络**。连续编辑还会并发发起多个 fetch，只有一个结果通过代际守卫生效（`launcherCommandService.ts:635-648`），其余全部浪费。
- **建议**：① TTL（如缓存 < 1 小时直接用，后台静默刷新）；② cache-first 策略；③ in-flight promise 去重；④ `refreshQuickConverterCommand` 改为 fire-and-forget（代际守卫已具备，不 await 即可）。
- **预期收益**：高。离线/弱网下货币查询每次按键省 0.1~1.2s 阻塞，在线时消除重复请求。
- **注意**：`exchangeRateCache.test.ts` 固化了"先实时后缓存"行为，改动需同步测试。

### 1.3 每个 .lnk 快捷方式独立启动一个 powershell.exe 进程

- 【`packages/core/src/indexer/windows/startMenuScanner.ts:278-360`】`resolve()` 对**每个快捷方式**执行一次 `execFile('powershell.exe', ['-EncodedCommand', ...])`（:306-321），脚本每次现拼（:116-150）。PowerShell 进程启动 + COM 初始化约 200-500ms/个；典型机器 100-300 个快捷方式，即使并发 8（`mapWithConcurrency`，:507-526 / :579-603）一次全量扫描仍达数十秒级。该扫描在启动加载与每 30 分钟自动刷新（`apps/desktop/src/main/index.ts:412`）时都会完整重跑。
- **建议**：把整批 .lnk 路径一次编码进**单个** PowerShell 脚本，循环 `WScript.Shell.CreateShortcut` 批量解析并一次返回 JSON 数组（复用同一个 `$shell` COM 实例），保留现有超时与失败隔离语义。测试基于注入的 `execFile` 抽象，改动可控。
- **预期收益**：高。首次索引 / 手动刷新从数十秒级降到秒级。

### 1.4 每次聚焦启动器都触发一次更新检查（每次 Alt+Space 打一次 GitHub）

- 【`apps/desktop/src/renderer/src/launcher/LauncherPage.tsx:305-309`】`onFocusSearchInput`（主进程窗口每次 show 时发送）回调里执行 `checkForUpdates()`，挂载时也执行一次（:309）。
- 【`apps/desktop/src/main/updater/updateController.ts:255-293`】`checkForUpdates` 只对 `checking/available/downloading/downloaded` 防重，**`up-to-date` 状态不拦截**——每次聚焦都会重新发起 `autoUpdater.checkForUpdates()` 网络请求。
- **建议**：主进程加时间节流（如 10 分钟），或移除 focus 触发的检查（保留挂载时与 6 小时定时检查）。
- **预期收益**：高（消除高频无谓网络请求，也降低对更新服务器的影响）。

### 1.5 图标解析缺少 in-flight 去重；磁盘缓存每次写都整文件重写

- 【`apps/desktop/src/main/icons/appIconResolver.ts:657-713`】`pendingResultIconResolutions` 在途去重只在 `warmSearchResultIcon`（:687-707）中使用，而该函数**生产代码从未被调用**（仅测试引用）；搜索路径实际走的 `resolveSearchResultIcon` 无路径级 in-flight 去重。连续按键搜索同一应用会重复 spawn PowerShell 解析同一图标（内存 `iconCache` 仅在完成后写入）。
- 【`apps/desktop/src/main/icons/iconDataUrlCache.ts:143-163`】`write()` 每次在串行队列里把最多 256 条 base64 数据整个 JSON 序列化写盘 + rename。首次搜索解析多个新图标 = 连续 N 次全量写（O(n²) I/O）。
- **建议**：① 增加 `Map<iconPath, Promise>` / `Map<shortcutPath, Promise>` 在途去重，或把 warm 机制接入 `searchResultIconHydration` 主路径；② 缓存写改为脏标记 + 防抖批量写（500ms 合并）。
- **预期收益**：高（解析次数降一个数量级）／中（磁盘 I/O）。

### 1.6 截图 OCR / 翻译链路无进程复用、无并发上限、无结果缓存

- 【`apps/desktop/src/main/screenshot/localOcr.ts:277-335`】每次 OCR 都新建 `powershell.exe`（10s 超时）并重新加载 WinRT OCR 类型（脚本每次重做 Add-Type + 枚举语言）；快速连续框选会并发 spawn 多个 OCR；翻译链 = OCR(10s) + 在线翻译(6s)。
- 【`apps/desktop/src/main/screenshot/screenshotController.ts:493-499`】调用路径无队列/上限控制。
- **建议**：串行队列 + 并发上限（如 2）；按图片 hash 缓存 OCR 结果；或维持常驻 OCR worker。
- **预期收益**：高（截图翻译/OCR 延迟显著下降，避免进程风暴）。

### 1.7 截图导出反复 `new Image()` 重新解码整屏 data URL

- 【`apps/desktop/src/renderer/src/screenshot/ScreenshotOverlay.tsx:515-529, 884-913`】`exportImage` 每次（OCR/翻译/保存/置顶/完成）都调 `composeScreenshotSelection`，内部对每个显示器 `loadBrowserImage` 新建 Image 解码整屏 PNG（多屏/高分屏单张可达数 MB）。连续操作（OCR→翻译→保存）重复解码同一大图；DOM 中已有的 `<img>`（onLoad 只记录 loadedSourceIds）未被复用。
- **建议**：onLoad 时把已加载的 HTMLImageElement 存入 ref 复用；或将组合结果按 (selection, 标注版本) 缓存 data URL。
- **预期收益**：高（消除连续操作中的重复大图解码）。

### 1.8 应用候选搜索（Add App Picker）无防抖 + 图标解析无并发上限

- 【`apps/desktop/src/renderer/src/launcher/AddAppPicker.tsx:322-356`】每次键击 `listAppCandidates` IPC，无防抖（已有 requestId 防陈旧，可直接叠加）。
- 【`apps/desktop/src/main/index.ts:790-796`】`LIST_APP_CANDIDATES` handler 对最多 80 个候选 `Promise.all(map(resolveAppCandidateIcon))`；每个候选的图标解析链可 spawn 1-3 个 `powershell.exe`（快捷方式 750ms / AUMID 3s / 关联图标 1s），**无并发池**——极端情况一次请求并发拉起几十个 PowerShell。
- 【`apps/desktop/src/main/launcher/appCandidateService.ts:312-347`】`listCandidates` 每次调用重新 readdir 桌面目录 + PowerShell 解析匹配的 .lnk，无会话缓存。
- **建议**：渲染端加 150-250ms 防抖；主进程引入并发池（core 已有 `mapWithConcurrency`，可提升复用）限制图标解析并发 4-8；桌面快捷方式列表与解析结果按 mtime 做会话缓存。
- **预期收益**：高（避免进程风暴）。

---

## 2. 中优先级发现（P1）

### 2.1 设置每次读取全量读库 + 解析 + 校验 + 多层克隆，落在搜索热路径上

- 【`packages/core/src/storage/settingsRepository.ts:188-198`】`getSettings()` 每次执行同步 SELECT → `JSON.parse` → `validateSettingsPatch` 全量校验 → `createSettingsFromPatch` 再走一遍 in-memory store 合并+克隆。
- 【`apps/desktop/src/main/index.ts:472`】`getSearchSettings` 绑定到 `settingsStore.getSettings()`；【`launcherCommandService.ts:902`】每次按键搜索都调用——**每次敲键一次同步 SQLite 读 + 完整 JSON 解析/校验/克隆**，阻塞主进程事件循环。
- **建议**：repository 构造时读一次并缓存；`getSettings()` 直接返回缓存；`updateSettings`/`resetSettings` 写回后失效。顺带把 `cloneSettings`/`createSettingsFromPatch` 换成普通合并函数。
- **预期收益**：高（配合 1.1 一起消除热路径同步 I/O）。

### 2.2 历史记录：每次搜索全量读 100 行且逐行 JSON.parse 无用的 metadata 列；表无限增长

- 【`packages/core/src/storage/historyRepository.ts:119-126`】`listRecent` SELECT 全部 7 列并逐行 `parseStorageJson(metadata)`（:52）。搜索热路径消费方【`launcherCommandService.ts:677-685`（非空查询排序上下文）与 `:707`（空查询最近应用）】只用到 `commandId/executionCount/executedAt/title/source`，**每次搜索 100 次 metadata JSON.parse 纯属浪费**，且同一次数据两个入口各自查询。
- 【`historyRepository.ts:163-206`】`command_history` 无任何保留/裁剪策略，行数只增不减（`MAX_RECENT_HISTORY_LIMIT=100` 只限制读取）。长年运行 WAL 膨胀、`ORDER BY executed_at DESC` 成本上升。
- 【`historyRepository.ts:169-195`】`recordExecution` upsert 写后又 `selectByCommandId` 回读整行 + JSON.parse（:188-194），仅为返回结果，每次执行多一次同步读。
- **建议**：① 排序上下文与"最近应用"复用同一次 `listRecent(100)`；② 新增不含 metadata 列的轻量查询（排序只需 3 列）；③ metadata 为 `'{}'` 时跳过 parse；④ `RETURNING` 直接返回 upsert 结果；⑤ 加保留策略（总量阈值如 2000 行时按 `executed_at` 裁剪）。
- **预期收益**：高（搜索热路径同步 DB 开销减半以上）。

### 2.3 所有数据库 I/O 为同步调用，跑在主进程事件循环上

- 【`packages/core/src/storage/database.ts:90-121`】使用 `node:sqlite` 的 `DatabaseSync`，全同步 API；WAL 只解决读写互斥，不解决主进程阻塞。搜索按键→IPC→同步 DB 读→渲染反馈链路中，DB 时延直接进入 UI 时延。
- **建议**：先用 1.1/2.1/2.2 的缓存与去重把热路径读次数降下来；若仍需要，可将存储层迁到 worker 线程/子进程（node:sqlite 无异步 API，属较大架构改动，需单独评估）。
- **预期收益**：配合缓存实施时为高；独立迁移成本高、收益需实测。

### 2.4 appIndexer refresh/load 深拷贝链重复 5-6 层，每层都是 JSON 序列化往返

- 【`packages/core/src/indexer/appIndexer.ts:292-308, 333-368`】refresh 路径：`dedupeAppCommands` 内 clone 一次 → `indexCache.write` 内 clone 一次（`indexCache.ts:241`）且返回值再 clone（`indexCache.ts:247-250`，调用方只取 `scannedAt`）→ `snapshot.commands` / `commands` / `latestSnapshot` / return 再各 clone——每条命令累计 5-6 次深拷贝。load 路径同样重复。`cloneCommand` 每次都是 `validateStorageJsonValue` + `JSON.parse(JSON.stringify(payload))`（`commandJson.ts:26,58-67`）。
- 【`packages/core/src/command/commandRegistry.ts:37,40`】`get()`/`list()` 每次深拷贝，被 launcher 每按键多次调用（并入 1.1 一起放大）。
- **建议**：明确快照所有权——内部只持有一份不可变数组，对外暴露时仅 clone 一次；`cache.write` 返回最小对象；`getCommands()` 按代际缓存返回副本。
- **预期收益**：中-高（刷新/加载 CPU 开销减少约一半）。

### 2.5 tokenize 双重规范化；ranking 每候选重复规范化 query 与 title

- 【`packages/core/src/search/tokenize.ts:197-211`】`normalizeSearchTextWithMapping` 先独立跑 `normalizeSearchTextValue`（NFKD→去音标→lowercase→trim→压缩空白），再用带映射管道 `createDecomposedMappedText → removeDiacritics → lowercaseMappedText → collapseMappedWhitespace` 把同一文本**完整重算一遍**（映射管道的 `.text` 与 `normalizedText` 等价），末尾还多一次 `alignSourceRanges`。`createSearchDocument` 对每条命令的每个字段调用，每次 `update()`（每次按键最多 4 次）全量重跑。
- 【`packages/core/src/search/ranking.ts:245-262`】`rankSearchCandidate` 对**每个候选**重新 `normalizeSearchText(input.query)`（:246）与 `normalizeSearchText(input.command.title)`（:247）——而 `searchEngine.ts:431` 已算好 `normalizedQuery`、`SearchDocument` 已缓存 `normalizedTitle`（:33,104）却未传入。`candidateLimit = max(limit, 100)` 时每搜索约 100 次冗余规范化。
- **建议**：直接取映射管道的 `text` 作为 `normalizedText`，删除重复计算；`SearchRankingInput` 增加 `normalizedQuery`/`normalizedTitle` 字段，引擎侧只算一次。
- **预期收益**：中（索引重建热路径文本处理成本减半）。

### 2.6 剪贴板历史：保存全表扫描去重、预览先处理后截断、每次按键 200 条全量重注册

- 【`packages/built-in-plugins/clipboard-history/src/clipboardRepository.ts:104-109, 155-169`】`saveTransaction` 每次保存 `selectAllForComparison.all()` 把全表（上限 200 行、每行最长 20KB）载入内存逐行 `trim()` 比较去重——无法利用 SQL 索引；而 watcher 层【`clipboardWatcher.ts:51`】已按 trim 文本去重，此全表扫描在主线几乎为防御性死代码。
- 【`packages/built-in-plugins/clipboard-history/src/index.ts:21-29, 43`】`truncatePreview` 在截断到 93 字符**之前**对完整 20KB 文本跑 `replace(/\s+/g,' ')`，且 subtitle 与 keywords 各调一次（每条目 ×2）。叠加 `listRecent(200)` 与"每次按键重建"（1.1），最坏每次按键约 200×2×20KB = 8MB 文本跑正则。
- 【`clipboardRepository.ts:142-167`】`pruneOldRows` 每次保存都执行"子查询 + DELETE"，即使表远未达 200 行上限。
- **建议**：① 主线删除规范化全表扫描，仅保留 `UNIQUE(text)` upsert；若需保留"规范化重复则更新原文"语义（测试 `clipboardHistory.test.ts:61-87` 依赖），新增 `normalized_text` 列建索引；② `truncatePreview` 先 `slice(0,~100)` 再折叠空白，预览只算一次复用；③ 保存时先查行数，低于上限跳过 prune；④ 剪贴板命令改为事件驱动刷新（watcher 保存成功时触发），而非每次搜索全量重注册。
- **预期收益**：中（每秒都可能发生的热路径；与 1.1 叠加收益大）。

### 2.7 插件运行时：并发 enable 竞态、模块加载超时"焊死"、日志无限增长

- 【`packages/core/src/plugin/pluginRuntime.ts:515-675`】两个并发 `enablePlugin(root)` 会双双通过 `existingEnabledState` 检查，各自 await 让出后，后完成者覆盖状态 → 可产生"命令在 registry 里但插件状态为 disabled"的脏状态。桌面端靠 `desktopPluginService` 的 `operationQueue` 串行规避（`desktopPluginService.ts:44-53`），但 `createPluginRuntime` 是公开 API，自身无并发保护（测试未覆盖并发）。
- 【`pluginRuntime.ts:236-251`】`runWithTimeout` 超时只 reject 调用方：`moduleLoader`（`import()`）超时后 pending import 永远留在 ESM 模块缓存，**之后每次重试 enable 都再次超时**，该插件本次会话不可恢复；activate/命令 handler 超时后异步工作仍在跑（定时器/资源无法回收）。
- 【`packages/core/src/plugin/pluginLifecycle.ts:118-153`】插件日志数组只 push 不清除，随会话无限累积；`list()` 每次 O(n) 全量过滤 + 深克隆；每次 `log()` 内部存储/sink/返回共深克隆 2-3 次。
- **建议**：① 按 pluginRoot 维护 in-flight Promise 去重，并发调用共享同一次 load/enable；② moduleLoad 超时错误信息明确"需重启应用重试"（或考虑 AbortSignal，需 Plugin API 配合）；③ 日志环形缓冲上限（如 1000 条）+ 按 pluginId 索引 + 只克隆一次。
- **预期收益**：中（正确性/健壮性）。

### 2.8 渲染层细项

- 【`apps/desktop/src/renderer/src/launcher/ResultList.tsx:187-213`】结果列表无 memo，每次按键整树重渲染；`ResultItem` 未包 `React.memo`，map 内联回调即使加 memo 也会被破坏（`LauncherPage.tsx:358-360`）。建议 `React.memo` + `useCallback` 固定回调。**中**。
- 【`apps/desktop/src/renderer/src/settings/HotkeySettings.tsx:264-268`】`useEffect` 无依赖数组，每次渲染重新订阅/退订 3 个 IPC 监听（非泄漏，纯浪费）。建议 `useCallback` + 依赖数组。**中低**。
- 【`apps/desktop/src/renderer/src/app/App.tsx:187-193` + `useLauncherController.ts:974-993` + `settings/themeStartup.ts:11-27`】启动瞬间 3 处并发重复 `getSettings()` IPC（截图模式再加一处）。建议启动统一拉一次下发。**中低**。
- 【`apps/desktop/src/renderer/src/screenshot/ScreenshotOverlay.tsx:707-718, 416-419, 961-969`】`movePointer` 每次 mousemove 都 setState → 整棵 Overlay 树（含全屏 `<img>`、工具栏、面板）每次鼠标移动（含纯悬停）重渲染。建议 pointer/放大镜独立子组件 + rAF 节流，display imgs/工具栏 memo 隔离。**中**。
- 【`apps/desktop/src/renderer/src/screenshot/ScreenshotOverlay.tsx:345-354`】setState updater 内执行 `setLaunchVersion` 副作用，StrictMode 双调用 updater 时可能双倍递增版本造成多余 remount。建议移到 effect/reducer 外。**低**。

### 2.9 热键录入：无条件中断、悬空发送、全局注册泄漏风险

- 【`apps/desktop/src/main/index.ts:875-894`】`UPDATE_SETTINGS_CHANNEL` handler 无条件 stop 热键录入——修改任何非热键设置都会中断正在进行的 Alt+Space 录入。
- 【`apps/desktop/src/main/hotkey/altSpaceHotkeyCapture.ts:46-57`】`start(sender)` 的 sender 销毁后回调里 `sender.send`（:51）抛 "Object has been destroyed"，无 `isDestroyed` 检查。
- 渲染进程崩溃/关闭未 stop 时，Alt+Space 全局注册永久占用，launcher 热键再注册失败且无兜底。
- **建议**：仅 patch 涉及 hotkey 时才 stop；start 时监听 sender 'destroyed' 自动 stop；回调做存活检查。
- **预期收益**：中（修复交互 bug 与热键卡死风险）。

### 2.10 截图控制器 start/cancel 状态机竞态

- 【`apps/desktop/src/main/screenshot/screenshotController.ts:414-429, 515-607`】`cancel()` 对不可复用窗口 fire-and-forget `ensureOverlayWindow()` 重建，重建期 `overlayWindowPromise` 已置空，立即再 start 可能双创建窗口；渲染器就绪超时（1500ms）只 reject waiter，不统一清理已 show 的窗口。
- **建议**：overlay 重建纳入 `startInProgress` 状态机；超时与 cancel 统一清理。
- **预期收益**：中（消除快速连续截图的窗口泄漏/双窗口）。

### 2.11 更新器固定轮询、无失败退避、下载不可取消

- 【`apps/desktop/src/main/updater/updateController.ts:187, 309-321`】6h 固定 `setInterval` 无失败退避；`update-available` 自动触发 `downloadUpdate()`（:187），渲染端无法取消/延迟。
- **建议**：指数退避；下载改为渲染端显式触发或提供取消通道。
- **预期收益**：中。

### 2.12 启动路径串行：窗口显示前完成全部初始化

- 【`apps/desktop/src/main/index.ts:297-328`】`createApplicationWindow` 依次 await：服务初始化（含 `await desktopPluginService.loadEnabledPlugins()` 动态加载插件模块，:453）→ 启动同步 → 截图热键注册 → 建窗 + 注册热键；`screenshotController.prepare()` 放在窗口创建之后，主窗口与遮罩渲染器串行加载。（`startAppIndexing` 已是 void 并行，设计正确。）
- **建议**：插件加载与截图热键注册移到窗口显示后/并行；`prepare()` 提前与主窗口 load 并行。
- **预期收益**：中（启动体感）。

### 2.13 排序权重设计权衡：fuzzy 分量量级过大、exactTitle 条件过严

- 【`packages/core/src/search/ranking.ts:108-114, 258-261`】`fuzzy = 1 - fuseScore` 最高 1.0，而 pinned(0.35)、recent(≤0.25)、exactTitle(0.4)、field(≤0.6)、source(≤0.16) 合计才 ~1.76——一个中等模糊命中就能压过"精确关键字 + 来源 + 语义提升"组合。`exactTitle` 要求归一化后 query 与**整串** title 全等，"open settings" 命中 "Open Settings Panel" 拿不到加成。Fuse score 依赖文本长度，跨命令不可直接比较。
- **建议**：压缩 fuzzy 权重或非线性重缩放；为 exactTitle 增加"前缀/首词完全命中"档位；在 explanation 中输出各分量占比。**需产品确认排序行为变化**，并同步更新 `ranking.test.ts`/`searchEngine.test.ts` 排序断言。
- **预期收益**：中（排序可解释性与质量；属设计权衡）。

### 2.14 计算器大整数静默精度损失

- 【`packages/built-in-plugins/calculator/src/evaluateExpression.ts:216-218, 131`】`formatResult` 对结果 `toPrecision(12)`：超安全整数（≥16 位）在解析与输出两个环节被静默舍入（如 `99999999999999999999 + 1` 输出 `1e+21`），无"≈"提示，用户会误以为精确。
- **建议**：当输入含 ≥16 位整数或结果 `!Number.isSafeInteger(value)` 时加近似标记；必要时考虑 BigInt 支持。
- **预期收益**：中（正确性）。
- **另**：解析器本身（递归下降、无 eval、长度 4096/深度 100/一元链 100 三重防护、除零/溢出/负零处理）经核查到位，不建议替换实现。

### 2.15 Plugin API 缺失错误处理契约与文档；运行时靠错误消息子串猜分类

- 【`packages/plugin-api/src/types.ts`（全文件）】`PluginCommandHandlerResult` 只有 `void | { metadata? }`，无结构化错误类型；core 运行时【`packages/core/src/plugin/pluginRuntime.ts:887-890`】只能靠 `message.includes('handler result') || message.includes('metadata')` 猜分类，否则一律 `handler-error`。
- 整个 types.ts 无任何 JSDoc；`PluginClipboardReadTextRequest.permission`（:76-78）是纯装饰性参数（运行时按 manifest permissions 断言，请求体被忽略）；命令注册三套并存路径（`registerCommand` / `registerCommandHandler` / 模块级 `commands`）无优先级说明；`permissions` 双重暴露、`PluginStorageCapability` 无对应 permission。
- **建议**：定义结构化错误类型（如 `{ code, message }` 或 result 联合含 error 分支），删除运行时字符串猜测；为全部接口补 JSDoc；删除装饰性 `permission` 参数；收敛注册 API 或明确三者关系。
- **预期收益**：中（对第三方插件生态为**高**）。

### 2.16 桌面快捷方式被两套扫描重复解析

- 【`apps/desktop/src/main/launcher/appCandidateService.ts:316-331` + `apps/desktop/src/main/index.ts:405-418`】appIndexer 的 scanner 已含桌面目录；`listCandidates` 对非空查询又独立 readdir + PowerShell 重新解析同一批桌面 .lnk，再与索引候选去重——开销全重复。
- **建议**：桌面部分复用 appIndexer 命令，或按目录 mtime 做会话缓存。
- **预期收益**：中。

---

## 3. 低优先级 / 健壮性与维护性（P2）

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| 3.1 | `packages/core/src/indexer/windows/startMenuScanner.ts:220, 332` | 两处 `JSON.parse(stdout)` 无 try-catch，失败信息是裸 SyntaxError，无法区分超时截断与格式变化 | 包 try-catch 转成带 shortcutPath/directoryPath 上下文错误 |
| 3.2 | `packages/core/src/unitConversion.ts:60-65, 73-83` | `convertUnitValue` 不校验 value，NaN/Infinity 直通输出 `'NaN'`；`findUnitInCategory` 线性查找 | `Number.isFinite` 校验；预建 category→Map 索引 |
| 3.3 | `packages/core/src/indexer/appIndexer.ts:60-88` | 关键词大小写敏感去重，`name` 与 `name.toLowerCase()` 同时入列，产生重复 keyword 匹配 | 大小写不敏感去重（需同步测试期望） |
| 3.4 | `packages/core/src/storage/database.ts:238-245` | 未设置 `busy_timeout`（默认 0），双实例运行时第二个实例写操作直接 `SQLITE_BUSY` | open 时设 `busy_timeout`（如 5000ms） |
| 3.5 | `packages/core/src/storage/migrations.ts:112-119` | 迁移 4 的 `ALTER TABLE ADD COLUMN` 非幂等（迁移表丢失但 schema 已存在时抛错） | 执行前查 `PRAGMA table_info(plugins)` 判断列是否存在 |
| 3.6 | `packages/core/src/plugin/validateManifest.ts:357-451` | id/name/description/commands/keywords 无长度与数量上限，可生成超长 host command id 造成内存/索引膨胀 | 增加合理上限（id ≤ 100、commands ≤ 100、keywords ≤ 20）与 permissions 去重 |
| 3.7 | `packages/core/src/plugin/pluginRuntime.ts:520-568` | 幂等 enable 分支仍先读盘 + parse + 完整校验 manifest 再短路 | 进入 loadPlugin 前按 pluginRoot 查已启用状态短路 |
| 3.8 | `packages/core/src/plugin/pluginRuntime.ts:672, 768-822` | disabled 插件 state（含模块实例、context）永久留在 `pluginsById`，无法真正卸载 | 提供显式卸载/释放 API；文档化"热更新需重启" |
| 3.9 | `packages/core/src/plugin/pluginInspection.ts:25-43` | safe 安装路径下 installPlugin 与 enablePlugin 各读盘+parse+校验一次 manifest | 安装流程缓存 inspection 结果，启用时复用 |
| 3.10 | `packages/core/src/storage/pluginRepository.ts:298-337` | `upsertPlugin` 每次 3 次查询（前置全行 SELECT + upsert + 回读），2 次 JSON.parse | 前置 SELECT 只取 3 列；回读改 RETURNING 或省略 |
| 3.11 | `packages/core/src/storage/settingsRepository.ts:202-208` | `updateSettings` 无节流/合并，每次全量读-改-写并重写整份 JSON（含热键重注册链路） | 结合 2.1 内存缓存 write-through；高频 patch 时 IPC 层防抖合并 |
| 3.12 | `packages/core/src/search/searchEngine.ts:496-516` | 每次搜索为 boosted 文档（pinned/history）新建 Fuse 子索引且不缓存 | 随 `update()` 预构建并缓存，代际变化时失效 |
| 3.13 | `packages/built-in-plugins/clipboard-history/src/clipboardWatcher.ts:19, 69-77` | `start()` 后首个 poll 等满 1s；trim 去重导致 "a" → "a " 的空白变体被丢弃（与 repository "更新原文"语义不一致） | start 时立即 poll 一次；明确 trim 去重语义 |
| 3.14 | `packages/built-in-plugins/text-tools/src/index.ts:89-95` | `action.payload.transform` 死字段（消费方从 command.id 反查 kind） | 删除或改为单一事实来源 |
| 3.15 | `packages/built-in-plugins/text-tools/src/transforms.ts:96-97` | `url-encode` 用 `encodeURIComponent`，未转义 `!'()*`（严格 RFC 3986 应转义） | 补一次 `replace(/[!'()*]/g, ...)`（属标准争议，可按产品取舍） |
| 3.16 | `apps/desktop/src/main/launcher/exchangeRateCache.ts:117-123` | `readCacheFile` catch 分支两个都 return undefined，ENOENT 判断无实际作用（死代码） | 删除或让损坏缓存打 warn 日志 |
| 3.17 | `apps/desktop/src/main/icons/windowsAppUserModelIconResolver.ts:38-111` | 每次解析 AUMID 图标都全量 `Get-AppxPackage` 枚举（3s 超时），包列表无缓存 | 会话级缓存 packageFamilyName→InstallLocation |
| 3.18 | `apps/desktop/src/main/icons/appIconResolver.ts:433-466` | 打包应用图标候选探测（13 个路径 × fileExists）无缓存 | root→资源列表会话缓存，或一次目录读取 |
| 3.19 | `apps/desktop/src/main/icons/searchResultIconHydration.ts:25-47` | 图标异步回填无查询代次校验，旧查询图标仍推送（无效 IPC + 潜在错配） | 携带 requestId/代次，渲染端丢弃过期结果 |
| 3.20 | `apps/desktop/src/main/launcher/desktopShortcutCommands.ts:16-18` | `readdirSync` 同步扫盘工具生产代码未使用（仅测试引用），死代码 + 同步 API 隐患 | 删除或改异步并统一 |
| 3.21 | `apps/desktop/src/preload/index.ts:563-573` | pinned-image 窗口暴露整个 screenshot API（含 cancel/pinImage/runOcr/translateSelection），实际只需 getPinnedImageState/onLaunchState | 按窗口角色细分 sub-api |
| 3.22 | `apps/desktop/src/main/index.ts:251-295` | 三份几乎相同的窗口参数构造（getWindowOptions / getScreenshotOverlayWindowOptions / getPinnedImageWindowOptions） | 合并为带角色参数的构造器 |
| 3.23 | 多处（`windowsAssociatedIconResolver.ts:63-73`、`windowsAppUserModelIconResolver.ts:113-134`、`localOcr.ts:49-51,214-220`、core `startMenuScanner.ts:180-182,278-288`） | PowerShell 编码/执行样板重复；`createDesktopShortcutTitle` 在两处重复 | 提取共享工具 |
| 3.24 | `apps/desktop/src/main/index.ts:995-1021` | 退出路径 `will-quit` 仅 fire-and-forget 数据库关闭，SQLite 可能未关闭完进程就退出；`before-quit` 无 runtime 时直接 return | 只要 DB 存在就走异步 preventDefault 关闭 |
| 3.25 | `apps/desktop/src/renderer/src/plugin-host/pluginBridge.ts:96-107` | `reportError` 消息无长度上限 | 限制长度（如 4KB） |
| 3.26 | `apps/desktop/src/renderer/src/launcher/useLauncherController.ts:138-295` | fallbackDesktopApi（约 160 行 mock）混在生产 hook 文件 | 移到测试工具目录 |
| 3.27 | `apps/desktop/src/renderer/src/screenshot/ScreenshotOverlay.tsx`（约 1811 行） | 组件过大，状态（dragMode/ocrPanel/translationPanel/pointer 等）集中一处 | 继续拆分 Toolbar/面板/独立状态钩子 |
| 3.28 | `apps/desktop/src/shared/` 8 个 API 文件 | `isRecord`/`parseString`/`parseBoolean`/`parseFiniteNumber` 等解析辅助各自重复 | 抽 `shared/parsers.ts`（正面确认：main 与 renderer 已共用 shared 解析器，无各一份 parser 问题） |

---

## 4. 值得肯定的设计（无需改动）

分析中核查确认以下部分实现到位，**不建议改动**，供后续评审参考：

1. **计算器表达式求值器**（`packages/built-in-plugins/calculator/src/evaluateExpression.ts`）：手写递归下降解析，无 eval/Function 注入面；长度 4096 / 嵌套深度 100 / 一元链 100 三重 DoS 防护；除零、溢出、负零规范化均有处理与测试。
2. **数据库层**（`packages/core/src/storage/database.ts`）：连接单例、statement 全部预编译复用（无每次 prepare）；WAL + 外键已启用；事务支持 savepoint 嵌套并拒绝异步 handler。
3. **迁移框架**（`packages/core/src/storage/migrations.ts`）：记录式迁移（migrations 表记录已应用项），只跑缺失项，每个迁移独立事务，带 ID/名称/顺序一致性校验。
4. **图标解析器分层缓存设计**（`apps/desktop/src/main/icons/appIconResolver.ts`）：路径级内存缓存（有界 96）+ 失败路径集合 + 快捷方式候选缓存 + 磁盘 dataUrl 缓存（带版本与指纹）+ 超时控制。问题只在"在途去重未接入主路径"与"写盘批量化"两点（见 1.5）。
5. **IPC 边界**（`apps/desktop/src/shared/`）：main/preload/renderer 共用同一套解析器，未知/畸形输入在边界被拒绝；渲染端 requestId 防陈旧响应（`useLauncherController.ts:637-651`、`AddAppPicker.tsx:335-356`）保证结果不错乱。
6. **插件错误隔离**（`packages/core/src/plugin/pluginRuntime.ts`）：activate/deactivate/命令 handler 均有 try/catch + 超时 + 结构化失败结果；命令注册失败完整回滚；重复/冲突 ID 有明确拦截与回滚（有测试覆盖）。
7. **i18n**（`apps/desktop/src/renderer/src/i18n.ts`）：静态字典 + 查表，不阻塞首屏，语言切换无全局刷新成本，无需按语言分割。
8. **搜索结果数量控制**：主进程默认上限 10、按设置 `min(100, maxResults)`；首页网格 12 条双重截断。当前规模无需虚拟列表。
9. **生命周期管理**（`apps/desktop/src/main/desktopApplication.ts`）：窗口创建 promise 去重（pendingWindowCreation）、监听器清理路径完整；单实例锁、WAL 设置、退出清理链结构清晰。

---

## 5. 优化实施路线图（建议顺序）

### 阶段 1：搜索响应性（目标：消除每次按键的重活）

| 任务 | 涉及文件 | 风险 | 验证 |
|------|----------|------|------|
| 渲染端搜索防抖 80-150ms | `useLauncherController.ts:1011-1053`、`AddAppPicker.tsx:322-356` | 低 | 现有单测 + 手动打字 |
| 搜索索引代际缓存：数据未变不重建，4 次 `refreshSearchIndex` 合并为 1 次 | `launcherCommandService.ts:891-922` | 中 | 现有 launcherCommandService.test.ts 全套 |
| 动态命令（计算器/换算/汇率结果）改 `upsert` 增量更新 | `searchEngine.ts:409-413`、`launcherCommandService.ts` | 中 | searchEngine.test.ts 补 upsert 路径用例 |
| settingsRepository 内存读缓存 | `settingsRepository.ts:188-198` | 低 | settingsRepository.test.ts + 手动改设置 |
| 历史读取轻量化（复用查询、免 metadata 列、RETURNING） | `historyRepository.ts:112-195`、`launcherCommandService.ts:677-707` | 低 | historyRepository.test.ts |
| 汇率 TTL + cache-first + 在途去重 + 不 await | `exchangeRateCache.ts:186-206`、`launcherCommandService.ts:899` | 中 | exchangeRateCache.test.ts 需同步更新 |
| 补 `update()` 性能测试（防回归） | `searchEngine.test.ts` | 低 | 新增 perf 用例 |

### 阶段 2：索引与图标资源（目标：消除进程/磁盘风暴）

| 任务 | 涉及文件 | 风险 | 验证 |
|------|----------|------|------|
| 快捷方式批量解析（单次 PowerShell 返回 JSON 数组） | `startMenuScanner.ts:116-360` | 中 | startMenuScanner.test.ts 基于注入 execFile，改动可控 |
| 图标解析在途去重接入主路径 + 并发池（4-8） | `appIconResolver.ts:657-713`、`index.ts:790-796` | 中 | appIconResolver.test.ts + AddAppPicker 手动 |
| 图标缓存写批量化（脏标记 + 500ms 防抖合并） | `iconDataUrlCache.ts:143-163` | 低 | iconDataUrlCache.test.ts |
| 更新检查节流（10 分钟）或移除 focus 触发 | `updateController.ts:255-293`、`LauncherPage.tsx:305-309` | 低 | updateController.test.ts |

### 阶段 3：截图与启动

| 任务 | 涉及文件 | 风险 | 验证 |
|------|----------|------|------|
| OCR/翻译串行队列 + 结果 hash 缓存 | `localOcr.ts:277-335`、`screenshotController.ts:493-499` | 中 | screenshotController.test.ts + 手动多屏 |
| 截图导出复用已解码图片 | `ScreenshotOverlay.tsx:515-529, 884-913`、`screenshotCanvas.ts:72-109` | 中 | ScreenshotOverlay.test.ts |
| 截图状态机竞态修复 | `screenshotController.ts:414-429, 515-607` | 中 | 补并发用例 |
| 启动并行化（插件加载/截图 prepare 延后或并行） | `index.ts:297-328` | 中 | 启动冒烟 |

### 阶段 4：健壮性与 API 治理

| 任务 | 涉及文件 | 风险 | 验证 |
|------|----------|------|------|
| 插件运行时并发 enable 去重 + 超时语义修复 | `pluginRuntime.ts:236-251, 515-675` | 中 | 补并发/超时用例 |
| Plugin API 结构化错误契约 + JSDoc + 删除装饰参数 | `plugin-api/src/types.ts`、`pluginRuntime.ts:887-890` | 中（API 变更） | 需版本策略（docs/product/versioning-policy.md） |
| 深拷贝链削减、tokenize/ranking 去重规范化 | `appIndexer.ts`、`indexCache.ts`、`commandRegistry.ts`、`tokenize.ts:197-211`、`ranking.ts:245-262` | 低 | 现有测试全绿 + perf 对比 |
| 剪贴板热路径（全表扫描/预览截断/事件驱动刷新） | `clipboardRepository.ts:155-169`、`clipboard-history/index.ts:21-43`、`launcherCommandService.ts:589-609` | 中 | clipboardHistory.test.ts |
| P2 列表批量清理（3.1-3.28） | 见各条目 | 低 | 逐项补测试 |
| 排序权重再平衡（fuzzy 压缩、exactTitle 前缀档位） | `ranking.ts:108-114, 258-261` | 中（行为变化） | 需产品确认 + 更新排序断言 |

---

## 6. 附注与限制

- 本报告为只读静态分析，未做运行时 profiling；各条目的"预期收益"为基于代码路径与调用频率的估计，实施前建议以 `apps/desktop` 实测（启动耗时、打字延迟、主进程 CPU）校准。
- 行号为分析时（2026-08-13）仓库状态，代码变动后可能漂移，实施时以函数名为准。
- 被现有测试固化的行为（如汇率"先实时后缓存"、剪贴板"规范化重复更新原文"）在对应条目标注，改动需同步测试。

---

## 7. 实施记录：阶段 1（搜索响应性）— 2026-08-13

阶段 1 已实施并通过全部相关测试（typecheck 与全量 vitest 见实施时验证）。逐项状态：

| 报告条目 | 实施内容 | 状态 |
|----------|----------|------|
| 1.1 每次按键 4 次全量重建 | ① 渲染端搜索加 150ms 防抖（`useLauncherController.ts`）；② 服务层引入 `appCommandsVersion` / `clipboardHistoryVersion` 代际检测，数据未变时跳过注销/重注册与全量重建；③ `refreshSearchIndex` 改为脏标记 + `flushSearchIndex` 单次合并重建（每次按键 0~1 次全量重建）；④ 计算器/单位换算动态命令改 `searchEngine.upsert` 增量更新（`searchEngine.ts` 实现真正增量 add/remove，不再 O(N) 重克隆）；⑤ 新增 `update()`/`upsert()` 性能回归测试 | ✅ |
| 1.2 汇率每次按键 await 网络 | `exchangeRateCache` 改 cache-first + TTL（默认 1h）+ in-flight 去重：新鲜缓存零网络请求，不新鲜缓存立即返回旧值并后台刷新；新增 `ttlMs`/`clock` 选项与 4 个测试 | ✅ |
| 2.1 设置每次按键读库 | `settingsRepository` 惰性内存读缓存（`getSettings` 返回 `structuredClone`，update/reset 失效写回）；新增 5 个缓存测试 | ✅ |
| 2.2 历史轻量读取 | `historyRepository` 新增 `listRecentForRanking`（只 SELECT 4 列、不解析 metadata，两处消费方已切换）；`recordExecution` 改 `RETURNING` 单语句（2 次查询 → 1 次）；新增 3 个测试 | ✅ |
| 1.8 AddAppPicker 无防抖 | `AddAppPicker` 候选搜索加 200ms 防抖（requestId 防陈旧逻辑保留） | ✅ |
| 接线 | `main/index.ts`：`appCommandsVersion`（appIndexer 新增 `getCommandsVersion()`，load/refresh 变更命令时递增）、`clipboardHistoryVersion`（watcher 保存成功后递增） | ✅ |

实施中发现并修复的额外问题：

- **Fuse.js 数组别名陷阱**（新增测试暴露）：`Fuse` 构造时保存 documents 数组**引用**，`fuse.add()` 会向 `SearchEngine.documents` 重复 push，导致 upsert 后同一文档在精确匹配遍历中出现两次。修复：`update()` 向 Fuse 传浅拷贝，隔离数组所有权（`searchEngine.ts`）。

验证记录（2026-08-13）：

- `corepack pnpm typecheck`（tsc -b）通过；
- `corepack pnpm test` 全量通过：103 个测试文件 / 884 个测试（新增 24 个：searchEngine 9、appIndexer 2、launcherCommandService 3、settingsRepository 5、historyRepository 3、exchangeRateCache 4，及 useLauncherController 6 个防抖用例，部分计数随 it.each 展开）；
- 全部改动文件通过 `prettier --check`。
- 覆盖说明：`useLauncherController` 防抖有 6 个挂载级用例（含假 DOM shim、fake timers、卸载取消与防陈旧）；`AddAppPicker` 防抖沿用同一模式（现有 8 个 View 级测试全部保持通过），其 effect 未单独挂载测试（模式与前者一致，可后续补充）。

---

## 8. 实施记录：阶段 2-4 — 2026-08-13

阶段 2/3/4 已实施并通过全部验证（typecheck + 105 文件 / 966 测试全绿 + prettier）。逐项状态：

### 阶段 2（索引与图标资源）

| 报告条目 | 实施内容 | 状态 |
|----------|----------|------|
| 1.3 每个 .lnk 一个 powershell.exe | `ShortcutResolver` 新增可选 `resolveMany`，`createWindowsShortcutResolver` 单次 PowerShell 批量解析（路径数组 base64 嵌入、逐路径 try/catch、同序返回）；`scanDirectory` 与 `appCandidateService.listCandidates` 优先批量、回退逐条；`mapWithConcurrency` 导出供复用；顺带修复两处裸 `JSON.parse`（带 cause 错误） | ✅ |
| 1.5 图标解析无在途去重 + 磁盘缓存整文件重写 | `appIconResolver` 增加 `pendingIconResolutions`/`pendingShortcutResolutions` 路径级在途去重（并发共享同一次解析）；打包应用资源探测按 root 缓存；`iconDataUrlCache` 改脏标记 + 防抖/最大等待批量写盘（读立即可见）；AUMID 包清单缓存（原代码已有，确认保留） | ✅ |
| 1.4 每次聚焦触发更新检查 | `updateController` 手动检查冷却（默认 10 分钟，`manualCheckCooldownMs` 可配）；自动检查不受冷却限制；失败也计入冷却 | ✅ |
| 1.8 图标解析并发无上限 | `main/index.ts` LIST_APP_CANDIDATES 改 `mapWithConcurrency(…, 4, …)` 并发池；并接线 `resolveShortcuts` 批量桌面快捷方式解析 | ✅ |

### 阶段 3（截图与启动）

| 报告条目 | 实施内容 | 状态 |
|----------|----------|------|
| 2.10 截图状态机竞态 | 修复 overlay 关闭处理器无条件清空 `overlayWindowPromise` 的竞态（旧窗口迟到的 closed 事件不再误清新窗口的在途创建 promise），消除取消重建期再次 start 的双窗口 | ✅ |
| 1.6 OCR 无队列/复用 | `screenshotController.runOcr` 增加串行队列（深度上限 4）+ 图片 sha256 结果缓存（64 条 LRU，仅缓存成功结果）；新增 5 个测试（串行化/缓存命中/深度拒绝/LRU 淘汰/竞态） | ✅ |
| 1.7 截图导出重复解码 | `screenshotCanvas.loadBrowserImage` 支持复用已加载元素（complete + src 匹配则零解码返回）；`ScreenshotOverlay` 用 ref Map 收集 onLoad 元素并传入组合流程；双路径回退保留 | ✅ |
| 3.12 启动串行 | 插件加载移出关键路径（后台 `loadEnabledPlugins`，完成后经新增 `refreshCommands()` 标记索引重建——修复阶段 1 引入的"插件命令不可搜索"缺口）；`screenshotController.prepare()` 提前与主窗口创建并行；插件 IPC（安装/启停/删除）操作后同样刷新 | ✅ |
| 3.24 退出路径数据库关闭 | `before-quit` 守卫从 `clipboardHistoryRuntime` 改为 `commandCabinDatabase`（启动期退出也能干净关闭 SQLite） | ✅ |

### 阶段 4（健壮性与 API 治理）

| 报告条目 | 实施内容 | 状态 |
|----------|----------|------|
| 2.7/5 插件并发 enable 竞态 | `pluginRuntime` 按 pluginRoot 维护 in-flight 去重，并发 enable 共享同一次加载；失败后清理可重试 | ✅ |
| 2.7/6 moduleLoad 超时焊死 | 超时错误新增 `module-load-timeout` 码 + 明确"需重启应用重试"提示 | ✅ |
| 2.7/7 插件日志无限增长 | `pluginLifecycle` 环形缓冲（默认 1000，可配），`log()` 深克隆 3→1 次 | ✅ |
| 3.6 validateManifest 无上限 | id/name/description/main/ui/version/commands/title/keywords 长度与数量上限；permissions 保序去重 | ✅ |
| 3.10 pluginRepository 3 次查询 | 前置 SELECT 收窄 3 列；upsert 改 `RETURNING` 单语句 | ✅ |
| 2.4/3 深拷贝链 5-6 层 | `appIndexer` refresh/load 保留"1 构造 + 1 边界"克隆，`indexCache.write` 去返回处二次克隆；`getCommands` 边界克隆保留 | ✅ |
| 2.5/4 tokenize 双重规范化 | `normalizeSearchTextWithMapping` 直接复用映射管道 `text`（等价性经 14 组样例 + 10 组映射不变式验证） | ✅ |
| 2.5/5 ranking 重复规范化 | `SearchRankingInput` 新增可选 `normalizedQuery`/`normalizedTitle`，searchEngine 4 处调用点传入缓存值 | ✅ |
| 2.6/3 剪贴板热路径 | 迁移 5：`clipboard_history.normalized_text` 列 + 索引；去重改索引查询（删除全表扫描）；`truncatePreview` 先截 200 再折叠且预览只算一次；watcher start 立即首 poll；迁移 4 幂等化（`StorageMigration.apply` 可选钩子） | ✅ |
| 3.22 窗口参数重复 | `createWindowRenderOptions` 合并三份窗口参数构造 | ✅ |
| P2 杂项（3.1/3.2/3.14/3.16/3.20/3.25/3.28） | startMenuScanner JSON.parse 容错（并入批量解析）；unitConversion 有限值校验 + Map 索引；text-tools 死字段删除；exchangeRateCache 死分支清理；desktopShortcutCommands 死代码删除；pluginBridge 消息 4096 上限；`shared/parsers.ts` 抽取（7 个 api 文件复用，hotkeyInput 私有 isRecord 保留） | ✅ |

### 明确跳过（报告标注需产品确认或高冲突低价值）

- 2.13 排序权重再平衡、2.15 Plugin API 契约变更（需产品确认 + 版本策略）；
- 3.15 url-encode `!'()*` 转义（标准争议，按产品取舍）、3.11 设置写节流（非热路径）、3.21 preload 收窄（结构风险大于收益）、3.26 fallback mock 移动（构建配置约束）、3.27 ScreenshotOverlay 拆分（高冲突低价值）、3.23 PowerShell 样板抽取（跨文件低价值重构）、3.9 pluginInspection 重复解析（低频路径）、3.17 AUMID 缓存（原代码已实现）、3.12 boosted Fuse 缓存（提升文档集 ≤100 且依赖每次搜索的 pinned/history 上下文，预缓存复杂且收益低，保留每次搜索现建子索引）。

### 实施中发现并修复的额外问题

- **插件命令可搜索性缺口**（阶段 1 引入）：索引只在"脏"时重建后，后台插件加载不会触发重建 → 插件命令不可搜索。修复：`LauncherCommandService` 新增 `refreshCommands()`，插件加载完成与插件 IPC 操作后调用（`main/index.ts` 接线）。
- **关联图标回退语义回归**（图标子代理实现中引入）：in-flight 去重重构把关联图标回退条件从"非图片文件来源（`imageDataUrl === undefined`）"误改为"无原生图标"，导致 exe 通用图标不再尝试更精确的关联图标。修复：去重 promise 携带 `imageFileDataUrl` 来源信息，恢复原语义（新增测试覆盖）。
- **Fuse 浅拷贝隔离**（阶段 1，见第 7 节）。

### 最终验证（2026-08-13，阶段 2-4 完成后）

- `corepack pnpm typecheck`（tsc -b）通过；
- `corepack pnpm test` 全量通过：**105 个测试文件 / 966 个测试**（阶段 1 的 103/884 基础上新增 82 个）；
- 全部改动文件通过 `prettier --check`。

- 排序权重调整（2.13）与 Plugin API 变更（2.15）属行为/契约变化，需走产品确认与版本策略，不与其他条目混排。
