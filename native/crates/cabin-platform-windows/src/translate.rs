//! 在线翻译 HTTP 客户端（平台 IO 层）。
//!
//! **分界约定（本任务定下）**：纯逻辑归 `cabin_core::screenshot::translate`
//! ——文本 normalize、语言映射、请求形状（URL + 有序表单对）、响应解析与
//! 结果整形、空/超限/同语言短路；本模块只做 IO 与错误映射——
//! - `ureq`（rustls，同步、无 tokio）POST `application/x-www-form-urlencoded`
//!   请求体，`Accept: application/json`，整体超时默认
//!   [`cabin_core::screenshot::DEFAULT_TRANSLATION_TIMEOUT_MS`]（6s）；
//! - 非 200 → [`TranslationHttpError::Status`]（核心层格式化为逐字消息
//!   `Online translation failed with HTTP {status}.`）；
//! - 超时 → [`TranslationHttpError::Timeout`]（→ `Online translation timed
//!   out.`，对齐 TS AbortError 分支）；
//! - 其余传输层失败（DNS/连接/无效 URL/响应体读取）→
//!   [`TranslationHttpError::Network`]，消息原样透传（对齐 TS
//!   `reason.message`）。
//!
//! 对齐 TS `runOnlineTranslate`（onlineTranslate.ts:205-288）的 provider 选择：
//! `endpoint=None` → Google 默认端点；`Some(custom)` → MyMemory 形状。

use std::time::Duration;

use cabin_core::screenshot::{
    translate_text, TranslationHttpError, TranslationOutcome, DEFAULT_TRANSLATION_TIMEOUT_MS,
};

/// 表单 URL 编码（`application/x-www-form-urlencoded`：空格 → `+` 等）。
fn encode_form(form: &[(String, String)]) -> String {
    form_urlencoded::Serializer::new(String::new())
        .extend_pairs(
            form.iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .finish()
}

/// ureq 2.x 的超时信号：`ErrorKind::Io` + 内层 `io::ErrorKind::TimedOut`
/// （ureq 在 DeadlineStream 中把 socket 的 WouldBlock 归一化为 TimedOut，
/// 见其 stream.rs 注释）。
fn transport_is_timeout(transport: &ureq::Transport) -> bool {
    use std::error::Error as _;
    transport.kind() == ureq::ErrorKind::Io
        && transport
            .source()
            .and_then(|source| source.downcast_ref::<std::io::Error>())
            .is_some_and(|io_error| io_error.kind() == std::io::ErrorKind::TimedOut)
}

/// 同步 POST 表单并读取 2xx 响应体（字符串）。见模块注释的错误映射。
pub fn http_post_form(
    url: &str,
    form: &[(String, String)],
    timeout: Duration,
) -> Result<String, TranslationHttpError> {
    let body = encode_form(form);
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let response = agent
        .post(url)
        .set("Accept", "application/json")
        .set(
            "Content-Type",
            "application/x-www-form-urlencoded;charset=UTF-8",
        )
        .send_string(&body);
    match response {
        Ok(ok) => ok
            .into_string()
            .map_err(|error| TranslationHttpError::Network(error.to_string())),
        Err(ureq::Error::Status(status, _)) => Err(TranslationHttpError::Status(status)),
        Err(ureq::Error::Transport(transport)) => {
            if transport_is_timeout(&transport) {
                Err(TranslationHttpError::Timeout)
            } else {
                Err(TranslationHttpError::Network(transport.to_string()))
            }
        }
    }
}

/// TS `runOnlineTranslate` 默认路径（Google 端点，6s 超时）。
pub fn run_online_translate(
    source_language: &str,
    target_language: &str,
    text: &str,
) -> TranslationOutcome {
    run_online_translate_with_options(source_language, target_language, text, None, None)
}

/// 自定义端点路径（MyMemory 形状），超时用默认 6s。
pub fn run_online_translate_with_endpoint(
    source_language: &str,
    target_language: &str,
    text: &str,
    endpoint: &str,
) -> TranslationOutcome {
    run_online_translate_with_options(source_language, target_language, text, Some(endpoint), None)
}

/// 可注入端点与超时的完整入口（测试与后续调用方的逃生门）。
/// `endpoint=None` 走 Google 默认端点；`timeout=None` 用 6s 默认值。
pub fn run_online_translate_with_options(
    source_language: &str,
    target_language: &str,
    text: &str,
    endpoint: Option<&str>,
    timeout: Option<Duration>,
) -> TranslationOutcome {
    let timeout = timeout.unwrap_or(Duration::from_millis(DEFAULT_TRANSLATION_TIMEOUT_MS));
    translate_text(
        source_language,
        target_language,
        text,
        endpoint,
        |request| http_post_form(&request.url, &request.form, timeout),
    )
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    use cabin_core::screenshot::TranslationStatus;

    /// 一次性 HTTP mock 服务器：accept 一次，读完整请求（头 + Content-Length
    /// 体）后调用 `respond` 写回响应。`respond` 在服务器线程执行（可睡眠模拟
    /// 慢响应）。测试结束后 join 并取回捕获的原始请求文本。
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
                // 客户端可能已因超时断开：写失败可忽略。
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

    /// 读取到请求头 + Content-Length 指定的体长为止（客户端 keep-alive 不阻塞）。
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
        let Some(header_end) = text.find("\r\n\r\n") else {
            return false;
        };
        let content_length = text[..header_end]
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())?
            })
            .unwrap_or(0);
        raw.len() >= header_end + 4 + content_length
    }

    fn http_response(status_line: &str, content_type: &str, body: &str) -> Vec<u8> {
        format!(
            "{status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        )
        .into_bytes()
    }

    /// Google 分支的表单形状与解析已在 cabin-core 的 translate 测试覆盖
    /// （`translate.rs` 测试断言 `GOOGLE_TRANSLATE_ENDPOINT` + client/dt/q/sl/tl
    /// 顺序，经注入 fetch 闭包验证）。平台层的 provider 分支是硬编码的
    /// （`None` → 真实 Google 端点，无法注入 mock URL），故此处不再重复
    /// 端到端测试 Google 形状——那会打到真实网络；HTTP IO 语义（表单头、
    /// 非 200、超时、解析）由下面的 MyMemory 形状测试完整覆盖，两者共享
    /// 同一条 `http_post_form` 代码路径。
    #[test]
    fn posts_mymemory_request_shape_and_parses_response() {
        let mut server = OneShotServer::start(|_| {
            http_response(
                "HTTP/1.1 200 OK",
                "application/json",
                &serde_json::json!({ "responseData": { "translatedText": " 你好 " } }).to_string(),
            )
        });
        let outcome = run_online_translate_with_options(
            "en-US",
            "zh-CN",
            "hello",
            Some(&server.url("/translate")),
            Some(Duration::from_secs(5)),
        );
        let request = server.captured_request();
        assert_eq!(
            request.split_once("\r\n").unwrap().0,
            "POST /translate HTTP/1.1"
        );
        let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
        let pairs: Vec<(String, String)> = body
            .split('&')
            .map(|pair| {
                let (key, value) = pair.split_once('=').expect("form pair");
                (key.to_string(), value.replace('+', " "))
            })
            .collect();
        assert_eq!(
            pairs,
            vec![
                // TS URLSearchParams 同样把 `|` 编码为 %7C（WHATWG
                // application/x-www-form-urlencoded 序列化）。
                ("langpair".to_string(), "en%7Czh-CN".to_string()),
                ("q".to_string(), "hello".to_string()),
            ],
        );
        assert_eq!(outcome.status, TranslationStatus::Success);
        assert_eq!(outcome.translated_text.as_deref(), Some("你好"));
    }

    #[test]
    fn maps_http_500_to_verbatim_error_message() {
        let mut server = OneShotServer::start(|_| {
            http_response("HTTP/1.1 500 Internal Server Error", "text/plain", "boom")
        });
        let outcome = run_online_translate_with_options(
            "en-US",
            "zh-CN",
            "hello",
            Some(&server.url("/translate")),
            Some(Duration::from_secs(5)),
        );
        server.captured_request();
        assert_eq!(outcome.status, TranslationStatus::Error);
        assert_eq!(
            outcome.message.as_deref(),
            Some("Online translation failed with HTTP 500."),
        );
    }

    #[test]
    fn maps_malformed_200_body_to_error_result() {
        let mut server = OneShotServer::start(|_| {
            http_response("HTTP/1.1 200 OK", "application/json", "not json at all")
        });
        let outcome = run_online_translate_with_options(
            "en-US",
            "zh-CN",
            "hello",
            Some(&server.url("/translate")),
            Some(Duration::from_secs(5)),
        );
        server.captured_request();
        assert_eq!(outcome.status, TranslationStatus::Error);
        assert!(outcome.message.as_deref().is_some_and(|m| !m.is_empty()));
    }

    #[test]
    fn reports_no_text_for_valid_but_unexpected_json() {
        let mut server =
            OneShotServer::start(|_| http_response("HTTP/1.1 200 OK", "application/json", "{}"));
        let outcome = run_online_translate_with_options(
            "en-US",
            "zh-CN",
            "hello",
            Some(&server.url("/translate")),
            Some(Duration::from_secs(5)),
        );
        server.captured_request();
        assert_eq!(outcome.status, TranslationStatus::Error);
        assert_eq!(
            outcome.message.as_deref(),
            Some("Online translation returned no text."),
        );
    }

    #[test]
    fn times_out_against_a_delayed_server() {
        let mut server = OneShotServer::start(|_| {
            std::thread::sleep(Duration::from_millis(2_000));
            http_response("HTTP/1.1 200 OK", "application/json", "{}")
        });
        let started = std::time::Instant::now();
        let outcome = run_online_translate_with_options(
            "en-US",
            "zh-CN",
            "hello",
            Some(&server.url("/translate")),
            Some(Duration::from_millis(300)),
        );
        let elapsed = started.elapsed();
        server.captured_request();
        assert_eq!(outcome.status, TranslationStatus::Error);
        assert_eq!(
            outcome.message.as_deref(),
            Some("Online translation timed out."),
        );
        // 超时应由客户端在 300ms 附近触发，而不是等满服务器延迟。
        assert!(
            elapsed < Duration::from_millis(1_500),
            "elapsed {elapsed:?}"
        );
    }
}
