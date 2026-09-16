# v1.0.5 自动更新验证记录

日期：2026-09-16。目标：自动发现更新 → 自动下载 → 大小与 SHA512 校验 → 显示安装入口。

## 发现与修复

1. 原客户端通过 CreateProcess 启动要求管理员权限的 NSIS 安装器。在当前普通权限进程中，以 CREATE_SUSPENDED 探测旧安装器，复现 Windows 错误 740；探测不会执行安装器指令。改用 ShellExecuteExW 的 runas 动词与固定 /S 参数。成功后才退出，取消 UAC 保留已下载状态。
2. 下载失败后 canCheck 已恢复，但十分钟冷却仍拦截重试；失败时清除冷却时间戳。
3. 更新横幅原来仅首页可见；现在置于首页和搜索结果共用的底部区域。
4. 原 HTTP 客户端不读取代理，真实探针出现校验文件下载超时。现在支持 HTTPS_PROXY / ALL_PROXY / HTTP_PROXY、NO_PROXY 以及 Windows 当前用户的手动代理与绕过列表；未增加 PAC 脚本执行能力。
5. 安装器 CloseRunningApp 宏的 Return 跳过了 .onInit 后面的安装目录恢复；改为只跳出宏。等待超时及 EXE 替换失败时停止安装。
6. 打包脚本拒绝 EXE 内嵌版本与安装包版本不一致，避免 SkipBuild 误打旧二进制。

Windows 提权行为依据：[Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/secbp/running-with-administrator-privileges)。

## 真实下载探针

`ui_smoke_tests::live_update_download_and_install_prompt` 是显式运行的 ignored 测试。
它调用生产 GitHubUpdateService、SHA512 校验、UpdateOrchestration 和 apply_update_views，并渲染真实 Slint 控件。
测试不连接用户数据库、不执行安装器、不修改当前安装。

- 发布前模拟当前版本 1.0.3，发现公开 v1.0.4。
- 使用 Windows 系统代理，仅在测试子进程清除代理环境变量，模拟从资源管理器启动。
- 下载 6,426,950 字节，SHA512 校验通过，进度和最终文件大小一致。
- 下载进度 100% 时仍不可安装；校验成功并完成状态转移后才可安装。
- 首页、非空查询搜索页、关于页：实际指针点击安装按钮均进入回调。
- 安装命令只能在 Downloaded 且版本一致时生成。
- 最初直连探针超时；加入代理支持后，环境代理曾返回 GitHub 公共 API 限流 403；系统代理探针完整通过。TLS 和 SHA512 校验始终启用。

## 回归范围与实测边界

- 下载客户端已有本地 HTTP 服务测试：校验文件缺失或无效、SHA512 不符、长度不符、断流和超时、HTTP 错误、临时文件清理、已有目标的原子替换。
- 新增 Windows 提权 API 注入测试：Unicode 和空格路径、runas + /S、等待启动确认、取消 UAC、启动失败及文件丢失。
- UI 实测使用软件渲染后端与真实组件。UAC 安全桌面的人为确认、覆盖当前安装的动作未执行。
- A 方案布局、语言、DPI、设置提交回归见 [UI 验收](./ui-clear-native.md)。
- 旧客户端的安装权限缺陷无法由新安装包修复；发布说明提供手动完成一次升级的方法。

## 最终构建与发布

- `cargo test --workspace --quiet`：666 通过，3 个外网测试默认忽略；更新下载探针另行显式执行通过。
- `cargo clippy --workspace -- -D warnings`：通过，零警告。
- Release 构建通过，耗时 4 分 41 秒；EXE 内嵌版本 1.0.5，17,087,488 字节。
- NSIS 3.11 打包成功，安装包 6,462,656 字节，内嵌版本 1.0.5.0，SHA512 文件 159 字节。
- 7-Zip 完整性测试通过；解出的 CommandCabin.exe 与本次 Release EXE 的 SHA256 完全一致。
- 安装包 SHA512 与同名校验文件一致：`a16041816bfa6eb8c0c2789918a404cd4043f73fbf5522fce7fa873059e44a7c9baa9088cecc35ae83c2c09112ef6d33d3d702b2f4c368fadcf3dd4268f7b8e6`。
- 发布后使用同一外网探针，模拟当前版本 1.0.4，要求 latest 为 1.0.5，重新下载并验证公开资产及安装提示。
  构建缓存清理受自动审批策略限制，沿用上一轮的保留状态。
