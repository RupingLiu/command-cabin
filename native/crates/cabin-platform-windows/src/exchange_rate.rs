//! 汇率 HTTP 客户端（平台 IO 层）。
//!
//! **分界约定（与 translate.rs 同构）**：端点常量、响应解析与缓存策略归
//! `cabin_core::features::exchange_rate`；本模块只做 GET IO 与错误映射——
//! - `ureq`（rustls，同步、无 tokio）GET 请求，整体超时默认
//!   [`cabin_core::features::exchange_rate::DEFAULT_EXCHANGE_RATE_TIMEOUT_MS`]
//!   （1200ms，对齐 TS `exchangeRateCache.ts` 的 `DEFAULT_TIMEOUT_MS`）；
//! - 非 2xx → [`ExchangeRateHttpError::Status`]；
//! - 超时 → [`ExchangeRateHttpError::Timeout`]（对齐 TS AbortError 分支）；
//! - 其余传输层失败（DNS/连接/无效 URL/响应体读取）→
//!   [`ExchangeRateHttpError::Network`]。
//!
//! TS 侧 `fetchLiveRate` 把 `!response.ok` 与抛错统一折叠为 undefined；[`fetch_frankfurter_body`]
//! 提供同语义的折叠入口（`Option<String>`），错误枚举仅供测试与诊断。

use std::time::Duration;

use cabin_core::features::exchange_rate::{
    DEFAULT_EXCHANGE_RATE_TIMEOUT_MS, FRANKFURTER_USD_CNY_ENDPOINT,
};

/// 平台 HTTP 的三类失败（映射自 ureq；语义与 translate.rs 一致）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExchangeRateHttpError {
    Timeout,
    Status(u16),
    Network(String),
}

/// ureq 2.x 的超时信号判定（translate.rs 同款：ErrorKind::Io +
/// 内层 io::ErrorKind::TimedOut）。
fn transport_is_timeout(transport: &ureq::Transport) -> bool {
    use std::error::Error as _;
    transport.kind() == ureq::ErrorKind::Io
        && transport
            .source()
            .and_then(|source| source.downcast_ref::<std::io::Error>())
            .is_some_and(|io_error| io_error.kind() == std::io::ErrorKind::TimedOut)
}

/// 同步 GET 并读取 2xx 响应体（字符串）。见模块注释的错误映射。
pub fn http_get_string(url: &str, timeout: Duration) -> Result<String, ExchangeRateHttpError> {
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    match agent.get(url).call() {
        Ok(ok) => ok
            .into_string()
            .map_err(|error| ExchangeRateHttpError::Network(error.to_string())),
        Err(ureq::Error::Status(status, _)) => Err(ExchangeRateHttpError::Status(status)),
        Err(ureq::Error::Transport(transport)) => {
            if transport_is_timeout(&transport) {
                Err(ExchangeRateHttpError::Timeout)
            } else {
                Err(ExchangeRateHttpError::Network(transport.to_string()))
            }
        }
    }
}

/// TS `fetchLiveRate` 的 IO 部分：GET 汇率端点，任何失败（非 2xx / 超时 /
/// 网络）折叠为 `None`。响应体的严格解析由核心层
/// `parse_frankfurter_response` 完成（需要缓存的时钟生成 fetchedAt）。
pub fn fetch_frankfurter_body(timeout: Option<Duration>) -> Option<String> {
    http_get_string(
        FRANKFURTER_USD_CNY_ENDPOINT,
        timeout.unwrap_or(Duration::from_millis(DEFAULT_EXCHANGE_RATE_TIMEOUT_MS)),
    )
    .ok()
}

#[cfg(all(test, windows))]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use super::*;
    use cabin_core::features::exchange_rate::{parse_frankfurter_response, ExchangeRateCache};
    use cabin_core::features::quick_converter::ExchangeRateResultSource;

    /// 一次性 HTTP mock 服务器（translate.rs 同款：accept 一次，读完整请求后
    /// 写回响应，捕获原始请求文本）。
    struct OneShotServer {
        addr: std::net::SocketAddr,
        request: Arc<Mutex<Option<String>>>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl OneShotServer {
        fn start(respond: impl FnOnce(&str) -> Vec<u8> + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            let addr = listener.local_addr().expect("local addr");
            let request: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let captured = request.clone();
            let handle = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept one connection");
                let raw = read_request(&mut stream);
                *captured.lock().unwrap() = Some(String::from_utf8_lossy(&raw).into_owned());
                let response = respond(&String::from_utf8_lossy(&raw));
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            });
            Self {
                addr,
                request,
                handle: Some(handle),
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.addr)
        }

        fn captured_request(&mut self) -> String {
            if let Some(handle) = self.handle.take() {
                handle.join().expect("mock server thread should not panic");
            }
            self.request
                .lock()
                .unwrap()
                .clone()
                .expect("request should have been captured")
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
        format!(
            "{status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        )
        .into_bytes()
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn create(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn gets_the_frankfurter_request_shape_and_returns_the_body() {
        let mut server = OneShotServer::start(|_| {
            http_response(
                "HTTP/1.1 200 OK",
                "application/json",
                r#"{"date":"2026-09-05","base":"USD","quote":"CNY","rate":6.7129}"#,
            )
        });
        let body = http_get_string(&server.url("/v2/rate/USD/CNY"), Duration::from_secs(5))
            .expect("200 response");
        let request = server.captured_request();
        assert_eq!(
            request.split_once("\r\n").unwrap().0,
            "GET /v2/rate/USD/CNY HTTP/1.1"
        );
        // GET 无请求体。
        let (headers, body_part) = request.split_once("\r\n\r\n").unwrap();
        assert!(body_part.is_empty());
        assert!(headers.to_ascii_lowercase().contains("host:"));
        // 响应体可被核心层严格解析。
        let rate = parse_frankfurter_response(&body, 0).expect("frankfurter shape");
        assert_eq!(rate.rate, 6.7129);
        assert_eq!(rate.updated_at, "2026-09-05");
        assert_eq!(rate.provider, "Frankfurter");
    }

    #[test]
    fn maps_http_500_to_status_error() {
        let mut server = OneShotServer::start(|_| {
            http_response("HTTP/1.1 500 Internal Server Error", "text/plain", "boom")
        });
        let error =
            http_get_string(&server.url("/v2/rate/USD/CNY"), Duration::from_secs(5)).unwrap_err();
        server.captured_request();
        assert_eq!(error, ExchangeRateHttpError::Status(500));
        // 折叠入口：非 2xx → None（TS `!response.ok` 分支）。
        assert_eq!(
            fetch_frankfurter_body_with(server.url("/v2/rate/USD/CNY")),
            None
        );
    }

    /// 以自定义 URL 取数（测试逃生门；生产入口固定 TS 端点）。
    fn fetch_frankfurter_body_with(url: String) -> Option<String> {
        http_get_string(&url, Duration::from_secs(5)).ok()
    }

    #[test]
    fn maps_malformed_body_to_none_at_core_parse() {
        let mut server = OneShotServer::start(|_| {
            http_response("HTTP/1.1 200 OK", "application/json", "not json at all")
        });
        let body = http_get_string(&server.url("/rate"), Duration::from_secs(5))
            .expect("200 response passes IO");
        server.captured_request();
        // IO 层透传原始体；严格解析失败发生在核心层。
        assert_eq!(body, "not json at all");
        assert_eq!(parse_frankfurter_response(&body, 0), None);
    }

    #[test]
    fn times_out_against_a_delayed_server() {
        let mut server = OneShotServer::start(|_| {
            std::thread::sleep(Duration::from_millis(2_000));
            http_response("HTTP/1.1 200 OK", "application/json", "{}")
        });
        let started = std::time::Instant::now();
        let error = http_get_string(&server.url("/rate"), Duration::from_millis(300)).unwrap_err();
        let elapsed = started.elapsed();
        server.captured_request();
        assert_eq!(error, ExchangeRateHttpError::Timeout);
        assert!(
            elapsed < Duration::from_millis(1_500),
            "elapsed {elapsed:?}"
        );
    }

    #[test]
    fn cache_end_to_end_with_live_http_mock() {
        // 核心缓存 + 平台 HTTP 的完整链路：无缓存文件 → live 抓取 → 原子落盘。
        let dir = TempDir::create("cabin-platform-rate-e2e");
        let path = dir.0.join("exchange-rates.json");
        let mut server = OneShotServer::start(|_| {
            http_response(
                "HTTP/1.1 200 OK",
                "application/json",
                r#"{"base":"USD","date":"2026-05-18","quote":"CNY","rate":7.1234}"#,
            )
        });
        let url = server.url("/v2/rate/USD/CNY");
        let mut cache = ExchangeRateCache::load(&path);
        let rate = cache
            .get_usd_to_cny_rate(move || http_get_string(&url, Duration::from_secs(5)).ok())
            .expect("live rate via mock http");
        server.captured_request();
        assert_eq!(rate.rate, 7.1234);
        assert_eq!(rate.source, ExchangeRateResultSource::Live);
        assert_eq!(rate.updated_at, "2026-05-18");
        // 已落盘：再次查询（无网络）命中新鲜缓存。
        let mut cache = ExchangeRateCache::load(&path);
        let rate = cache.get_usd_to_cny_rate(|| None).expect("cached rate");
        assert_eq!(rate.rate, 7.1234);
        assert_eq!(rate.source, ExchangeRateResultSource::Cache);
    }

    /// 真实端点探针（需要外网；默认忽略）。运行：
    /// `cargo test -p cabin-platform-windows -- --ignored real_endpoint`。
    /// 断言 TS 端点 `FRANKFURTER_USD_CNY_ENDPOINT` 存活且响应可被核心层解析。
    #[test]
    #[ignore = "requires internet access; real endpoint probe"]
    fn real_endpoint_probe() {
        let started = std::time::Instant::now();
        let outcome = http_get_string(
            FRANKFURTER_USD_CNY_ENDPOINT,
            Duration::from_millis(DEFAULT_EXCHANGE_RATE_TIMEOUT_MS.max(5_000)),
        );
        let elapsed = started.elapsed();
        match outcome {
            Ok(body) => {
                let rate = parse_frankfurter_response(&body, 0)
                    .expect("live endpoint should return a parseable rate");
                assert!(
                    rate.rate.is_finite() && rate.rate > 0.0,
                    "rate {}",
                    rate.rate
                );
                println!("probe: OK in {elapsed:?} body={body}");
            }
            Err(error) => panic!("real endpoint probe failed after {elapsed:?}: {error:?}"),
        }
    }
}
