//! GitHub Releases 自更新客户端（平台 IO 层）。
//!
//! **分界约定（与 exchange_rate.rs / translate.rs 同构）**：端点常量、发布
//! 资产命名、响应严格解析、sha512 边车格式解析与版本决策归
//! `cabin_core::updater`；本模块只做 IO 与错误映射——
//! - `ureq`（rustls，同步、无 tokio）GET，所有请求携带
//!   `User-Agent: CommandCabin-Updater`（GitHub API 缺省 403 的硬性要求）
//!   与 `Accept: application/vnd.github+json`；
//! - 检查：整体超时
//!   [`cabin_core::updater::DEFAULT_UPDATE_CHECK_TIMEOUT_MS`]（15s，核心层
//!   常量；无 TS 对应值可移植，本计划自定）；非 2xx →
//!   `PlatformError::Update("HTTP {status}")`；超时 → `"request timed
//!   out"`；其余传输失败消息原样透传；响应体交给核心层严格解析，解析失败
//!   消息可读直出；
//! - 下载：`timeout_read`（每读操作 30s 默认）做卡死检测而**不设整体超时**
//!   （安装包数十 MB，整体超时在受限网络下必然误杀）；GitHub
//!   `browser_download_url` 会 302 到 objects.githubusercontent.com，ureq
//!   默认跟随重定向。
//!
//! **下载与校验流程（安全红线）**：
//! 1. 先取 `.sha512` 边车（URL = 资产 URL + `.sha512`；sha512sum 文本格式，
//!    见核心层 `parse_sha512_sidecar`）。**边车缺失（HTTP 404）或格式非法
//!    → 拒绝下载**——宁可拒绝升级，绝不执行未校验的下载物；
//! 2. 资产流式写入临时文件（`<to>.<pid>.<seq>.tmp`，icons/exchange-rate
//!    原子写同款）并同步计算 sha512，逐块回调进度 (已下载, 总字节)；
//! 3. 尺寸对 `ReleaseAsset.size`（API 元数据）、摘要对边车十六进制双重校验
//!    ——任一不符或任何 IO 失败 → 删除临时文件 + `PlatformError::UpdateDownload`；
//! 4. 全部通过后才 rename 成品（校验先于落位，坏文件永不出现在目标路径）。
//!    rename = 原子替换（Windows `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`），
//!    已存在的目标成品被整体换新（exchange-rate/icons 原子写同款语义）。
//!
//! **取消语义**：`download` 在调用线程同步执行（Task 3 负责放入工作线程，
//! 本层不做线程管理）；任何失败路径都会清理临时文件，进程中途退出遗留的
//! `.tmp` 由 Task 3 编排在下次启动时清理。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::Duration;

use cabin_core::updater::{
    is_newer, parse_github_release_response, parse_sha512_sidecar, ReleaseAsset, UpdateInfo,
    DEFAULT_UPDATE_CHECK_TIMEOUT_MS, GITHUB_API_ACCEPT, GITHUB_API_USER_AGENT,
    GITHUB_RELEASES_LATEST_ENDPOINT, SHA512_SIDECAR_SUFFIX,
};
use cabin_platform::{PlatformError, UpdateService};
use sha2::{Digest, Sha512};

/// 下载路径的每读操作超时（卡死检测）。无 TS 对应常量；30s 覆盖受限网络下
/// 的单次慢读，同时保证真·断流能在半分钟内浮出错误。
pub const DEFAULT_DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// 流式复制缓冲区（64 KiB：进度回调粒度与系统调用开销的折中）。
const STREAM_BUFFER_SIZE: usize = 64 * 1024;

/// 平台 HTTP 的三类失败（映射自 ureq；语义与 exchange_rate.rs 一致）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum HttpFailure {
    Timeout,
    Status(u16),
    Network(String),
}

impl HttpFailure {
    /// 可读描述（手动检查 / 下载失败直出）。
    fn describe(&self) -> String {
        match self {
            HttpFailure::Timeout => "request timed out".to_string(),
            HttpFailure::Status(status) => format!("HTTP {status}"),
            HttpFailure::Network(message) => message.clone(),
        }
    }
}

/// ureq 2.x 的超时信号判定（exchange_rate.rs 同款：ErrorKind::Io +
/// 内层 io::ErrorKind::TimedOut）。
fn transport_is_timeout(transport: &ureq::Transport) -> bool {
    use std::error::Error as _;
    transport.kind() == ureq::ErrorKind::Io
        && transport
            .source()
            .and_then(|source| source.downcast_ref::<std::io::Error>())
            .is_some_and(|io_error| io_error.kind() == std::io::ErrorKind::TimedOut)
}

fn http_failure(error: ureq::Error) -> HttpFailure {
    match error {
        ureq::Error::Status(status, _) => HttpFailure::Status(status),
        ureq::Error::Transport(transport) => {
            if transport_is_timeout(&transport) {
                HttpFailure::Timeout
            } else {
                HttpFailure::Network(transport.to_string())
            }
        }
    }
}

/// ureq Agent：GitHub 要求的 UA + Accept 头统一在此注入。
fn github_agent(
    url: &str,
    timeout: Option<Duration>,
    read_timeout: Option<Duration>,
) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new();
    if let Some(proxy) = crate::update_proxy::for_url(url) {
        builder = builder.proxy(proxy);
    }
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    if let Some(read_timeout) = read_timeout {
        builder = builder.timeout_read(read_timeout);
    }
    builder.build()
}

/// GET 并读取 2xx 响应体（字符串）——检查与边车取数共用。
fn http_get_text(url: &str, timeout: Duration) -> Result<String, HttpFailure> {
    match github_agent(url, Some(timeout), None)
        .get(url)
        .set("User-Agent", GITHUB_API_USER_AGENT)
        .set("Accept", GITHUB_API_ACCEPT)
        .call()
    {
        Ok(ok) => ok
            .into_string()
            .map_err(|error| HttpFailure::Network(error.to_string())),
        Err(error) => Err(http_failure(error)),
    }
}

/// GET 并打开 2xx 响应流（下载用）。返回 (Content-Length, reader)。
/// `read_timeout` 为每读操作超时（卡死检测），不设整体超时（见模块注释）。
fn http_open_stream(
    url: &str,
    read_timeout: Duration,
) -> Result<(Option<u64>, impl Read), HttpFailure> {
    match github_agent(url, None, Some(read_timeout))
        .get(url)
        .set("User-Agent", GITHUB_API_USER_AGENT)
        .set("Accept", GITHUB_API_ACCEPT)
        .call()
    {
        Ok(response) => {
            let content_length = response
                .header("Content-Length")
                .and_then(|value| value.parse::<u64>().ok());
            Ok((content_length, response.into_reader()))
        }
        Err(error) => Err(http_failure(error)),
    }
}

/// 更新服务（GitHub Releases 实现）。
#[derive(Debug, Clone)]
pub struct GitHubUpdateService {
    check_timeout: Duration,
    download_read_timeout: Duration,
}

impl Default for GitHubUpdateService {
    fn default() -> Self {
        Self {
            check_timeout: Duration::from_millis(DEFAULT_UPDATE_CHECK_TIMEOUT_MS),
            download_read_timeout: DEFAULT_DOWNLOAD_READ_TIMEOUT,
        }
    }
}

impl GitHubUpdateService {
    pub fn new() -> Self {
        Self::default()
    }

    /// 覆盖默认超时（检查 = 整体超时；下载 = 每读操作超时）。
    pub fn with_timeouts(check_timeout: Duration, download_read_timeout: Duration) -> Self {
        Self {
            check_timeout,
            download_read_timeout,
        }
    }

    /// [`UpdateService::latest`] 的可注入端点版本（测试逃生门；生产入口
    /// 固定 `GITHUB_RELEASES_LATEST_ENDPOINT`）。
    fn latest_from(
        endpoint: &str,
        current_version: &str,
        timeout: Duration,
    ) -> Result<Option<UpdateInfo>, PlatformError> {
        let body = http_get_text(endpoint, timeout)
            .map_err(|failure| PlatformError::Update(failure.describe()))?;
        let info = parse_github_release_response(&body)
            .map_err(|error| PlatformError::Update(error.to_string()))?;
        let has_update = is_newer(&info.version, current_version)
            .map_err(|error| PlatformError::Update(error.to_string()))?;
        Ok(if has_update { Some(info) } else { None })
    }
}

impl UpdateService for GitHubUpdateService {
    fn latest(&self, current_version: &str) -> Result<Option<UpdateInfo>, PlatformError> {
        Self::latest_from(
            GITHUB_RELEASES_LATEST_ENDPOINT,
            current_version,
            self.check_timeout,
        )
    }

    fn download(
        &self,
        asset: &ReleaseAsset,
        to: &Path,
        progress: Option<Box<dyn Fn(u64, u64) + Send>>,
    ) -> Result<(), PlatformError> {
        // v1.0.1 安全校验（下载红线 0）：下载/边车 URL 必须是 https 且主机在
        // GitHub 域内——资产 URL 来自 GitHub API 响应体（browser_download_url），
        // 被篡改的响应不得把下载器指向任意主机。
        validate_download_url(&asset.url)?;
        let sidecar_url = format!("{}{SHA512_SIDECAR_SUFFIX}", asset.url);
        download_asset(
            &sidecar_url,
            &asset.url,
            &asset.name,
            asset.size,
            to,
            progress.as_deref(),
            self.download_read_timeout,
        )
    }
}

/// 下载 URL 安全校验：仅 https；主机限 GitHub 系（github.com / api.github.com /
/// *.githubusercontent.com——资产 302 目标 CDN 家族）。返回 Err 拒绝下载。
/// 解析不用 url crate：https 前缀判定 + authority 提取（到第一个 '/'/'?'/'#'），
/// 主机小写比较（DNS 大小写不敏感）。
fn validate_download_url(url: &str) -> Result<(), PlatformError> {
    let reject = |reason: &str| {
        Err(PlatformError::UpdateDownload(format!(
            "refusing update download: {reason} ({url})"
        )))
    };
    let Some(rest) = url.strip_prefix("https://") else {
        return reject("URL must use https");
    };
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .to_lowercase();
    // authority 可能含 userinfo@ 或 :port——主机取最后一段 '@' 之后、':' 之前。
    let host = authority.rsplit('@').next().unwrap_or_default();
    let host = host.split(':').next().unwrap_or_default();
    let github_host = host == "github.com"
        || host == "api.github.com"
        || host == "www.github.com"
        || host.ends_with(".github.com")
        || host.ends_with(".githubusercontent.com");
    if !github_host {
        return reject("host is not a GitHub domain");
    }
    Ok(())
}

static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// icons/exchange_rate 原子写同款临时文件名：`<to>.<pid>.<seq>.tmp`。
fn temporary_download_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        TEMPORARY_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
    ));
    PathBuf::from(name)
}

/// 下载半步（可注入 URL 的测试入口）：边车先行 → 流式落临时文件 → 双重
/// 校验 → rename 成品。见模块注释的完整流程与红线。
fn download_asset(
    sidecar_url: &str,
    asset_url: &str,
    asset_name: &str,
    expected_size: u64,
    to: &Path,
    progress: Option<&(dyn Fn(u64, u64) + Send)>,
    read_timeout: Duration,
) -> Result<(), PlatformError> {
    let fail = |message: String| PlatformError::UpdateDownload(message);

    // 1. 边车先行：缺失即拒绝（安全红线），不发起资产请求。
    let sidecar = http_get_text(sidecar_url, read_timeout).map_err(|failure| {
        fail(format!(
            "sha512 sidecar fetch failed for {asset_name}: {}",
            failure.describe()
        ))
    })?;
    let expected_digest = parse_sha512_sidecar(&sidecar, asset_name).ok_or_else(|| {
        fail(format!(
            "missing or invalid sha512 sidecar for {asset_name}; refusing unverified download"
        ))
    })?;

    // 2. 资产流式下载到临时文件。
    let (content_length, mut reader) =
        http_open_stream(asset_url, read_timeout).map_err(|failure| {
            fail(format!(
                "asset fetch failed for {asset_name}: {}",
                failure.describe()
            ))
        })?;
    let total = if expected_size > 0 {
        expected_size
    } else {
        content_length.unwrap_or(0)
    };

    let temporary_path = temporary_download_path(to);
    if let Some(parent) = temporary_path.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                return Err(fail(format!(
                    "failed to create download directory {}: {error}",
                    parent.display()
                )));
            }
        }
    }

    let mut hasher = Sha512::new();
    let stream_result = std::fs::File::create(&temporary_path)
        .and_then(|mut file| stream_to_file(&mut reader, &mut file, &mut hasher, total, progress));
    let downloaded = match stream_result {
        Ok(downloaded) => downloaded,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary_path);
            let reason = if error.kind() == std::io::ErrorKind::TimedOut {
                "request timed out".to_string()
            } else {
                error.to_string()
            };
            return Err(fail(format!("download failed for {asset_name}: {reason}")));
        }
    };

    // 3. 尺寸校验（API 元数据 vs 实际字节）。
    if expected_size > 0 && downloaded != expected_size {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(fail(format!(
            "size mismatch for {asset_name}: expected {expected_size} bytes, got {downloaded}"
        )));
    }

    // 4. sha512 校验（rename 之前——坏文件永不落位）。
    let actual_digest = hex_lower(&hasher.finalize());
    if actual_digest != expected_digest {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(fail(format!(
            "sha512 mismatch for {asset_name}: expected {expected_digest}, got {actual_digest}"
        )));
    }

    // 5. 落位：原子替换成品（校验已通过；Windows rename =
    // MoveFileEx(REPLACE_EXISTING)，与 exchange-rate/icons 原子写同款语义）。
    if let Err(error) = std::fs::rename(&temporary_path, to) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(fail(format!(
            "failed to place downloaded file at {}: {error}",
            to.display()
        )));
    }
    Ok(())
}

/// 流式复制 + 哈希 + 进度回调。返回累计字节数；读/写失败（含读超时——ureq
/// 把 DeadlineStream 的 WouldBlock 归一化为 `ErrorKind::TimedOut`）原样上抛，
/// 由调用方统一清理临时文件。`progress` 首次以 (0, total) 调用，此后每块
/// 推进一次。
fn stream_to_file(
    reader: &mut dyn Read,
    file: &mut std::fs::File,
    hasher: &mut Sha512,
    total: u64,
    progress: Option<&(dyn Fn(u64, u64) + Send)>,
) -> Result<u64, std::io::Error> {
    if let Some(progress) = progress {
        progress(0, total);
    }
    let mut buffer = vec![0u8; STREAM_BUFFER_SIZE];
    let mut downloaded: u64 = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(downloaded);
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])?;
        downloaded += read as u64;
        if let Some(progress) = progress {
            progress(downloaded, total);
        }
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(all(test, windows))]
mod tests {
    use std::io::{Read as _, Write as _};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use super::*;
    use cabin_core::updater::{installer_asset_name, sidecar_asset_name};

    /// v1.0.1 下载 URL 安全校验：https-only + GitHub 域白名单。
    #[test]
    fn validate_download_url_accepts_github_https_only() {
        assert!(validate_download_url(
            "https://github.com/RupingLiu/command-cabin/releases/download/v1.0.1/x.exe"
        )
        .is_ok());
        assert!(
            validate_download_url("https://objects.githubusercontent.com/some/path?query=1")
                .is_ok()
        );
        assert!(validate_download_url("https://release-assets.githubusercontent.com/a/b").is_ok());
        assert!(validate_download_url("https://api.github.com/repos/x").is_ok());
        // 大小写与端口不敏感。
        assert!(validate_download_url("https://GITHUB.COM/x").is_ok());
        assert!(validate_download_url("https://github.com:443/x").is_ok());
    }

    #[test]
    fn validate_download_url_rejects_non_https_and_foreign_hosts() {
        // 明文 http / 其他协议一律拒绝。
        assert!(validate_download_url("http://github.com/x").is_err());
        assert!(validate_download_url("ftp://github.com/x").is_err());
        // 非 GitHub 主机（含仿冒子域/后缀拼接）拒绝。
        assert!(validate_download_url("https://evil.example.com/x").is_err());
        assert!(validate_download_url("https://github.com.evil.io/x").is_err());
        assert!(validate_download_url("https://notgithubusercontent.com/x").is_err());
        assert!(validate_download_url("https://127.0.0.1/x").is_err());
        assert!(validate_download_url("https://localhost/x").is_err());
        // userinfo 混淆拒绝（主机仍须白名单）。
        assert!(validate_download_url("https://user@evil.io/x").is_err());
        // 缺主机拒绝。
        assert!(validate_download_url("https:///x").is_err());
        assert!(validate_download_url("").is_err());
    }

    /// download() 入口校验接线：非 GitHub 资产 URL 在发起任何网络请求前即
    /// 拒绝（错误类型 UpdateDownload，消息含拒绝原因与原 URL）。
    #[test]
    fn download_rejects_foreign_asset_url_before_any_request() {
        let service = GitHubUpdateService::new();
        let asset = ReleaseAsset {
            name: "CommandCabin-Setup-9.9.9.exe".to_string(),
            url: "https://evil.example.com/CommandCabin-Setup-9.9.9.exe".to_string(),
            size: 1,
        };
        let target = std::env::temp_dir().join("cabin-updater-should-not-exist.exe");
        let error = service
            .download(&asset, &target, None)
            .expect_err("foreign host must be refused");
        assert!(
            matches!(error, PlatformError::UpdateDownload(message) if message.contains("refusing update download"))
        );
        assert!(!target.exists());
    }

    /// 多响应 HTTP mock：每个连接依次取一个响应（None → 关闭监听）；
    /// 单线程客户端按序请求，与 accept 循环一一对应。
    struct MockServer {
        addr: std::net::SocketAddr,
        requests: Arc<Mutex<Vec<String>>>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl MockServer {
        /// 恰好服务 `count` 个请求后线程退出（客户端按序请求、一连接一请求；
        /// count 之后的客户端连接被拒绝——计数错误的测试快速失败而非挂起）。
        fn start(count: usize, respond: impl Fn(usize) -> Vec<u8> + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            let addr = listener.local_addr().expect("local addr");
            let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let captured = requests.clone();
            let handle = std::thread::spawn(move || {
                for index in 0..count {
                    let Ok((mut stream, _)) = listener.accept() else {
                        break;
                    };
                    // 保险丝：客户端迟迟不发完整请求 → 读超时，join 必可返回。
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let raw = read_request(&mut stream);
                    captured
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&raw).into_owned());
                    let response = respond(index);
                    let _ = stream.write_all(&response);
                    let _ = stream.flush();
                }
            });
            Self {
                addr,
                requests,
                handle: Some(handle),
            }
        }

        fn single(response: Vec<u8>) -> Self {
            Self::start(1, move |_| response.clone())
        }

        fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.addr)
        }

        fn captured_requests(&mut self) -> Vec<String> {
            if let Some(handle) = self.handle.take() {
                handle.join().expect("mock server thread should not panic");
            }
            self.requests.lock().unwrap().clone()
        }
    }

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut raw = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).unwrap_or(0);
            if read == 0 {
                break;
            }
            raw.extend_from_slice(&chunk[..read]);
            if request_is_complete(&raw) {
                break;
            }
        }
        raw
    }

    fn request_is_complete(raw: &[u8]) -> bool {
        let Ok(text) = std::str::from_utf8(raw) else {
            return false;
        };
        match text.find("\r\n\r\n") {
            Some(header_end) => raw.len() >= header_end + 4,
            None => false,
        }
    }

    fn http_response(status_line: &str, content_type: &str, body: &str) -> Vec<u8> {
        http_response_bytes(status_line, content_type, body.as_bytes())
    }

    fn http_response_bytes(status_line: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "{status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len(),
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn create(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn leftover_files(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(&self.0)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn sha512_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha512::new();
        hasher.update(bytes);
        hex_lower(&hasher.finalize())
    }

    const VERSION: &str = "1.2.3";
    const ASSET_NAME: &str = "CommandCabin-Setup-1.2.3.exe";

    fn release_json() -> String {
        serde_json::json!({
            "tag_name": "v1.2.3",
            "body": "release notes\n",
            "assets": [
                {
                    "name": ASSET_NAME,
                    "browser_download_url": "https://github.com/RupingLiu/command-cabin/releases/download/v1.2.3/CommandCabin-Setup-1.2.3.exe",
                    "size": 97_433_771u64,
                },
                {
                    "name": sidecar_asset_name(ASSET_NAME),
                    "browser_download_url": "https://github.com/RupingLiu/command-cabin/releases/download/v1.2.3/CommandCabin-Setup-1.2.3.exe.sha512",
                    "size": 137u64,
                },
            ],
        })
        .to_string()
    }

    // ---- latest：请求形状 / 决策 / 错误映射 ----

    #[test]
    fn latest_sends_github_shape_and_returns_newer_info() {
        let mut server = MockServer::single(http_response(
            "HTTP/1.1 200 OK",
            "application/json",
            &release_json(),
        ));
        let info = GitHubUpdateService::latest_from(
            &server.url("/repos/RupingLiu/command-cabin/releases/latest"),
            "1.0.0",
            Duration::from_secs(5),
        )
        .expect("check succeeds")
        .expect("newer version");
        assert_eq!(info.version, VERSION);
        assert_eq!(info.notes.as_deref(), Some("release notes"));
        assert_eq!(info.assets.len(), 2);

        let request = &server.captured_requests()[0];
        let (request_line, headers) = request.split_once("\r\n").unwrap();
        assert_eq!(
            request_line,
            "GET /repos/RupingLiu/command-cabin/releases/latest HTTP/1.1"
        );
        let headers = headers.to_ascii_lowercase();
        assert!(
            headers.contains("user-agent: commandcabin-updater"),
            "{headers}"
        );
        assert!(
            headers.contains("accept: application/vnd.github+json"),
            "{headers}"
        );
        assert!(headers.contains("host:"), "{headers}");
    }

    #[test]
    fn latest_returns_none_when_not_newer() {
        let mut server = MockServer::start(2, move |_| {
            http_response("HTTP/1.1 200 OK", "application/json", &release_json())
        });
        let endpoint = server.url("/repos/RupingLiu/command-cabin/releases/latest");
        assert_eq!(
            GitHubUpdateService::latest_from(&endpoint, VERSION, Duration::from_secs(5)).unwrap(),
            None
        );
        assert_eq!(
            GitHubUpdateService::latest_from(&endpoint, "2.0.0", Duration::from_secs(5)).unwrap(),
            None
        );
        server.captured_requests();
    }

    #[test]
    fn latest_maps_http_500_to_readable_check_error() {
        let mut server = MockServer::single(http_response(
            "HTTP/1.1 500 Internal Server Error",
            "text/plain",
            "boom",
        ));
        let error = GitHubUpdateService::latest_from(
            &server.url("/releases/latest"),
            "1.0.0",
            Duration::from_secs(5),
        )
        .unwrap_err();
        server.captured_requests();
        assert_eq!(error.to_string(), "update check failed: HTTP 500");
    }

    #[test]
    fn latest_surfaces_malformed_responses() {
        let mut server = MockServer::single(http_response(
            "HTTP/1.1 200 OK",
            "application/json",
            r#"{"tag_name":"v1.2.3"}"#,
        ));
        let error = GitHubUpdateService::latest_from(
            &server.url("/releases/latest"),
            "1.0.0",
            Duration::from_secs(5),
        )
        .unwrap_err();
        server.captured_requests();
        assert_eq!(
            error.to_string(),
            "update check failed: malformed GitHub releases/latest response: assets[] is required"
        );
    }

    #[test]
    fn latest_rejects_unparseable_current_version() {
        let mut server = MockServer::single(http_response(
            "HTTP/1.1 200 OK",
            "application/json",
            &release_json(),
        ));
        let error = GitHubUpdateService::latest_from(
            &server.url("/releases/latest"),
            "not-a-version",
            Duration::from_secs(5),
        )
        .unwrap_err();
        server.captured_requests();
        assert_eq!(
            error.to_string(),
            "update check failed: invalid version \"not-a-version\": expected \"major.minor.patch\" (numeric components, no leading zeros, no prerelease label)"
        );
    }

    #[test]
    fn latest_times_out_against_a_delayed_server() {
        let mut server = MockServer::start(1, move |_| {
            std::thread::sleep(Duration::from_millis(2_000));
            http_response("HTTP/1.1 200 OK", "application/json", "{}")
        });
        let started = std::time::Instant::now();
        let error = GitHubUpdateService::latest_from(
            &server.url("/releases/latest"),
            "1.0.0",
            Duration::from_millis(300),
        )
        .unwrap_err();
        let elapsed = started.elapsed();
        server.captured_requests();
        assert_eq!(error.to_string(), "update check failed: request timed out");
        assert!(
            elapsed < Duration::from_millis(1_500),
            "elapsed {elapsed:?}"
        );
    }

    // ---- download：边车 + 流式落盘 + 校验 ----

    /// 组装两响应 mock：响应 0 = 边车（sha512sum 格式），响应 1 = 资产字节。
    fn asset_mock(digest_line: &str, asset_body: &[u8]) -> MockServer {
        let sidecar = http_response("HTTP/1.1 200 OK", "text/plain", digest_line);
        let asset = http_response_bytes("HTTP/1.1 200 OK", "application/octet-stream", asset_body);
        MockServer::start(2, move |index| match index {
            0 => sidecar.clone(),
            _ => asset.clone(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn download_with(
        server: &MockServer,
        asset_name: &str,
        asset_size: u64,
        to: &Path,
        progress: Option<&(dyn Fn(u64, u64) + Send)>,
        read_timeout: Duration,
    ) -> Result<(), PlatformError> {
        let sidecar_url = format!("{}/dl/{asset_name}.sha512", server.url(""));
        let asset_url = format!("{}/dl/{asset_name}", server.url(""));
        download_asset(
            &sidecar_url,
            &asset_url,
            asset_name,
            asset_size,
            to,
            progress,
            read_timeout,
        )
    }

    fn download_default(
        server: &MockServer,
        asset_name: &str,
        asset_size: u64,
        to: &Path,
        progress: Option<&(dyn Fn(u64, u64) + Send)>,
    ) -> Result<(), PlatformError> {
        download_with(
            server,
            asset_name,
            asset_size,
            to,
            progress,
            Duration::from_secs(5),
        )
    }

    #[test]
    fn downloads_verified_installer_and_reports_progress() {
        let payload: Vec<u8> = (0..=u8::MAX).cycle().take(5_000).collect();
        let digest_line = format!("{}  {ASSET_NAME}\n", sha512_hex(&payload));
        let mut server = asset_mock(&digest_line, &payload);
        let dir = TempDir::create("cabin-platform-update-happy");
        let to = dir.path(ASSET_NAME);

        let calls: Arc<Mutex<Vec<(u64, u64)>>> = Default::default();
        let result = {
            let calls = calls.clone();
            let total = payload.len() as u64;
            let progress = move |done: u64, reported_total: u64| {
                assert_eq!(reported_total, total);
                calls.lock().unwrap().push((done, reported_total));
            };
            download_default(
                &server,
                ASSET_NAME,
                payload.len() as u64,
                &to,
                Some(&progress),
            )
        };
        result.expect("verified download succeeds");

        let requests = server.captured_requests();
        let request_paths: Vec<&str> = requests
            .iter()
            .map(|request| request.split_whitespace().nth(1).unwrap())
            .collect();
        assert_eq!(
            request_paths,
            vec![
                format!("/dl/{}", sidecar_asset_name(ASSET_NAME)),
                format!("/dl/{ASSET_NAME}"),
            ]
        );

        assert_eq!(std::fs::read(&to).unwrap(), payload);
        // 无临时文件遗留。
        assert_eq!(dir.leftover_files(), vec![ASSET_NAME.to_string()]);

        // 进度：起点 (0, total)、终点 (total, total)、单调不减。
        let calls = calls.lock().unwrap().clone();
        assert_eq!(calls.first().copied(), Some((0, payload.len() as u64)));
        assert_eq!(
            calls.last().copied(),
            Some((payload.len() as u64, payload.len() as u64))
        );
        for pair in calls.windows(2) {
            assert!(pair[0].0 <= pair[1].0, "non-monotonic progress: {calls:?}");
        }
    }

    #[test]
    fn checksum_mismatch_deletes_temporary_file_and_errors() {
        let good: Vec<u8> = vec![1u8; 1_000];
        let evil: Vec<u8> = vec![2u8; 1_000];
        let digest_line = format!("{}  {ASSET_NAME}", sha512_hex(&good));
        let mut server = asset_mock(&digest_line, &evil);
        let dir = TempDir::create("cabin-platform-update-checksum");
        let to = dir.path(ASSET_NAME);

        let error =
            download_default(&server, ASSET_NAME, evil.len() as u64, &to, None).unwrap_err();
        server.captured_requests();
        assert_eq!(
            error.to_string(),
            format!(
                "update download failed: sha512 mismatch for {ASSET_NAME}: expected {}, got {}",
                sha512_hex(&good),
                sha512_hex(&evil)
            )
        );
        assert!(!to.exists());
        assert_eq!(dir.leftover_files(), Vec::<String>::new());
    }

    #[test]
    fn missing_sidecar_refuses_to_download_the_asset() {
        // 安全红线：边车 404 → 不发起资产请求、不落任何文件。
        let mut server = MockServer::start(1, |_| {
            http_response("HTTP/1.1 404 Not Found", "text/plain", "not found")
        });
        let dir = TempDir::create("cabin-platform-update-no-sidecar");
        let to = dir.path(ASSET_NAME);

        let error = download_default(&server, ASSET_NAME, 1_000, &to, None).unwrap_err();
        let requests = server.captured_requests();
        assert_eq!(
            error.to_string(),
            format!(
                "update download failed: sha512 sidecar fetch failed for {ASSET_NAME}: HTTP 404"
            )
        );
        assert_eq!(
            requests.len(),
            1,
            "asset must not be requested: {requests:?}"
        );
        assert!(!to.exists());
        assert_eq!(dir.leftover_files(), Vec::<String>::new());
    }

    #[test]
    fn invalid_sidecar_content_refuses_to_download_the_asset() {
        // 边车存在但内容不是合法 sha512sum 行（摘要过短）。
        let mut server = MockServer::start(1, |_| {
            http_response(
                "HTTP/1.1 200 OK",
                "text/plain",
                "deadbeef  CommandCabin-Setup-1.2.3.exe\n",
            )
        });
        let dir = TempDir::create("cabin-platform-update-bad-sidecar");
        let to = dir.path(ASSET_NAME);

        let error = download_default(&server, ASSET_NAME, 1_000, &to, None).unwrap_err();
        let requests = server.captured_requests();
        assert_eq!(
            error.to_string(),
            format!(
                "update download failed: missing or invalid sha512 sidecar for {ASSET_NAME}; refusing unverified download"
            )
        );
        assert_eq!(
            requests.len(),
            1,
            "asset must not be requested: {requests:?}"
        );
        assert_eq!(dir.leftover_files(), Vec::<String>::new());
    }

    #[test]
    fn http_500_on_asset_download_cleans_up() {
        let payload: Vec<u8> = vec![7u8; 100];
        let digest_line = format!("{}  {ASSET_NAME}", sha512_hex(&payload));
        let mut server = MockServer::start(2, move |index| match index {
            0 => http_response("HTTP/1.1 200 OK", "text/plain", &digest_line),
            _ => http_response("HTTP/1.1 500 Internal Server Error", "text/plain", "boom"),
        });
        let dir = TempDir::create("cabin-platform-update-asset-500");
        let to = dir.path(ASSET_NAME);

        let error =
            download_default(&server, ASSET_NAME, payload.len() as u64, &to, None).unwrap_err();
        server.captured_requests();
        assert_eq!(
            error.to_string(),
            format!("update download failed: asset fetch failed for {ASSET_NAME}: HTTP 500")
        );
        assert!(!to.exists());
        assert_eq!(dir.leftover_files(), Vec::<String>::new());
    }

    #[test]
    fn size_mismatch_against_api_metadata_errors_and_cleans_up() {
        let payload: Vec<u8> = vec![3u8; 500];
        let digest_line = format!("{}  {ASSET_NAME}", sha512_hex(&payload));
        let mut server = asset_mock(&digest_line, &payload);
        let dir = TempDir::create("cabin-platform-update-size");
        let to = dir.path(ASSET_NAME);

        // 声明尺寸（API 元数据）比实际多 1 字节。
        let error =
            download_default(&server, ASSET_NAME, payload.len() as u64 + 1, &to, None).unwrap_err();
        server.captured_requests();
        assert_eq!(
            error.to_string(),
            format!(
                "update download failed: size mismatch for {ASSET_NAME}: expected 501 bytes, got 500"
            )
        );
        assert_eq!(dir.leftover_files(), Vec::<String>::new());
    }

    #[test]
    fn download_times_out_when_the_server_never_responds() {
        let mut server = MockServer::start(1, move |_| {
            std::thread::sleep(Duration::from_millis(2_000));
            http_response("HTTP/1.1 200 OK", "text/plain", "late")
        });
        let dir = TempDir::create("cabin-platform-update-stall");
        let to = dir.path(ASSET_NAME);
        let started = std::time::Instant::now();
        let error = download_with(
            &server,
            ASSET_NAME,
            4,
            &to,
            None,
            Duration::from_millis(300),
        )
        .unwrap_err();
        let elapsed = started.elapsed();
        server.captured_requests();
        assert_eq!(
            error.to_string(),
            format!(
                "update download failed: sha512 sidecar fetch failed for {ASSET_NAME}: request timed out"
            )
        );
        assert!(
            elapsed < Duration::from_millis(1_500),
            "elapsed {elapsed:?}"
        );
        assert_eq!(dir.leftover_files(), Vec::<String>::new());
    }

    #[test]
    fn download_times_out_when_the_asset_stream_stalls_midway() {
        // 边车正常；资产先发响应头 + 10 字节（Content-Length: 100），随后挂起
        // 不发余量 → 读循环（而非响应头等待）在 read 超时处失败。
        let digest_line = format!("{}  {ASSET_NAME}", sha512_hex(&[0u8; 100]));
        let sidecar = http_response("HTTP/1.1 200 OK", "text/plain", &digest_line);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            for (index, stream) in listener.incoming().enumerate() {
                let Ok(mut stream) = stream else { break };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let _ = read_request(&mut stream);
                if index == 0 {
                    let _ = stream.write_all(&sidecar);
                    let _ = stream.flush();
                    continue;
                }
                let mut bytes = b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\nConnection: close\r\n\r\n".to_vec();
                bytes.extend_from_slice(&[9u8; 10]);
                let _ = stream.write_all(&bytes);
                let _ = stream.flush();
                // 保持连接 2s：让客户端的读超时（300ms）先到。
                std::thread::sleep(Duration::from_millis(2_000));
            }
        });
        let server = MockServer {
            addr,
            requests: Arc::new(Mutex::new(Vec::new())),
            handle: None,
        };
        let _ = handle; // 守护线程自行结束（sleep 后循环退出）。
        let dir = TempDir::create("cabin-platform-update-mid-stall");
        let to = dir.path(ASSET_NAME);
        let started = std::time::Instant::now();
        let error = download_with(
            &server,
            ASSET_NAME,
            100,
            &to,
            None,
            Duration::from_millis(300),
        )
        .unwrap_err();
        let elapsed = started.elapsed();
        assert_eq!(
            error.to_string(),
            format!("update download failed: download failed for {ASSET_NAME}: request timed out")
        );
        assert!(
            elapsed < Duration::from_millis(1_500),
            "elapsed {elapsed:?}"
        );
        assert_eq!(dir.leftover_files(), Vec::<String>::new());
    }

    #[test]
    fn download_creates_missing_parent_directories() {
        let payload: Vec<u8> = vec![5u8; 64];
        let digest_line = format!("{}  {ASSET_NAME}", sha512_hex(&payload));
        let mut server = asset_mock(&digest_line, &payload);
        let dir = TempDir::create("cabin-platform-update-mkdir");
        let to = dir.path("nested").join("deeper").join(ASSET_NAME);
        download_default(&server, ASSET_NAME, payload.len() as u64, &to, None)
            .expect("download creates parents");
        server.captured_requests();
        assert_eq!(std::fs::read(&to).unwrap(), payload);
    }

    #[test]
    fn atomically_replaces_an_existing_target() {
        let payload: Vec<u8> = vec![6u8; 64];
        let digest_line = format!("{}  {ASSET_NAME}", sha512_hex(&payload));
        let mut server = asset_mock(&digest_line, &payload);
        let dir = TempDir::create("cabin-platform-update-overwrite");
        let to = dir.path(ASSET_NAME);
        std::fs::write(&to, b"stale-previous-download").unwrap();

        download_default(&server, ASSET_NAME, payload.len() as u64, &to, None)
            .expect("verified download replaces stale file");
        server.captured_requests();
        // 成品整体换新，无临时文件遗留。
        assert_eq!(std::fs::read(&to).unwrap(), payload);
        assert_eq!(dir.leftover_files(), vec![ASSET_NAME.to_string()]);
    }

    /// 真实端点探针（需要外网；默认忽略）。运行：
    /// `cargo test -p cabin-platform-windows -- --ignored real_endpoint_probe`。
    /// 打印 live 状态：200 → 版本与资产数（要求 UA 被接受、响应可被核心层
    /// 解析）；404 → 仓库尚无发布（客户端基建本身工作正常）；其余 → 失败。
    #[test]
    #[ignore = "requires internet access; real endpoint probe"]
    fn real_endpoint_probe() {
        let started = std::time::Instant::now();
        match http_get_text(
            GITHUB_RELEASES_LATEST_ENDPOINT,
            Duration::from_millis(DEFAULT_UPDATE_CHECK_TIMEOUT_MS),
        ) {
            Ok(body) => {
                let info = parse_github_release_response(&body)
                    .expect("live endpoint should return a parseable release");
                let installer = cabin_core::updater::find_installer_asset(&info);
                println!(
                    "probe: OK in {:?} version={} assets={} installer_asset={:?}",
                    started.elapsed(),
                    info.version,
                    info.assets.len(),
                    installer.map(|asset| asset.name.as_str()),
                );
            }
            Err(HttpFailure::Status(404)) => {
                println!(
                    "probe: endpoint reachable but no releases published yet (404) in {:?}",
                    started.elapsed()
                );
            }
            Err(failure) => {
                panic!(
                    "real endpoint probe failed after {:?}: {}",
                    started.elapsed(),
                    failure.describe()
                )
            }
        }
    }

    /// 命名约定自检：本测试的资产名与 Task 4 将产出的安装包名一致。
    #[test]
    fn asset_names_follow_the_release_convention() {
        assert_eq!(installer_asset_name(VERSION), ASSET_NAME);
        assert_eq!(
            sidecar_asset_name(ASSET_NAME),
            "CommandCabin-Setup-1.2.3.exe.sha512"
        );
    }
}
