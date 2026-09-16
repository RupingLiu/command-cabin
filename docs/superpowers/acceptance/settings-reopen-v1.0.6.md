# v1.0.6 设置窗口重开绘制回归

## 问题与修复

用户反馈：v1.0.5 从首页打开设置后，侧栏、页标题及页脚左侧留白，只剩部分关于页内容。

锁定版本 Slint 1.17.1 的 winit 软件渲染后端按 softbuffer 的 buffer age 选择局部重绘。
其 `renderer/sw.rs::occluded` 已注明 Windows 隐藏窗口可能清空缓冲区而 buffer age 不变；但 `winitwindowadapter.rs::set_visibility` 的 hide/show 路径没有直接清空该缓存。
应用原先只调用 `request_redraw`，这仅调度一帧，不保证静态区域被重新绘制。

统一的 `show_settings_surface` 在 show 之后通过公开 `take_snapshot` API 做一次完整离屏绘制，丢弃临时位图，再请求显示帧。
该 Slint 版本在 snapshot 的 NewBuffer/原 buffer mode 切换时清除局部重绘缓存；不引入私有 Slint API 或渲染器依赖。
此处理仅发生在打开设置时，后台更新状态和普通设置输入不触发额外完整绘制。

## 回归测试

`settings_reopen_repaints_sidebar_after_windows_surface_loss` 使用真实 Slint 设置组件和 ReusedBuffer 软件渲染。

1. 按用户截图的 150% DPI、680×500 逻辑窗口绘制基准帧。
2. 隐藏窗口并清空显示像素，但保留局部渲染缓存，模拟 Windows buffer age 仍为 1 的情形。
3. 更新关于页状态，触发首页设置回调，重新显示并绘制。
4. 与基准帧逐像素比较静态侧栏、页标题及页脚；重复三次。
5. 实际发送指针点击，确认侧栏能够切换至常规页。

修复前测试失败：侧栏像素 (0,0) 为白色 (255,255,255)，应为面板色 (246,248,249)。
修复后通过；生成的重开窗口截图也已人工目视检查。
本测试模拟 Windows 缓冲区丢失，不声称已经完成用户机器上原生窗口的人工操作验收。

## 发布验证

- `cargo test --workspace --quiet`：667 通过，3 个外网探针默认忽略。
- `cargo clippy --workspace -- -D warnings`：通过，零警告。
- 改动的 Rust 文件格式检查、`git diff --check`：通过。
- Release 构建通过，耗时 2 分 53 秒；EXE 版本 1.0.6，17,088,000 字节。
- 安装包 6,464,014 字节，安装器内嵌版本 1.0.6.0，SHA512 文件 159 字节。
- 7-Zip 安装包完整性测试通过；解出的 EXE 与构建产物 SHA256 一致。
- SHA512 文件与安装包一致：`fcda2685725097c3c3d9e22652f4052110bdf983fde2783eeee13c66dbb407a657475df8f2f4ca896669d1fe16fe709ccc2f257b9b534e96e551603e34a493b8`。
- 发布后运行真实更新下载探针，模拟 1.0.5 客户端并要求 latest=1.0.6，验证公开安装包与安装提示。
