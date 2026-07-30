# CommandCabin 产品工程审计报告

日期：2026-07-30
范围：`apps/desktop`、`packages/core`、`packages/plugin-api`、全部内置插件、跨包测试与
Windows 打包配置。

## 1. 结论摘要

CommandCabin 的主产品链路是清晰的：Windows 应用发现进入统一命令注册表，搜索层完成
排序，执行层处理应用、文件、URL、系统命令和插件，Electron 主进程负责持久化与系统能力，
React renderer 负责启动器、设置、截图和插件页面。

本轮审计发现三类问题：

1. **已经直接影响用户的逻辑缺陷**：搜索完成后无限重搜、点击结果可能执行旧选中项、
   第 12 个首页应用不可见但可执行、键盘 Enter 双触发、截图 ready 超时后永久卡死、
   搜索结果受 `limit` 影响、剪贴板内容被改写且失败不重试。
2. **需要架构治理的发布风险**：第三方插件在 Electron 主进程直接执行、窗口与 IPC
   缺少角色边界、安装器无所有权验证地递归删除旧目录。
3. **产品能力的中间态**：插件/收藏/数据设置已有大量实现但用户不可达；两套单位换算、
   两套固定/收藏概念和若干未接线配置造成维护冗余。

本轮先修复 10 组直接影响用户的问题，随后完成全部发布门槛与高优先级可靠性治理：
Electron 窗口角色、最小 preload、IPC sender/origin guard、默认拒绝的权限策略已经落地；
第三方插件在独立隔离运行时完成前进入默认停用的安全模式；安装器不再递归删除无法确认
所有权的旧目录。启动器、设置页、截图链路、搜索、索引和持久化也完成了配套优化。

## 2. 工程逻辑地图

```text
Windows Start Menu / Desktop / AppsFolder
                  │
                  ▼
              AppIndexer ─────────────── app cache
                  │
                  ▼
Favorites ──► CommandRegistry ◄── Built-ins / PluginRuntime
                  │
                  ▼
     SearchEngine (Fuse + ranking boosts)
                  │
                  ▼
          Launcher renderer result list
                  │
                  ▼
           CommandExecutor
      ┌───────────┼────────────┐
      ▼           ▼            ▼
 open app/path  copy/system   plugin handler/UI
      │           │            │
      └───────────┴────► HistoryRepository
```

主进程同时持有以下系统服务：

- SQLite：settings、history、favorites、plugins、plugin data、clipboard history。
- Windows 集成：全局热键、托盘、自启动、应用扫描和快捷方式解析。
- 截图：多屏捕获、overlay、标注、OCR、翻译、保存和贴图。
- 更新：检查、下载与安装。
- preload/IPC：向 renderer 暴露类型化 `window.desktopApi`。

内置插件：

- Calculator：表达式解析与复制结果。
- Quick Converter：长度、重量、体积与汇率换算。
- Clipboard History：轮询剪贴板、持久化和动态搜索结果。
- Text Tools：大小写、空行、JSON 和 URL 处理。

## 3. 本轮已修复问题

| ID   | 级别 | 问题与根因                                                                                                                                                 | 本轮处理                                                                                              |
| ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| F-01 | P0   | 搜索成功后根据 `ready` 状态继续生成新 request ID，形成 `search-started → search-succeeded → 再搜索` 无限循环，浏览器持续报 `Maximum update depth exceeded` | request ID 只由初始加载、查询变化和显式刷新推进；完成后复用当前 ID。增加同查询/同选中项短路与回归测试 |
| F-02 | P1   | 结果行点击只执行“全局当前选中项”；触屏、辅助技术或程序化点击 B 时可能执行 A                                                                                | 点击将实际 `commandId` 直接传给执行器；键盘 Enter 仍执行当前选中项                                    |
| F-03 | P1   | 首页状态保留 12 个应用，但结果列表为“+”按钮预留一格，只渲染 11 个；键盘可选到不存在的第 12 个 DOM option                                                   | “添加应用”移到统一首页操作栏，网格完整渲染 12 个可选项                                                |
| F-04 | P1   | SearchEngine 在精确候选数量达到 `limit` 时跳过 Fuse 候选，导致同一查询在 `limit=1/2` 下第一名不同                                                          | 精确候选与 Fuse 候选合并、去重后统一评分和排序                                                        |
| F-05 | P1   | 文本归一化折叠空白/NFKD 后的索引直接用于原字符串，搜索高亮错位                                                                                             | 新增归一化字符到原字符串区间映射，高亮结果回映原文                                                    |
| F-06 | P1   | Add App 对话框拦截所有冒泡 Enter，关闭/浏览/添加按钮会同时触发候选添加                                                                                     | 方向键和 Enter 只在搜索框/候选导航区域处理，按钮保留原生键盘语义，Escape 仍关闭对话框                 |
| F-07 | P1   | 截图全局 Enter 未排除 button/select/contenteditable，工具栏按钮可能同时“完成截图”和执行自身动作                                                            | 全局快捷键识别交互目标；Enter 不再劫持工具栏控件，Escape 对输入控件和普通区域分别处理                 |
| F-08 | P1   | 截图 renderer ready 超时被吞掉，active state 和窗口不清理，后续截图永久被拒绝                                                                              | `start()` 等待 ready；超时进入统一 catch，清状态、关闭旧 overlay，下一次截图可恢复                    |
| F-09 | P1   | 剪贴板历史对原文 `trim()`，并在持久化成功前更新 last value，导致空白丢失且临时失败后不重试                                                                 | 只用独立归一化值判空/判重，保存原文；成功后才推进 last value，失败后同内容下一轮重试                  |
| F-10 | P1   | Reload Launcher、Open Diagnostics 对用户显示成功但没有副作用；未知系统命令也伪报 handled                                                                   | 暂时移除两个未实现命令；未知 `run-system` 命令返回失败，待真正实现 diagnostics 后再暴露               |

## 4. 发布门槛与可靠性治理结果

### 4.1 发布阻断项

| ID   | 原风险                                                         | 处理结果                                                                                                                                                 | 状态     |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| R-01 | Electron 窗口、preload 与 IPC 缺少可信边界                     | 为 launcher、screenshot、pinned image 建立窗口角色和最小 API；所有 IPC 校验角色、main frame 与精确 URL；阻断导航/新窗口；session 权限默认拒绝；启用 sandbox | 已完成   |
| R-02 | 插件 permissions 不能约束直接运行在 Electron 主进程的第三方代码 | 生产环境进入插件安全模式：安装只做静态检查和登记，既有插件升级后自动停用，UI 禁止启用；插件 guest session 默认拒绝权限。独立可终止运行时作为后续正式开放条件 | 已安全化 |
| R-03 | NSIS 升级脚本可能递归误删非本产品目录                          | 移除无所有权证明的 `RMDir /r` 迁移；打包配置测试明确禁止重新引入递归删除                                                                                  | 已完成   |

### 4.2 高优先级可靠性

| ID   | 处理结果                                                                                                       | 状态   |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------ |
| R-04 | 插件安装、启用、停用操作进入全局串行队列，消除 repository、runtime 与 registry 的分裂竞态                     | 已完成 |
| R-05 | 已启用插件遇到不同 root/version 的同 ID 实例时明确拒绝，避免运行旧代码却记录新目录                             | 已完成 |
| R-06 | 对外 manifest 使用深拷贝冻结快照；安装前只做静态目录、manifest 与入口文件检查，不导入第三方代码                | 已完成 |
| R-07 | module load、activate/deactivate 和 command handler 分别设置有限超时；生产安全模式不执行第三方代码             | 已完成 |
| R-08 | Quick Converter 使用 generation 丢弃过期汇率响应，并拒绝非正、非有限汇率与中间结果溢出                       | 已完成 |
| R-09 | launcher、screenshot、delayed screenshot 三个热键在注册和持久化前统一执行最终唯一性校验                       | 已完成 |
| R-10 | warm screenshot overlay 在屏幕捕获完成前保持隐藏，避免把自身坐标和遮罩拍入结果                                | 已完成 |
| R-11 | overlay/贴图窗口加载失败会销毁窗口并清理 controller 状态；ready 超时后可立即重试                               | 已完成 |
| R-12 | JSON formatter 在 parse/stringify 前扫描字符串外数值，拒绝不安全整数和非有限指数                              | 已完成 |
| R-13 | Start Menu 快捷方式使用默认 8 路有界并发解析，并保持稳定输出顺序                                               | 已完成 |
| R-14 | 截图 OCR/翻译/保存/贴图增加互斥 busy 状态和 request generation，过期响应不能覆盖新结果                         | 已完成 |
| R-15 | 屏幕图片增加 `onError` settled 路径和可退出错误态，不再无限等待 overlay ready                                 | 已完成 |

### 4.3 中优先级工程债

- SQLite `transaction()` 在运行时拒绝 thenable handler，并验证异常和异步误用都会回滚。
- AppIndexer 使用 single-flight refresh 与 generation，迟到的 cache load 不能覆盖新扫描结果。
- 图标缓存写入串行化，使用同目录临时文件加 rename 原子替换。
- 设置页加载和保存使用 mutation generation，迟到加载不会覆盖用户刚完成的修改。
- 插件数据聚合使用 null-prototype 对象，并限制 key 长度和控制字符。
- Quick Converter 对汇率及每一步换算结果做正数/finite 检查。
- 在线翻译显示 provider、2000 字符上限和首次显式同意；IPC 还要求
  `onlineConsent: true`，文本通过 POST body 发送，失败后不会自动转交第二家服务。

## 5. UI 布局优化结果

### 启动器

- 将原本占据第 12 个应用位置的微型“+”移出结果网格。
- “添加应用 / 单位换算 / 截图”统一为底部三等分操作栏，功能层级一致。
- 结果选中态不再使用改变几何位置的位移，避免鼠标边界抖动。
- 首页最多 12 个应用与键盘选择模型保持一致。

### 设置页

- 从单列长列表改为桌面端双栏卡片，760×520 默认窗口中主要设置可在一个视口内浏览。
- About 从首项移到系统信息末尾并跨双栏展示。
- Clipboard History 纳入统一设置卡片，和 Startup 组成平衡的末行。
- 页面主标题改为本地化“设置”，CommandCabin 作为产品 kicker。
- 520px 以下自动退化为单栏。

本轮继续完成：

1. 三个快捷键卡片已合并为一张“全局快捷键”设置表。
2. 键盘选中结果会自动滚动到可见区域。
3. 截图 OCR/翻译/保存已显示忙碌态，并禁用冲突操作。
4. Plugin、Favorites、Data 设置已重新挂载；默认窗口和 500px 窄窗口均完成响应式验收。

后续 UI 增强可以集中在右键菜单键盘可达性，以及设置项继续增长后的分类导航/设置搜索；
这两项不影响 v0.9.0 的现有功能闭环。

## 6. 功能完整性、冗余与新增建议

### 6.1 当前能力是否冗余

产品主线不冗余，但以下能力重复或处于“实现了一半”的中间态：

1. **两套单位换算**
   `core/unitConversion.ts` 与 Quick Converter 各维护单位和常量。应统一为 conversion
   catalog。独立页面只有在提供更多类别、历史、收藏、批量输入时才值得保留；否则以搜索换算
   为主，移除独立入口。

2. **收藏与固定应用两个近似模型**
   应统一为“固定项目”，支持应用、文件、文件夹和 URL；首页与设置只提供不同视图。

3. **三个快捷键卡片是 UI 重复**
   数据模型可以保留三个字段，界面合并为一张表。

4. **此前不可达的成熟组件（已处理）**
   FavoritesSettings、PluginSettings、DataSettings 已重新挂载到 SettingsPage。插件管理
   采用明确的安全模式，避免“页面可见”被误解为第三方代码已获执行权限。

5. **此前的幽灵配置（已处理）**
   `maxResults/historyBoost/pluginBoost/appBoost/fileBoost` 已接入生产搜索；最大结果数会被
   夹紧到 0–100，source 与 history 权重进入实际评分。

6. **插件 storage/API 中间态**
   类型和 repository 存在，但生产 runtime 未正确按 plugin ID 注入。未接线前不应对插件作者
   宣称可用。

7. **旧 defaults 与重复公开类型**
   默认设置模型及 PluginPermission/JSON value 在多个包重复定义，应收敛到单一 schema/SDK。

### 6.2 建议新增，按优先级排序

第一优先级：

- **真正的 Diagnostics**：热键注册、应用索引、插件加载、DB/迁移、更新状态和日志导出。
- **剪贴板隐私中心**：暂停记录、敏感应用排除、自动过期、固定条目、敏感内容检测和清理。
- **索引诊断**：手动重建、失败快捷方式列表、排除目录和来源说明。
- **插件安全中心**：来源/签名、权限详情、版本兼容、更新/重载、崩溃和资源用量。
- **全局执行反馈**：命令成功/失败 toast，避免窗口隐藏后用户不知道发生了什么。

第二优先级：

- 命令别名、自定义关键词和拼音/首字母搜索。
- 固定项目导入/导出、设置备份和迁移前备份。
- 截图窗口捕捉、OCR 语言包状态、翻译联网提示、标注对象移动/缩放。
- 贴图缩放、透明度、鼠标穿透、复制和保存。
- 单位换算历史、收藏和更多类别。
- 新用户引导与快捷键冲突诊断。

## 7. 实施状态与后续顺序

### v0.9.0 已完成

1. Electron sender/origin/role/permission 边界。
2. 插件安全模式、静态检查、生命周期串行化、超时和不可变 manifest。
3. 安装器递归删除风险治理。
4. 截图 capture-before-show、异步状态、热键冲突和图片加载恢复。
5. 搜索设置接线、应用扫描有界并发、索引 single-flight、图标 cache atomic write。
6. Plugin/Favorites/Data 设置重新开放并完成响应式布局验收。

### 下一迭代

1. 在独立、可终止的受限进程中实现插件运行时，再开放第三方插件执行。
2. 统一 conversion、favorites/pinned 和设置 schema。
3. 完善右键菜单键盘可达性；设置继续扩张后增加分类导航或设置搜索。
4. 建设 diagnostics、剪贴板隐私中心与索引诊断。

### 后续产品增强

先建设 diagnostics、隐私与数据管理，再增加更多工具。CommandCabin 的优势应继续保持为
“快速、可预测的桌面入口”，避免在可靠性和权限边界完成前扩展成庞大的工作流平台。

## 8. 验证策略

本轮采用：

- 全仓 install、format、typecheck、lint、测试、正式构建、directory package 和 NSIS 打包。
- 按修复点补相邻 Vitest 回归。
- 760×520 与 500×700 实际 renderer 浏览器检查：首页、设置、响应式布局、横向溢出和
  控制台。
- 程序化点击非选中项，验证不会执行旧选中命令。
- 浏览器持续运行检查，确认不再产生 React maximum update depth 错误。

最终结果：

- `corepack pnpm test`：102 个测试文件、854 项测试全部通过。
- `corepack pnpm typecheck`：通过。
- `corepack pnpm lint`：通过。
- `corepack pnpm format`：全仓通过。
- `corepack pnpm build`：7 个可构建 workspace 全部通过，包含 Electron main、preload 和
  renderer production bundle。
- `corepack pnpm --filter @command-cabin/desktop package:dir`：通过；packaging smoke test
  验证 0.9.0 元数据、main/preload/renderer、`node:sqlite` 打包策略和安装器安全配置。
- `corepack pnpm --filter @command-cabin/desktop dist:win`：通过；生成 0.9.0 x64 NSIS
  installer、blockmap 与 `latest.yml`，安装包 SHA-256 为
  `3C12990B47D20E2CB0013B6DD9A2A50820C820CB25F5C6F98B30C0707DC96B61`。
- 760×520 与 500×700 UI 无横向溢出，窄窗口设置页正确折叠为单列，控制台无 error/warning。
- `git diff --check`：通过。

已知环境限制：

- 本地与自动发布生成的 Windows 安装包未做代码签名，`asar` 和 Windows executable
  resource editing 仍按现有 beta 打包策略关闭。
- 完整安装/升级/卸载仍应在干净 Windows 用户或 VM 中做独立人工验收；自动化测试已防止
  重新引入无所有权验证的递归目录删除。
