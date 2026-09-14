//! 在线翻译：纯解析/整形逻辑（无 IO）。
//!
//! 逐字移植 TS `apps/desktop/src/main/screenshot/onlineTranslate.ts`：
//! - [`normalize_text_for_online_translation`] = `normalizeTextForOnlineTranslation`
//!   （onlineTranslate.ts:39-63）：`\r\n`→`\n`、`[ \t]+`→`' '`、标点间距修正、
//!   en-US 的 OCR 断词修复（两轮规则 ×3）、按行 trim/过滤后 `\n` 连接。
//! - [`to_online_language`] = `toOnlineLanguage`（zh-CN→zh-CN、zh-TW→zh-TW、
//!   en-US→en；未知 tag 原样返回——TS 的穷举 switch 只接受三个合法值，
//!   调用方（IPC 解析层）保证输入合法，此处兜底透传以便独立复用）。
//! - [`parse_google_translated_text`] / [`parse_my_memory_translated_text`] =
//!   `parseGoogleTranslatedText` / `parseMyMemoryTranslatedText`。
//! - [`translate_text`] = `runOnlineTranslate` 的编排骨架：normalize → 空/超限
//!   判定（消息逐字）→ 语言映射 → 同语言短路 → 委托 fetch → 解析/整形。
//!
//! **IO 分界**（本任务约定）：本 crate 只拥有解析与结果整形；HTTP 由平台层
//! （cabin-platform-windows）执行。fetch 以 [`FnOnce`] 闭包注入——结构上保证
//! 每次翻译至多发起一次网络请求（对应 TS 用例 "does not send OCR text to a
//! second provider when the primary endpoint fails"）。
//!
//! 与 TS 的有意差异：
//! - TS 的 `fetch` 缺失分支（'Online translation is unavailable in this
//!   runtime.'）在 Rust 中不存在（HTTP 栈总是可用）；消息常量
//!   [`ONLINE_TRANSLATION_UNAVAILABLE_MESSAGE`] 仍逐字保留以对齐契约。
//! - 文本长度上限按 JS `String.length` 语义（UTF-16 码元）计算
//!   （[`MAX_TRANSLATION_TEXT_LENGTH`]）。

use serde_json::Value;

/// TS `GOOGLE_TRANSLATE_ENDPOINT`（onlineTranslate.ts:6）。
pub const GOOGLE_TRANSLATE_ENDPOINT: &str = "https://translate.googleapis.com/translate_a/single";
/// TS `DEFAULT_TRANSLATION_TIMEOUT_MS`（onlineTranslate.ts:7）。
pub const DEFAULT_TRANSLATION_TIMEOUT_MS: u64 = 6_000;
/// TS `MAX_TRANSLATION_TEXT_LENGTH`（onlineTranslate.ts:8）。
pub const MAX_TRANSLATION_TEXT_LENGTH: usize = 2_000;

/// 逐字消息：无 OCR 文本。
pub const NO_OCR_TEXT_MESSAGE: &str = "No OCR text found.";
/// 逐字消息：无可用文本结果（两个 provider 的空响应）。
pub const NO_TRANSLATED_TEXT_MESSAGE: &str = "Online translation returned no text.";
/// 逐字消息：运行时无 fetch（Rust 路径不可达，保留契约）。
pub const ONLINE_TRANSLATION_UNAVAILABLE_MESSAGE: &str =
    "Online translation is unavailable in this runtime.";
/// 逐字消息：fetch 失败兜底（TS 非 Error 抛出值）。
pub const TRANSLATION_FAILED_MESSAGE: &str = "Online translation failed.";

/// TS `ScreenshotTranslationResult` 的三态判别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslationStatus {
    Success,
    Unavailable,
    Error,
}

/// TS `ScreenshotTranslationResult` 三变体的统一承载（判别字段 `status`）。
/// success 变体填充 `source_text` / `translated_text`；unavailable / error
/// 变体填充 `message`（对齐 shared/screenshotApi.ts 的 parse 语义）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationOutcome {
    pub status: TranslationStatus,
    pub ocr_language: String,
    pub target_language: String,
    pub source_text: Option<String>,
    pub translated_text: Option<String>,
    pub message: Option<String>,
}

/// 核心构造的 HTTP 请求描述；平台层负责 URL 编码与发送。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationHttpRequest {
    pub url: String,
    /// 有序表单键值对（对应 TS `URLSearchParams` 的插入顺序）。
    pub form: Vec<(String, String)>,
}

/// 平台 HTTP 的三类失败（平台层映射自 ureq；核心层只消费此枚举）。
/// - `Timeout`：超时（TS AbortError）→ 'Online translation timed out.'
/// - `Status(code)`：非 200 → 'Online translation failed with HTTP {code}.'
/// - `Network(message)`：其余（DNS/连接/响应读取/无效 URL 等）→ 原样作为
///   消息（对齐 TS `reason.message`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranslationHttpError {
    Timeout,
    Status(u16),
    Network(String),
}

fn unavailable_outcome(
    ocr_language: &str,
    target_language: &str,
    message: &str,
) -> TranslationOutcome {
    TranslationOutcome {
        status: TranslationStatus::Unavailable,
        ocr_language: ocr_language.to_string(),
        target_language: target_language.to_string(),
        source_text: None,
        translated_text: None,
        message: Some(message.to_string()),
    }
}

fn error_outcome(ocr_language: &str, target_language: &str, message: String) -> TranslationOutcome {
    TranslationOutcome {
        status: TranslationStatus::Error,
        ocr_language: ocr_language.to_string(),
        target_language: target_language.to_string(),
        source_text: None,
        translated_text: None,
        message: Some(message),
    }
}

fn success_outcome(
    ocr_language: &str,
    target_language: &str,
    source_text: String,
    translated_text: String,
) -> TranslationOutcome {
    TranslationOutcome {
        status: TranslationStatus::Success,
        ocr_language: ocr_language.to_string(),
        target_language: target_language.to_string(),
        source_text: Some(source_text),
        translated_text: Some(translated_text),
        message: None,
    }
}

/// JS `\s`（非 unicode 正则语义）：ASCII 空白 + NBSP 等常见 Unicode 空白。
/// `String.trim` 使用同一集合，见 [`trim_js_whitespace`]。
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    ) || matches!(c, '\u{2000}'..='\u{200A}')
}

/// JS `\w`：`[A-Za-z0-9_]`（`\b` 词边界基于此集合）。
fn is_js_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn trim_js_whitespace(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `[ \t]+` → `' '`（已是单空格的串保持不变）。
fn collapse_spaces_and_tabs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == ' ' || c == '\t' {
            while matches!(chars.peek(), Some(' ') | Some('\t')) {
                chars.next();
            }
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

/// `[ \t]+([,.;:!?])` → `$1`：删除标点前的空格/制表符（折叠后即单个空格）。
fn remove_space_before_punctuation(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if matches!(c, ' ' | '\t')
            && matches!(chars.peek(), Some(',' | '.' | ';' | ':' | '!' | '?'))
        {
            continue;
        }
        out.push(c);
    }
    out
}

/// `([,.;:!?])(?=\S)` → `$1 `：标点后紧跟非空白时插入一个空格。
fn add_space_after_punctuation(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if matches!(c, ',' | '.' | ';' | ':' | '!' | '?')
            && chars.peek().is_some_and(|next| !is_js_whitespace(*next))
        {
            out.push(' ');
        }
    }
    out
}

/// `\b([B-HJ-Z])\s+([a-z]{2,})\b` → `$1$2` 的单趟非重叠扫描替换。
///
/// 排除 `A`/`I` 与 TS 一致——它们本身是英文单词。`{2,}` 为贪婪匹配；
/// 词边界失败时正则的回溯不可能是（被让出的字符都在 `[a-z]` 内，任何内部
/// 切点两侧都是 `\w`），故一次贪婪尝试即可判定。
fn replace_single_upper_join(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let boundary_before = i == 0 || !is_js_word(chars[i - 1]);
        let c = chars[i];
        if boundary_before && matches!(c, 'B'..='H' | 'J'..='Z') {
            let mut j = i + 1;
            while j < chars.len() && is_js_whitespace(chars[j]) {
                j += 1;
            }
            let whitespace_end = j;
            let lower_start = j;
            while j < chars.len() && chars[j].is_ascii_lowercase() {
                j += 1;
            }
            let boundary_after = j >= chars.len() || !is_js_word(chars[j]);
            if whitespace_end > i + 1 && j - lower_start >= 2 && boundary_after {
                out.push(c);
                out.extend_from_slice(&chars[lower_start..j]);
                i = j;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// `\b([A-Za-z]{3,})\s+([a-z])\b` → `$1$2` 的单趟非重叠扫描替换。
///
/// 贪婪词匹配后必须紧跟 `\s+`；回溯不可能（让出的字符是字母而非空白）。
fn replace_word_single_lower_join(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let boundary_before = i == 0 || !is_js_word(chars[i - 1]);
        let c = chars[i];
        if boundary_before && c.is_ascii_alphabetic() {
            let word_start = i;
            let mut j = i;
            while j < chars.len() && chars[j].is_ascii_alphabetic() {
                j += 1;
            }
            let word_len = j - word_start;
            let mut k = j;
            while k < chars.len() && is_js_whitespace(chars[k]) {
                k += 1;
            }
            let boundary_after = k + 1 >= chars.len() || !is_js_word(chars[k + 1]);
            if word_len >= 3
                && k > j
                && k < chars.len()
                && chars[k].is_ascii_lowercase()
                && boundary_after
            {
                out.extend_from_slice(&chars[word_start..j]);
                out.push(chars[k]);
                i = k + 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// TS `normalizeTextForOnlineTranslation`（onlineTranslate.ts:39-63）逐字移植。
pub fn normalize_text_for_online_translation(text: &str, source_language: &str) -> String {
    let mut normalized = add_space_after_punctuation(&remove_space_before_punctuation(
        &collapse_spaces_and_tabs(&text.replace("\r\n", "\n")),
    ));

    if source_language == "en-US" {
        for _ in 0..3 {
            let chars: Vec<char> = normalized.chars().collect();
            normalized = replace_word_single_lower_join(&replace_single_upper_join(&chars))
                .into_iter()
                .collect();
        }
    }

    normalized
        .split('\n')
        .map(trim_js_whitespace)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// TS `toOnlineLanguage`：在线端点使用的语言标识。未知 tag 原样透传（见模块注释）。
pub fn to_online_language(language: &str) -> &str {
    match language {
        "zh-CN" => "zh-CN",
        "zh-TW" => "zh-TW",
        "en-US" => "en",
        other => other,
    }
}

/// TS `parseGoogleTranslatedText`：`value[0]` 段落的 `segment[0]` 字符串串联
/// （非字符串段以空串占位）；整体 trim 后为空视为无文本。
pub fn parse_google_translated_text(value: &Value) -> Option<String> {
    let segments = value.as_array()?.first()?.as_array()?;
    let mut translated = String::new();
    for segment in segments {
        if let Some(text) = segment
            .as_array()
            .and_then(|entry| entry.first())
            .and_then(Value::as_str)
        {
            translated.push_str(text);
        }
    }
    let trimmed = translated.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// TS `parseMyMemoryTranslatedText`：`responseData.translatedText` 字符串 trim；
/// 缺失/类型不符 → None；trim 后为空串时由调用方按"无文本"处理（对齐 TS
/// 空串 falsy 语义）。
pub fn parse_my_memory_translated_text(value: &Value) -> Option<String> {
    let translated = value
        .get("responseData")
        .and_then(|data| data.get("translatedText"))
        .and_then(Value::as_str)?;
    Some(translated.trim().to_string())
}

/// TS `runOnlineTranslate` 的编排骨架（onlineTranslate.ts:205-288）。
///
/// `endpoint` 为 `Some` 时走 MyMemory 形状（`langpair` + `q`），`None` 时走
/// Google 默认端点（`client=gtx`、`dt=t`、`q`、`sl`、`tl`）——对齐 TS
/// `dependencies.endpoint ? translateWithMyMemory : translateWithGoogle`。
pub fn translate_text<F>(
    source_language: &str,
    target_language: &str,
    text: &str,
    endpoint: Option<&str>,
    fetch: F,
) -> TranslationOutcome
where
    F: FnOnce(TranslationHttpRequest) -> Result<String, TranslationHttpError>,
{
    let source_text = normalize_text_for_online_translation(text, source_language);

    if source_text.is_empty() {
        return unavailable_outcome(source_language, target_language, NO_OCR_TEXT_MESSAGE);
    }

    // TS 以 String.length（UTF-16 码元）计长，此处保持一致。
    if source_text.encode_utf16().count() > MAX_TRANSLATION_TEXT_LENGTH {
        return unavailable_outcome(
            source_language,
            target_language,
            &format!(
                "OCR text exceeds the {MAX_TRANSLATION_TEXT_LENGTH}-character online translation limit."
            ),
        );
    }

    let online_source = to_online_language(source_language);
    let online_target = to_online_language(target_language);

    if online_source == online_target {
        return success_outcome(
            source_language,
            target_language,
            source_text.clone(),
            source_text,
        );
    }

    let request = match endpoint {
        Some(url) => TranslationHttpRequest {
            url: url.to_string(),
            form: vec![
                (
                    "langpair".to_string(),
                    format!("{online_source}|{online_target}"),
                ),
                ("q".to_string(), source_text.clone()),
            ],
        },
        None => TranslationHttpRequest {
            url: GOOGLE_TRANSLATE_ENDPOINT.to_string(),
            form: vec![
                ("client".to_string(), "gtx".to_string()),
                ("dt".to_string(), "t".to_string()),
                ("q".to_string(), source_text.clone()),
                ("sl".to_string(), online_source.to_string()),
                ("tl".to_string(), online_target.to_string()),
            ],
        },
    };

    let body = match fetch(request) {
        Ok(body) => body,
        Err(error) => {
            let message = match error {
                TranslationHttpError::Timeout => "Online translation timed out.".to_string(),
                TranslationHttpError::Status(status) => {
                    format!("Online translation failed with HTTP {status}.")
                }
                TranslationHttpError::Network(message) if message.is_empty() => {
                    TRANSLATION_FAILED_MESSAGE.to_string()
                }
                TranslationHttpError::Network(message) => message,
            };
            return error_outcome(source_language, target_language, message);
        }
    };

    let parsed = match serde_json::from_str::<Value>(&body) {
        Ok(parsed) => parsed,
        // TS `response.json()` 的解析失败同样以 reason.message 进入 error 分支。
        Err(error) => return error_outcome(source_language, target_language, error.to_string()),
    };

    let translated_text = match endpoint {
        Some(_) => parse_my_memory_translated_text(&parsed).filter(|text| !text.is_empty()),
        None => parse_google_translated_text(&parsed),
    };

    match translated_text {
        Some(translated_text) => success_outcome(
            source_language,
            target_language,
            source_text,
            translated_text,
        ),
        None => error_outcome(
            source_language,
            target_language,
            NO_TRANSLATED_TEXT_MESSAGE.to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn outcome(
        status: TranslationStatus,
        ocr_language: &str,
        target_language: &str,
        source_text: Option<&str>,
        translated_text: Option<&str>,
        message: Option<&str>,
    ) -> TranslationOutcome {
        TranslationOutcome {
            status,
            ocr_language: ocr_language.to_string(),
            target_language: target_language.to_string(),
            source_text: source_text.map(str::to_string),
            translated_text: translated_text.map(str::to_string),
            message: message.map(str::to_string),
        }
    }

    fn panic_fetch(_: TranslationHttpRequest) -> Result<String, TranslationHttpError> {
        panic!("fetch must not be called");
    }

    #[test]
    fn normalizes_english_ocr_split_word_artifacts() {
        // TS onlineTranslate.test.ts 首个用例。
        assert_eq!(
            normalize_text_for_online_translation(
                "U pdates about Google N ews, organizing what's happening in the worl d tO help you",
                "en-US",
            ),
            "Updates about Google News, organizing what's happening in the world tO help you",
        );
    }

    #[test]
    fn skips_letter_joining_for_non_english_sources() {
        assert_eq!(
            normalize_text_for_online_translation(
                "U pdates about Google N ews, organizing what's happening in the worl d tO help you",
                "zh-CN",
            ),
            "U pdates about Google N ews, organizing what's happening in the worl d tO help you",
        );
    }

    #[test]
    fn normalizes_line_endings_tabs_and_punctuation_spacing() {
        assert_eq!(
            normalize_text_for_online_translation("a  b\r\nc\td e", "zh-CN"),
            "a b\nc d e",
        );
        assert_eq!(
            normalize_text_for_online_translation("hello ,world.there:ok", "zh-CN"),
            "hello, world. there: ok",
        );
        // \r\n 仅整体替换；孤立 \r 不处理（与 TS 一致）。
        assert_eq!(
            normalize_text_for_online_translation("a\rb", "zh-CN"),
            "a\rb"
        );
    }

    #[test]
    fn trims_lines_and_drops_empty_lines() {
        assert_eq!(
            normalize_text_for_online_translation("  first \n\n\tsecond  ", "zh-CN"),
            "first\nsecond",
        );
        assert_eq!(
            normalize_text_for_online_translation(" \t \n ", "zh-CN"),
            ""
        );
    }

    #[test]
    fn keeps_real_single_letter_words_when_joining() {
        // A 与 I 被排除在 [B-HJ-Z] 之外（本身是英文单词）。
        assert_eq!(
            normalize_text_for_online_translation("A ndroid I s", "en-US"),
            "A ndroid I s",
        );
        // 非单词边界（前一字是 \w）不触发粘连。
        assert_eq!(
            normalize_text_for_online_translation("MCU pdates", "en-US"),
            "MCU pdates",
        );
    }

    #[test]
    fn applies_joining_rules_across_multiple_rounds() {
        // 第二轮才能闭合的断词（首字母粘上后形成 3+ 字母词供规则 B 使用）。
        assert_eq!(
            normalize_text_for_online_translation("Th is worl d", "en-US"),
            "Th is world",
        );
    }

    #[test]
    fn maps_online_languages() {
        assert_eq!(to_online_language("zh-CN"), "zh-CN");
        assert_eq!(to_online_language("zh-TW"), "zh-TW");
        assert_eq!(to_online_language("en-US"), "en");
    }

    #[test]
    fn parses_google_translated_text() {
        let valid = serde_json::json!([
            [["有关 Google 新闻的更新", "Updates about Google News"]],
            null,
            "en",
        ]);
        assert_eq!(
            parse_google_translated_text(&valid).as_deref(),
            Some("有关 Google 新闻的更新"),
        );
        // 非字符串 segment 以空串占位，串联后 trim。
        let mixed = serde_json::json!([[["ab", 1], [null], ["cd"]]]);
        assert_eq!(
            parse_google_translated_text(&mixed).as_deref(),
            Some("abcd")
        );
        // 畸形变体。
        assert_eq!(parse_google_translated_text(&serde_json::json!(null)), None);
        assert_eq!(parse_google_translated_text(&serde_json::json!({})), None);
        assert_eq!(parse_google_translated_text(&serde_json::json!([])), None);
        assert_eq!(
            parse_google_translated_text(&serde_json::json!(["not-array"])),
            None,
        );
        // 全空结果 → None（"returned no text." 分支）。
        assert_eq!(
            parse_google_translated_text(&serde_json::json!([[[]]])),
            None
        );
        assert_eq!(
            parse_google_translated_text(&serde_json::json!([[["   "]]])),
            None,
        );
    }

    #[test]
    fn parses_my_memory_translated_text() {
        let valid = serde_json::json!({ "responseData": { "translatedText": "  你好  " } });
        assert_eq!(
            parse_my_memory_translated_text(&valid).as_deref(),
            Some("你好")
        );
        // 畸形变体。
        assert_eq!(
            parse_my_memory_translated_text(&serde_json::json!({})),
            None,
        );
        assert_eq!(
            parse_my_memory_translated_text(&serde_json::json!({
                "responseData": { "translatedText": 42 },
            })),
            None,
        );
        assert_eq!(
            parse_my_memory_translated_text(&serde_json::json!({
                "responseData": "not-object",
            })),
            None,
        );
    }

    #[test]
    fn returns_unavailable_when_there_is_no_source_text() {
        let result = translate_text("en-US", "zh-CN", "   ", None, panic_fetch);
        assert_eq!(
            result,
            outcome(
                TranslationStatus::Unavailable,
                "en-US",
                "zh-CN",
                None,
                None,
                Some("No OCR text found."),
            ),
        );
    }

    #[test]
    fn rejects_text_beyond_the_online_translation_size_limit() {
        let result = translate_text("en-US", "zh-CN", &"x".repeat(2_001), None, panic_fetch);
        assert_eq!(
            result,
            outcome(
                TranslationStatus::Unavailable,
                "en-US",
                "zh-CN",
                None,
                None,
                Some("OCR text exceeds the 2000-character online translation limit."),
            ),
        );
        // 恰好 2000（UTF-16 码元）不超限：进入网络路径（fetch 返回畸形体 → error）。
        let result = translate_text("en-US", "zh-CN", &"x".repeat(2_000), None, |_| {
            Ok("not json".to_string())
        });
        assert_eq!(result.status, TranslationStatus::Error);
    }

    #[test]
    fn counts_the_limit_in_utf16_units_like_js() {
        // 两个代理对字符（各计 2 个 UTF-16 码元）：1500 字符 → 3000 码元，超限。
        let emoji = "😀".repeat(1_500);
        let result = translate_text("en-US", "zh-CN", &emoji, None, panic_fetch);
        assert_eq!(
            result.message.as_deref(),
            Some("OCR text exceeds the 2000-character online translation limit."),
        );
    }

    #[test]
    fn short_circuits_same_language_with_source_echo() {
        // normalize（双空格折叠）先于短路，sourceText 是整形后的文本。
        let result = translate_text("en-US", "en-US", "hello  world", None, panic_fetch);
        assert_eq!(
            result,
            outcome(
                TranslationStatus::Success,
                "en-US",
                "en-US",
                Some("hello world"),
                Some("hello world"),
                None,
            ),
        );
        // 映射后同语言也算：zh-CN → zh-CN。
        let result = translate_text("zh-CN", "zh-CN", "你好", None, panic_fetch);
        assert_eq!(result.status, TranslationStatus::Success);
        assert_eq!(result.translated_text.as_deref(), Some("你好"));
    }

    #[test]
    fn uses_google_by_default_with_expected_request_shape() {
        let captured = Cell::new(None::<(String, Vec<(String, String)>)>);
        let result = {
            let captured = &captured;
            translate_text(
                "en-US",
                "zh-CN",
                "Updates about Google News",
                None,
                |request| {
                    captured.set(Some((request.url.clone(), request.form.clone())));
                    Ok(serde_json::json!([[[
                        "有关 Google 新闻的更新",
                        "Updates about Google News"
                    ]]])
                    .to_string())
                },
            )
        };
        let (url, form) = captured.take().expect("fetch should capture the request");
        assert_eq!(url, GOOGLE_TRANSLATE_ENDPOINT);
        assert_eq!(
            form,
            vec![
                ("client".to_string(), "gtx".to_string()),
                ("dt".to_string(), "t".to_string()),
                ("q".to_string(), "Updates about Google News".to_string()),
                ("sl".to_string(), "en".to_string()),
                ("tl".to_string(), "zh-CN".to_string()),
            ],
        );
        assert_eq!(
            result,
            outcome(
                TranslationStatus::Success,
                "en-US",
                "zh-CN",
                Some("Updates about Google News"),
                Some("有关 Google 新闻的更新"),
                None,
            ),
        );
    }

    #[test]
    fn uses_my_memory_when_custom_endpoint_is_given() {
        let captured = Cell::new(None::<(String, Vec<(String, String)>)>);
        let result = {
            let captured = &captured;
            translate_text(
                "en-US",
                "zh-CN",
                "hello",
                Some("https://example.test/translate"),
                |request| {
                    captured.set(Some((request.url.clone(), request.form.clone())));
                    Ok(
                        serde_json::json!({ "responseData": { "translatedText": "你好" } })
                            .to_string(),
                    )
                },
            )
        };
        let (url, form) = captured.take().expect("fetch should capture the request");
        assert_eq!(url, "https://example.test/translate");
        assert_eq!(
            form,
            vec![
                ("langpair".to_string(), "en|zh-CN".to_string()),
                ("q".to_string(), "hello".to_string()),
            ],
        );
        assert_eq!(
            result,
            outcome(
                TranslationStatus::Success,
                "en-US",
                "zh-CN",
                Some("hello"),
                Some("你好"),
                None,
            ),
        );
    }

    #[test]
    fn maps_http_status_failures_to_error_results() {
        let result = translate_text("en-US", "zh-CN", "hello", None, |_| {
            Err(TranslationHttpError::Status(503))
        });
        assert_eq!(
            result,
            outcome(
                TranslationStatus::Error,
                "en-US",
                "zh-CN",
                None,
                None,
                Some("Online translation failed with HTTP 503."),
            ),
        );
    }

    #[test]
    fn maps_timeouts_to_error_results() {
        let result = translate_text("en-US", "zh-CN", "hello", None, |_| {
            Err(TranslationHttpError::Timeout)
        });
        assert_eq!(
            result.message.as_deref(),
            Some("Online translation timed out."),
        );
        assert_eq!(result.status, TranslationStatus::Error);
    }

    #[test]
    fn maps_network_failures_to_error_results() {
        let result = translate_text("en-US", "zh-CN", "hello", None, |_| {
            Err(TranslationHttpError::Network(
                "connection refused".to_string(),
            ))
        });
        assert_eq!(result.message.as_deref(), Some("connection refused"));
        assert_eq!(result.status, TranslationStatus::Error);
    }

    #[test]
    fn maps_malformed_json_to_error_results() {
        let result = translate_text("en-US", "zh-CN", "hello", None, |_| {
            Ok("not json".to_string())
        });
        assert_eq!(result.status, TranslationStatus::Error);
        assert!(result.message.as_deref().is_some_and(|m| !m.is_empty()));
    }

    #[test]
    fn reports_no_text_for_valid_json_with_unexpected_shape() {
        let result = translate_text("en-US", "zh-CN", "hello", None, |_| {
            Ok(serde_json::json!({}).to_string())
        });
        assert_eq!(
            result,
            outcome(
                TranslationStatus::Error,
                "en-US",
                "zh-CN",
                None,
                None,
                Some("Online translation returned no text."),
            ),
        );
        // MyMemory 空 trim 结果同样按"无文本"处理（TS 空串 falsy 语义）。
        let result = translate_text(
            "en-US",
            "zh-CN",
            "hello",
            Some("https://example.test/translate"),
            |_| Ok(serde_json::json!({ "responseData": { "translatedText": "   " } }).to_string()),
        );
        assert_eq!(
            result.message.as_deref(),
            Some("Online translation returned no text."),
        );
    }

    #[test]
    fn keeps_the_runtime_unavailable_message_for_the_ported_contract() {
        assert_eq!(
            ONLINE_TRANSLATION_UNAVAILABLE_MESSAGE,
            "Online translation is unavailable in this runtime.",
        );
    }
}
