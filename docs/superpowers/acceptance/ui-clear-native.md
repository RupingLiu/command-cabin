# A 方案：清晰原生

适用范围：当前 Rust + Slint 启动器与设置窗口。Electron 界面不在本次范围内。

## 界面约定

- 白灰底色、青绿色强调色 `#0D736C`，共享 `native/ui/design.slint` 色板。
- 保留系统标题栏、实际应用图标及五列、最多两行的固定应用网格。
- 首页磁贴高 85 逻辑像素；搜索行高 56 逻辑像素，滚动计算共用这一行高。
- 截图、文字识别分别调用现有 Capture / OCR 流程。
- 设置分为通用、快捷键、收藏、数据、关于，单层内容滚动。
- 收藏名称与路径分行；路径省略，移除按钮固定宽度。
- 设置输入仍在回车或失焦时提交，开关和选择即时提交；错误通过现有 Rust 流程回滚。
- 切换分类、收起高级设置和关闭窗口前先提交未完成编辑，防止条件组件销毁造成输入丢失。
- 更新横幅的“查看设置”直接进入关于页。
- 跟随系统、浅色、深色及简体中文、繁体中文、英文继续可用。
- 继续保留 Slint 署名与许可信息。

## 原生渲染与交互检查

`ui_smoke_tests::native_ui_navigation_and_dpi_smoke` 直接加载生产 Slint 组件，使用
软件渲染器和示例数据，不访问用户数据库、不注册热键、不执行应用或截图。
示例磁贴统一使用仓库图标；生产环境仍显示系统提取的应用图标。

可选设置 `CABIN_UI_SNAPSHOT_DIR` 导出检查用 PNG：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\msys64\ucrt64\bin;$env:PATH"
$env:CABIN_UI_SNAPSHOT_DIR = "$PWD\native\artifacts\ui-a"
cargo test --manifest-path native/Cargo.toml -p cabin-app native_ui_navigation_and_dpi_smoke
```

检查覆盖：首页方向键导航、末尾搜索结果滚入视口、切页前提交且保留错误、五个设置分区、长路径、英文、
浅深色及 100% / 150% / 200% 缩放。安装后仍应按正常发布清单复核 Windows 的
全局热键、截图选区、OCR 与系统主题切换。

## 本次验证（2026-09-16）

- `cargo test --workspace --quiet`：660 项通过，2 项真实联网探针按原配置忽略。
- `cargo clippy --workspace -- -D warnings`：通过。
- 修改的 Rust 文件 `rustfmt --check` 与 `git diff --check`：通过。
- 已检查软件渲染截图的浅色、深色、长名称、长路径及三档 DPI。
- Windows 壳层图标提取测试首次收到 `E_PENDING`；单独复测和最终完整测试均通过。
- Release 构建通过，运行文件为 `native/artifacts/cabin-app-release.exe`（17,079,296 字节）。
- 自动审批阻止递归删除构建缓存，`native/target` 保留；交付文件不受影响。
