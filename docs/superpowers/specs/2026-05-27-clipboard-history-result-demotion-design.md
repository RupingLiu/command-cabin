# Clipboard History 搜索结果降噪设计

## 背景

CommandCabin 当前会把 Clipboard History 注册为普通插件命令，并把剪贴板文本放进
`subtitle` 和 `keywords`。当用户输入的内容刚好匹配剪贴板历史时，搜索引擎会把历史项
当作强相关结果排到前面。

这会造成两个问题：

- 输入 `43cm` 这类单位换算查询时，Clipboard History 会顶在换算结果上方。
- 输入应用、收藏、系统命令等普通搜索内容时，只要剪贴板历史里有相似文本，也可能挤占
  更符合用户主动意图的结果位置。

## 目标

- 普通搜索中，单位换算、计算器、应用、系统命令、收藏、文件和 URL 等主动意图结果优先。
- Clipboard History 仍然可被搜索到，但默认降噪，不抢占主要结果。
- 当用户明确搜索剪贴板历史时，Clipboard History 可以正常展示多条结果。
- 改动集中在搜索结果编排层，不改变剪贴板存储、监听和命令执行语义。

## 非目标

- 不移除 Clipboard History 搜索能力。
- 不改变 Clipboard History 的保存上限、预览截断规则或复制执行逻辑。
- 不重写核心 Fuse 搜索引擎或全局 ranking 算法。
- 不新增独立剪贴板历史页面。

## 用户体验规则

普通搜索默认采用降噪模式：

1. 主动意图结果排在 Clipboard History 前面。
2. Clipboard History 最多露出 2 条。
3. 如果没有主动意图结果，Clipboard History 仍可显示，最多 2 条。
4. 如果用户明确输入剪贴板意图关键词，则不限制 Clipboard History 数量。

明确剪贴板意图关键词包括：

- `clip`
- `clipboard`
- `history`
- `剪贴板`
- `粘贴板`
- `剪切板`

示例：

```text
查询：43cm
1. 43 厘米 = 430 毫米 = 0.43 米 = 16.9291 英寸
2. Clipboard History / 43cm
```

```text
查询：wps
1. WPS Office
2. 其他应用、收藏或系统结果
3. Clipboard History / wps...
```

```text
查询：clip 43
1. Clipboard History / 43cm
2. Clipboard History / 43cm*13cm*7cm
3. Clipboard History / ...
```

## 技术设计

在 `apps/desktop/src/main/launcher/launcherCommandService.ts` 中增加搜索结果后处理，而不是
修改 core 搜索引擎：

1. 保持现有流程生成 calculator、quick converter 和 Clipboard History 动态命令。
2. 调用 `searchEngine.search(query, searchOptions)` 得到原始结果。
3. 识别 Clipboard History 结果：
   - 使用 `isClipboardHistoryCommandId(result.id)`。
4. 识别显式剪贴板查询：
   - 对 query 做大小写规整和 trim。
   - 匹配上面的剪贴板意图关键词。
5. 普通查询时执行后处理：
   - 主动意图结果保持原有相对顺序。
   - Clipboard History 结果保持原有相对顺序，但最多保留 2 条。
   - 最终列表仍限制为原有搜索 limit。
6. 显式剪贴板查询时跳过降噪处理，保留搜索引擎原始排序。

这种方式把“Clipboard History 是辅助结果”这个产品规则留在桌面启动器服务层，不污染
通用搜索引擎，也不影响其他插件未来使用同一套 ranking。

## 边界情况

- 如果结果全是 Clipboard History，普通搜索仍显示最多 2 条，不显示空结果。
- 如果主动意图结果超过 limit，Clipboard History 可能完全不露出，这是符合降噪目标的。
- 如果 query 是 `clipboard 43cm`，视为明确搜索剪贴板历史，不做数量限制。
- Clipboard History 的执行结果仍然是复制历史文本到剪贴板，不改变。

## 测试计划

补充 `launcherCommandService` 单元测试：

- `43cm` 同时命中 Clipboard History 和 quick converter 时，quick converter 排第一。
- 普通应用搜索同时命中 Clipboard History 时，应用结果排在 Clipboard History 前面。
- 普通搜索中 Clipboard History 最多显示 2 条。
- 显式剪贴板查询中 Clipboard History 可以显示多条。
- 没有主动意图结果时，普通搜索仍能显示少量 Clipboard History。

## 验证

实现后运行：

```powershell
corepack pnpm test apps/desktop/src/main/launcher/launcherCommandService.test.ts
corepack pnpm typecheck
corepack pnpm lint
```

如果触及格式化文件，额外对改动文件运行 Prettier 检查。
