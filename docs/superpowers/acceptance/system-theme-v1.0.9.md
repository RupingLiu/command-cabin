# v1.0.9 跟随系统主题同步

## 问题与修复

用户报告 Windows 已使用浅色主题，但启动器仍显示深色，设置窗口却显示浅色。
本机只读核验时 `AppsUseLightTheme` 与 `SystemUsesLightTheme` 均为 1。
原实现将 System 交给每个 Slint 窗口的后端主题缓存；窗口在隐藏期间错过通知时，
仅重新设置相同的 `theme-mode=0` 无法保证读取当前 Windows 应用主题。

新增平台接口 `SystemThemeProvider`，由 Windows 实现只读查询
`HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme`。
应用层一次解析后同步推送到启动器和设置窗口，并同步原生标题栏。呼出前刷新，
有窗口显示时每秒检查一次；两个窗口隐藏时不读取注册表。显式浅色/深色不查询系统。
读取失败时保留原后端兜底路径，保存的 System 偏好和设置页选项不变。

主题以 Windows 应用模式为准，不按时钟或任务栏颜色推断。TS 参考：
`apps/desktop/src/renderer/src/settings/ThemeSettings.tsx` 的
`return prefersLight() ? 'light' : 'dark';` 和显式模式的 `return theme;`。

## 验证

- 新增真实 Slint 组件的软件渲染回归测试，覆盖夜间隐藏、白天重新呼出、可见期间
  双向切换系统主题、显式浅色/深色优先级、单次读取供两个窗口使用、读取失败兜底。
- 同时检查启动器和设置页的背景像素，已查看浅色渲染截图。
- `cargo test --workspace --locked --quiet`：678 通过，4 项默认忽略。
  首轮有一项既有 `explorer.exe` 图标提取测试返回临时的 `0x8000000A`，
  单独重跑及随后整套重跑均通过。
- `cargo clippy --workspace --locked -- -D warnings` 通过。
- `cargo fmt --all --check` 和 `git diff --check` 通过。
- 测试未修改本机系统主题或用户数据库；软件窗口测试不等同于真实桌面人工验收。
  本次用户授权在测试通过后发布 Release。

## 安装包验证

- 正式 Release 构建成功；EXE 内嵌版本 1.0.9，17,268,736 字节。
  SHA256：`901a44e5a53e2972531eba474fdf79b8b7d4e4535ec3e6045d45e61368cc5bdc`。
- 使用现有 `native/scripts/installer.nsi` 与 NSIS 3.11 打包，安装逻辑未变。
- `CommandCabin-Setup-1.0.9.exe` 为 6,475,236 字节，内嵌版本 1.0.9.0。
- 7-Zip 完整性检查通过；从安装包解出的 `CommandCabin.exe` 与 Release EXE
  的 SHA256 完全一致。
- 同名 `.sha512` 文件为 159 字节、无 BOM、LF 结尾；摘要和资产名均与安装包匹配。
