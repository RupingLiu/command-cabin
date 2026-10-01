# v1.0.11 空首页唤起绘制回归

## 问题与修复

用户反馈：另一台电脑上，首页没有固定软件图标时，快捷键唤起后顶部设置入口、
底部工具按钮和页脚消失，只剩搜索框和空首页提示。

锁定版本 Slint 1.17.1 的 Windows 软件渲染后端按 softbuffer 的 buffer age 选择
局部重绘。隐藏窗口可能清空显示像素，但 buffer age 仍为 1，渲染器因此跳过
未变化的静态区域。空首页没有应用图标刷新，更容易暴露此问题。
这是 v1.0.6 设置页重开绘制问题的同一机制，原生主页的显示路径漏用了该处理。

`AppContext::show_launcher_window` 的窗口显示、主题、居中和聚焦操作提取为
`show_launcher_surface`。主页与设置页共用 `repaint_window_surface`，在显示后
通过公开 `take_snapshot` 做完整离屏绘制并丢弃临时位图，再请求显示帧。
该版本的 snapshot 在 NewBuffer/原 buffer mode 切换时清除局部重绘缓存。
完整绘制仅在打开窗口时发生，普通输入、图标刷新和后台状态更新继续使用局部重绘。

TS 参照 `apps/desktop/src/renderer/src/launcher/LauncherPage.tsx`：
顶部设置按钮为 `onClick={onOpenSettings}`，首页工具区仅检查
`state.query.trim().length === 0`，不依赖固定应用数量。
本次修复恢复既有界面的绘制，不改变首页命令或收藏规则。

## 回归测试

`empty_home_reopen_repaints_chrome_after_windows_surface_loss` 使用真实 Slint
主页组件、空固定应用模型及 ReusedBuffer 软件渲染：

1. 绘制基准帧，隐藏窗口并清空显示像素，保留局部渲染缓存。
2. 模拟默认唤起路径，清空查询、刷新空模型，调用生产的窗口显示函数。
3. 逐像素比较顶部、空首页、底部工具按钮和页脚，排除搜索框闪烁光标。
4. 浅色/深色 × 100%/150%/200% 缩放，每组连续隐藏/唤起三次。
5. 使用真实指针和按键事件，检查设置、截图、OCR、单位换算入口、搜索聚焦和 Esc。

修复前测试失败：首次重开时顶部图标 (27,18) 变成背景色，静态界面没有恢复。
该测试模拟 Windows 缓冲区丢失，不等同于用户电脑上的原生窗口人工验收。

发布前包含测试目标的 Clippy 检查发现 Rust 1.98 新增的固定分块建议和重复的
Read/Write 导入警告。测试辅助函数改用 `as_chunks`/`as_chunks_mut`，删除重复
导入，并重新运行相关测试及全工作区检查。

## 自动化验证

- `cargo test --workspace --locked --offline --quiet`：685 通过，4 项外网探针默认忽略。
- `cargo clippy --workspace --all-targets --locked --offline -- -D warnings`：通过，零警告。
- `cargo fmt --all -- --check`、`git diff --check`：通过。
- 修复后的重开截图已经目视检查，顶部设置入口、空首页提示、底部工具按钮和页脚完整。
- 测试截图和日志保存在本机 `native/artifacts/ui-hotkey-reopen/`。

版本单一来源为 `native/Cargo.toml` 的 1.0.11，五个原生 crate 和锁文件同步更新。

## 安装包验证

- 正式 Release 构建成功，耗时 6 分 55 秒；EXE 版本 1.0.11，17,566,208 字节。
  SHA256：`85d92218f54bb98ef9a7f670ed1f2703e199482ea4720961d80bb99c84e6c94e`。
- `CommandCabin-Setup-1.0.11.exe` 为 6,525,138 字节，内嵌版本 1.0.11.0。
  SHA256：`36ca819f4f947516bb1766f4dd2b03922b27ee159e3552f20d14e11b7d718a4a`。
- 7-Zip 完整性检查通过，解包后的 `CommandCabin.exe` 与正式构建的 SHA256 一致。
- `.sha512` 文件为 160 字节、无 BOM、LF 结尾，摘要和资产名与安装包匹配。
  SHA512：`4d599f2c8f4fefc7a670a197d5fb81a80b2338b7592795a38760740321cb0adb85057e6a90f744049722cbea49710f980ad62e9325580373cc5ecdbcca442710`。
- 构建脚本已清除 `native/target`；本机产物校验记录保存为
  `native/artifacts/ui-hotkey-reopen/artifact-verification.json`。
