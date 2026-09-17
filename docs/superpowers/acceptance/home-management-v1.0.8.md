# v1.0.8 首页固定项管理

## 行为与实现

原生首页此前复用 `FavoritesRepository::list()` 的 `title COLLATE NOCASE, id`
顺序。保留这一默认顺序及设置页收藏列表的排序；用户拖动后，首页单独按收藏元数据
`launcherPinnedAppOrder` 排列。使用现有 metadata JSON，无数据库结构迁移。

拖动通过稳定的命令 ID 定位收藏，跨行移动会顺移中间项目。所有固定项（含十个可见
位置以外的项目）的顺序在同一个事务内保存，保留其他元数据。自定义排序后的新增项
追加到末尾。过期 ID、非固定应用、原位拖动不写数据。

右键菜单使用 Slint `ContextMenuArea`，提供“取消固定”。复用收藏删除和两窗口刷新
路径；不触碰应用文件或安装信息。TS 参考行为：
`apps/desktop/src/renderer/src/launcher/ResultList.tsx` 的 `onRemovePinnedApp`。
排序属于本次新增行为。

设置页返回按钮继续使用共享 `CabinButton`，仅开启 `quiet` 和 `centered` 属性，
保留焦点边框、悬停反馈、无障碍按钮角色与键盘激活。

## 验证范围

- SQLite：旧顺序兼容、跨行前移/后移、数据库关闭重开、连续新增固定项追加、
  元数据保留、隐藏项保留、取消固定、非应用收藏保护、无效 ID 及事务失败回滚。
- 真实 Slint 组件事件测试：鼠标点击、轻微抖动、跨行拖动、拖动不启动应用、
  原位置/空白/越界落点、Esc 取消、右键菜单关闭及取消固定。
- 在 100%、150%、200% 缩放下渲染和执行拖动；设置返回按钮在简中、繁中、英文和
  浅色/深色主题下检查文字像素边界的中心，并验证点击和 Enter 激活。
- 自动化测试使用软件窗口适配器，不改写用户数据库，不启动用户应用。
  上述覆盖不等同于真实桌面上的人工键鼠验收。

## 自动化结果

- `cargo test --workspace --quiet`：677 通过，4 个外网/本机探针默认忽略。
- `cargo clippy --workspace -- -D warnings` 和 `cargo fmt --all -- --check` 通过。
- 四项 Slint 界面测试通过；补充的纯鼠标右键移除第二行最后一个图标用例也通过，
  删除后网格收回一行。
- 已检查渲染图：右键菜单、拖动预览和设置返回按钮与预期一致。
  截图及构建日志保存在本机 `native/artifacts/home-management/`。
- 显式执行本机已安装应用检索探针通过，前一版本修复的目标应用仍能精确检索，
  解析到存在的可执行文件。

## 本地试用

用户已试用本地 EXE，反馈“没问题”，并确认发布 Release。安装包使用同一份已验证的
Release EXE，不重新构建或改动程序。

- Release 构建成功，耗时 5 分 42 秒；`native/target` 已由构建脚本清理。
- 本地测试文件：`native/artifacts/home-management/CommandCabin-Test-1.0.8.exe`。
- 内嵌版本 1.0.8，17,265,152 字节；与 Release 构建产物 SHA256 相同：
  `233f02f6764fe6ef8dcf73263513ae7350883f78ebe8b93272f73154e0707e7f`。
- 运行前从托盘退出已安装版本；测试 EXE 沿用现有设置及收藏，不需要安装。

## 发布包验证

- `native/scripts/build-installer.ps1 -SkipBuild` 成功，直接打包用户已试用通过的 EXE。
- 安装包 `CommandCabin-Setup-1.0.8.exe`：6,473,928 字节，内嵌版本 1.0.8.0。
- 7-Zip 完整性测试通过；从安装包解出的 EXE 与本地测试版 SHA256 完全一致。
- 同名 `.sha512` 文件：159 字节，无 BOM，摘要及资产名匹配安装包：
  `fbc910c8427dfc1049c3713233cb50d97d532e94d51ab90f2c98342fb4963470b92da1e55561030e8deb8a14f6964aad4f620e6ad4cf1a8bf70325b742ef779a`。
