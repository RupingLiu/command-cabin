# v1.0.13 更新检查 403 修复验证记录

日期：2026-10-23。目标：定位并修复 v1.0.12 实机反馈的
`update check failed: HTTP 403`（设置 › 关于 页）。

## 现象与根因

设置页「关于」显示 `update check failed: HTTP 403`，手动点击与自动检查均失败。

**根因不是客户端代码缺陷，而是共享出口 IP 的未认证 API 配额耗尽**：

- 系统代理开启（`HKCU\...\Internet Settings`：`ProxyEnable=1`，
  `ProxyServer=127.0.0.1:7897`，`ProxyOverride` 不含 `github.com`），
  `update_proxy::for_url` 因此对 `api.github.com` 选中该代理；
- 经代理请求 `releases/latest` → `403`，响应头
  `X-RateLimit-Limit: 60` / `X-RateLimit-Remaining: 0` / `X-RateLimit-Used: 60`，
  响应体 `API rate limit exceeded for 112.120.114.54`（代理出口 IP）；
- 直连同一端点 → `200`，`X-RateLimit-Remaining: 57`；
- 排除 UA：两种请求都带 `User-Agent: CommandCabin-Updater`，直连正常；
- 排除仓库/发布：经同一代理 `github.com/.../releases/latest` → `302` 到
  `releases/tag/v1.0.12`，Web 侧可达。

诊断日志（`%APPDATA%\CommandCabin\logs\command-cabin.log`）显示这是**长期
复用**的失败面，而非今日偶发：1325 次检查中 423 次 `HTTP 403`，首次
2026-09-16，此后几乎每日出现；另有 11 次 `10061`（代理未起）、11 次
`unexpected end of file`、7 次 `10054`、1 次超时。

## 修复（四项）

1. **零配额主通道**：检查改用 `GET https://github.com/{owner}/{repo}/releases.atom`
   ——普通网页流量，不消耗 `api.github.com` 的 60 次/小时未认证配额。新增
   `cabin-core::updater::atom`（`roxmltree`）解析首条 entry 的 tag/发布说明，
   资产改由发布约定拼装（`releases/download/{tag}/CommandCabin-Setup-{version}.exe`
   + `.sha512`）。API 通道保留为兜底（Atom 解析失败或标签非稳定版本时回退）。
2. **403 可读化**：`HttpFailure::Status` 携带 `X-RateLimit-Reset` /
   `Retry-After`，错误消息从裸 `HTTP 403` 变为
   `HTTP 403: GitHub API rate limit reached for this network's IP address
   (unauthenticated limit is 60 requests/hour); retry in about 15 min`。
3. **失败不再清冷却**（回归修复）：`finish_check_failed` 原先置
   `last_manual_check_at_ms = None`，使 10 分钟冷却对"失败后重试"失效。日志实证
   2026-10-23T05:41 约 10 秒内 10 次手动检查全 403——每次重试继续消耗配额。
   TS 参考实现 `updateController.ts` 的 catch 分支从不重置该时间戳，属移植偏移。
4. **自动检查退避**：`FailureBackoff` 在失败后按服务端建议（无建议则 5 分钟，
   上限 1 小时）屏蔽自动检查，仅约束自动通道；手动检查仍只受 10 分钟冷却约束。

## 验证

- `cargo test --workspace`：702 通过，4 个外网探针默认忽略。
- `cargo clippy --workspace --all-targets -- -D warnings`：零警告。
- `cargo fmt --all -- --check`：通过。
- 真实端到端（`--ignored atom_download_probe`）：Atom 检查取到 v1.0.12 →
  按约定构造下载直链 → 取 `.sha512` 边车 → 流式下载 6,525,530 字节 →
  sha512/尺寸双重校验通过，4.3 秒。全程零 API 配额。
- 本地独立复核：构造直链下载物的 sha512 与边车逐字一致
  （`501e1827…74a2ef`）。
- `real_endpoint_probe`：Atom 582ms 命中 v1.0.12（含发布说明），API 424ms
  命中同版本 2 个资产——两通道同时可用。
- 单元覆盖：Atom 解析（真实 feed 形状、无 content、id/title 标签回退、
  prerelease 拒绝、畸形 feed）、通道优先级与兜底、限流文案（reset 未过期/
  已过期/`Retry-After`/非限流码不误报）、零尺寸下载、退避窗口与冷却语义。

## 回归边界

- 发布资产命名约定未变（`CommandCabin-Setup-{version}.exe` + `.sha512`），
  既有安装包与校验边车无需重发。
- 下载安全红线不变：边车先行、缺失/非法即拒绝、尺寸与 sha512 双校验、
  校验先于 rename。
- Atom 通道 `ReleaseAsset.size` 为 0（feed 不含资产大小），下载时以
  `Content-Length` 为准；尺寸字段校验自动跳过（`expected_size > 0` 判断）。
- 未修改 Clash/系统代理配置（用户明确要求）。修复不依赖代理出口 IP 的
  可用配额。
