# v1.0.10 恢复独立单位换算页面

## 问题与修复

用户指出原生版缺少旧版的独立单位换算页面，并要求恢复；该修复纳入本次
v1.0.10 Release，与首页三行图标布局一起发布。

旧版页面仍保留在 `apps/desktop/src/renderer/src/converter/UnitConverterPage.tsx`。
原生版此前仅移植了搜索框的快速换算命令，没有迁移页面与首页入口。

首页底部恢复“单位换算”按钮，在同一个启动器窗口内显示独立页面，支持重量、
长度、两侧数值编辑、单位选择、交换单位、返回按钮及 Esc 返回。
使用现有主题和语言机制，不额外创建常驻原生窗口。

重量单位顺序为 kg / g / mg / lb / oz，默认 kg → lb；长度单位顺序为
cm / mm / m / in / ft，默认 cm → in。简体中文、繁体中文、英文文案逐字
复用旧版 `i18n.ts` 的 `unitConverter` 与 `launcher.homeActions.unitConverter`。

## TS 行为依据

- `packages/core/src/unitConversion.ts`：
  `(input.value * fromUnit.toBaseFactor) / toUnit.toBaseFactor`，精确基础系数
  `lb = 0.45359237`、`oz = 0.028349523125`、`in = 0.0254`、`ft = 0.3048`。
- 数值格式：`Number(normalizedValue.toPrecision(6)).toString()`，负零归一为零。
- `UnitConverterPage.tsx` 的 `recalculateState` 从最近编辑的一侧重新计算；
  `units-swapped` 同时交换两侧单位、数值和 `lastEditedSide`。
- 类别切换清空两侧输入并恢复默认单位；非法或不完整的数字输入保留用户文本，
  对侧结果清空；每次打开页面重新创建初始重量状态。

换算数学位于纯 Rust `cabin-core/src/unit_conversion.rs`，页面状态转换位于
`cabin-app/src/unit_converter.rs`，Slint 页面在 `native/ui/unit-converter.slint`。
快速换算搜索命令继续遵循自己的 TS 基准，不借用其近似换算常量代替页面系数。

## 验证范围

- 旧版回归例：1 kg → 2.20462 lb；交换后选择 oz 得到 35.274 oz，同时保留 1 kg；
  长度默认 cm → in，1 in → 2.54 cm；编辑任一侧或改变单位保持编辑基准。
- 真实 Slint 页面使用生产回调接线，验证首页入口、键盘输入、下拉单位选择、
  交换按钮、双向换算、类别切换、返回按钮、Esc 返回和重新打开时的状态复位。
- 三种语言、浅深色与 100% / 150% / 200% 缩放渲染；使用最小 560×520 窗口，
  不额外创建窗口，不访问用户数据库或剪贴板。

本机渲染截图与测试日志位于 `native/artifacts/home-grid/`。

- `cargo test --workspace --locked --quiet`：684 通过，4 项默认忽略。
- `cargo clippy --workspace --locked -- -D warnings`、`cargo fmt --all -- --check`
  和 `git diff --check` 通过。
- 已查看简体中文浅色及英文深色的实际软件渲染截图；交换按钮使用 SVG 图标，
  避免系统字体缺少箭头字形时显示为空。
