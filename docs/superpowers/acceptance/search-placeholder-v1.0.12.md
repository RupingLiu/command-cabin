# v1.0.12 搜索提示词重叠修复

## 原因与修复

首页搜索框使用单独的 Text 显示提示词，原条件为 `root.home`。
中文输入法组合输入期间，TextInput 的 `preedit-text` 已经显示拼音，但尚未
提交到 `current-query`，首页状态仍为 true，因此提示词与拼音重叠。

显示条件改为 `query-input.text == "" && query-input.preedit-text == ""`，
与当前锁定的 Slint 1.17.1 `widgets/common/lineedit-base.slint` 一致。
该条件也避免只输入空白字符时因首页状态未改变而继续显示提示词。
输入内容和组合文字全部清空后，提示词自动恢复。

## 验证

- `cargo fmt --all -- --check` 和 `git diff --check` 通过。
- `cargo clippy --workspace --locked --offline -- -D warnings` 通过。
- 应用 161、核心 334、平台抽象 36、存储 72 项测试通过；应用另有 1 项联网测试忽略。
- 全量测试未全部通过：Windows 平台测试首次运行 75 通过、7 失败、3 忽略。
  失败发生在本地 HTTP 模拟服务，报 Windows 10054（连接重置）；涉及汇率及更新器。
  串行重跑仍在不同 HTTP 用例出现同类错误，并留下等待后续连接的测试进程，已终止。
  本次未修改这些模块，未将失败隐藏为全量通过。
- Slint 输入框修复通过实际编译；本轮未执行真实中文输入法的交互式回归。

版本单一来源更新为 `native/Cargo.toml` 中的 1.0.12，锁文件的五个工作区包同步更新。
