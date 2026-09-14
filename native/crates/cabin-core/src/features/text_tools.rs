//! 文本工具内置功能。移植自
//! `packages/built-in-plugins/text-tools/src/transforms.ts` 与
//! `packages/built-in-plugins/text-tools/src/index.ts`。
//!
//! 语义保真要点：
//! - 六种变换 `uppercase` / `lowercase` / `remove-blank-lines` / `format-json` /
//!   `url-encode` / `url-decode`，错误统一为 [`TextTransformError`]（message + kind 判别），
//!   消息前缀逐字对齐 TS：`Invalid JSON: {msg}`、`Invalid URL encoded text: {msg}`。
//! - format-json **先做无损数字校验**再格式化：
//!   [`assert_json_numbers_can_be_formatted_losslessly`] 移植 TS
//!   `assertJsonNumbersCanBeFormattedLosslessly` 状态机（`inString`/`escaped` 跟踪、
//!   粘性正则 `/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y` 的手写等价物），
//!   超出有限范围 / 整型非安全整数的错误消息逐字保留。
//!   随后 `serde_json::to_string_pretty`（默认 2 空格缩进）对齐
//!   `JSON.stringify(input, null, 2)`；serde_json 启用 `preserve_order`，
//!   使对象键保持解析插入序（JS 对象语义）。
//!   已知格式化差异（TS 测试未覆盖，留档）：
//!   - 整值浮点字面量（如 `2.0`、`1e2`）：JS 经 double 归一后输出 `2`、`100`，
//!     serde_json 保留浮点形态输出 `2.0`、`100.0`；
//!   - 超出 u64/i64 的浮点指数形式：JS 带 `+` 号（`1.23e+29`），serde_json 不带；
//!   - JSON 解析失败的错误详情文案（serde_json 的 line/column 提示 vs V8 的
//!     `Unexpected token ...`），前缀 `Invalid JSON: ` 一致。另注意粘性正则
//!     的回退匹配差异：JS 正则对 `9007199254740993.` 这类输入会回退匹配
//!     整数前缀从而先抛精度错误，手写等价物返回不匹配、校验跳过，最终由
//!     JSON 解析失败路径报错（错误细节不同、前缀一致；合法 JSON 数字恒定
//!     完整匹配，不受影响）。
//! - url-encode 等价 JS `encodeURIComponent`：未保留集合为
//!   `A-Za-z0-9-_.!~*'()`，其余按 UTF-8 字节输出大写 `%XX`。
//!   url-decode 等价 JS `decodeURIComponent`：`%XX` 解码后整段做 UTF-8 校验，
//!   非法 `%` 序列或非法 UTF-8 报 V8 同款文案 `URI malformed`（TS 测试
//!   `'%E0%A4%A'` 即此路径）。
//! - uppercase/lowercase 使用 Rust `str::to_uppercase`/`to_lowercase`（Unicode
//!   全大小写映射，含 ß→SS、İ→i̇ 等特殊情形，与 JS 一致）；已知的边缘差异：
//!   JS `toLowerCase` 的 Final_Sigma 上下文规则与 Rust `str::to_lowercase`
//!   的实现均遵循 Unicode SpecialCasing，个别版本表可能有差异。TS 测试用例
//!   全 ASCII，无实际分歧。
//! - remove-blank-lines：按 `/\r\n|\r|\n/` 切行、`trim()` 非空过滤、`\n` 连接。
//!   `trim()`/`\s` 采用 ECMAScript 字符集（与 features::calculator 的
//!   `is_js_whitespace` 相同集合；跨模块不互引，各持私有副本）。
//! - 命令入口（index.ts 移植）：六个静态插件命令，id 形如
//!   `text-tools.uppercase`，action 为 `run-system` + payload `{ command: id }`。
//!   TS 侧剪贴板读取/回写在 launcher 服务执行层完成（插件模块本身不碰剪贴板），
//!   native 侧同样保持本模块无剪贴板依赖，由桌面接线层（对应 Task 7）注入。

use crate::command::types::{
    Command, CommandAction, CommandActionType, CommandPayload, CommandSource,
};
use serde_json::Value;
use thiserror::Error;

/// TS `TextTransformKind`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TextTransformKind {
    Uppercase,
    Lowercase,
    RemoveBlankLines,
    FormatJson,
    UrlEncode,
    UrlDecode,
}

impl TextTransformKind {
    /// TS 字面量（kebab-case）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Uppercase => "uppercase",
            Self::Lowercase => "lowercase",
            Self::RemoveBlankLines => "remove-blank-lines",
            Self::FormatJson => "format-json",
            Self::UrlEncode => "url-encode",
            Self::UrlDecode => "url-decode",
        }
    }

    /// 从 TS 字面量解析；未知值返回 `None`。
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "uppercase" => Some(Self::Uppercase),
            "lowercase" => Some(Self::Lowercase),
            "remove-blank-lines" => Some(Self::RemoveBlankLines),
            "format-json" => Some(Self::FormatJson),
            "url-encode" => Some(Self::UrlEncode),
            "url-decode" => Some(Self::UrlDecode),
            _ => None,
        }
    }
}

/// TS `TextTransformError`：message（已含 `Invalid JSON: ` 等前缀）+ kind 判别。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct TextTransformError {
    message: String,
    pub kind: TextTransformKind,
}

impl TextTransformError {
    pub fn new(message: String, kind: TextTransformKind) -> Self {
        Self { message, kind }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

/// TS `applyTextTransform`。
pub fn apply_text_transform(
    kind: TextTransformKind,
    input: &str,
) -> Result<String, TextTransformError> {
    match kind {
        TextTransformKind::Uppercase => Ok(input.to_uppercase()),
        TextTransformKind::Lowercase => Ok(input.to_lowercase()),
        TextTransformKind::RemoveBlankLines => Ok(remove_blank_lines(input)),
        TextTransformKind::FormatJson => format_json(input),
        TextTransformKind::UrlEncode => Ok(url_encode(input)),
        TextTransformKind::UrlDecode => url_decode(input).map_err(|message| {
            TextTransformError::new(
                format!("Invalid URL encoded text: {message}"),
                TextTransformKind::UrlDecode,
            )
        }),
    }
}

/// TS `formatJson`：先无损校验数字，再按 2 空格缩进格式化。
pub fn format_json(input: &str) -> Result<String, TextTransformError> {
    let outcome = (|| -> Result<String, String> {
        assert_json_numbers_can_be_formatted_losslessly(input)?;
        serde_json::from_str::<Value>(input)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::to_string_pretty(&value).map_err(|error| error.to_string())
            })
    })();

    outcome.map_err(|message| {
        TextTransformError::new(
            format!("Invalid JSON: {message}"),
            TextTransformKind::FormatJson,
        )
    })
}

/// TS `removeBlankLines`：按 `/\r\n|\r|\n/` 切行，过滤 `trim()` 后为空的行，`\n` 连接。
pub fn remove_blank_lines(input: &str) -> String {
    split_js_lines(input)
        .into_iter()
        .filter(|line| !js_trim(line).is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `Number.MAX_SAFE_INTEGER`。
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// TS `assertJsonNumbersCanBeFormattedLosslessly` 状态机移植。
///
/// 字符串/转义跟踪 + 粘性正则 `JSON_NUMBER_PATTERN` 的手写等价物
/// （[`match_json_number`]）；数字字面量按最近 double 解析（与 JS `Number()`
/// 一致），非有限值 / 整型非安全整数时以逐字消息报错。
fn assert_json_numbers_can_be_formatted_losslessly(input: &str) -> Result<(), String> {
    let characters: Vec<char> = input.chars().collect();
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0usize;

    while index < characters.len() {
        let character = characters[index];

        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }

        if character == '"' {
            in_string = true;
            index += 1;
            continue;
        }

        // TS：`character !== '-' && (character < '0' || character > '9')` → continue。
        if character != '-' && !character.is_ascii_digit() {
            index += 1;
            continue;
        }

        // TS：`JSON_NUMBER_PATTERN.lastIndex = index; exec(input)`，无匹配则继续。
        let Some(end) = match_json_number(&characters, index) else {
            index += 1;
            continue;
        };

        let literal: String = characters[index..end].iter().collect();
        // 语法已由 match_json_number 保证为规范 JSON 数字；溢出解析为 inf
        // （与 JS `Number("1e400") === Infinity` 一致）。
        let value: f64 = literal.parse().unwrap_or(f64::NAN);

        if !value.is_finite() {
            return Err(format!(
                "JSON number is outside the supported finite range: {literal}"
            ));
        }

        // TS：`!literal.includes('.') && !/[eE]/u.test(literal) && !Number.isSafeInteger(value)`。
        if !literal.contains('.') && !literal.contains(['e', 'E']) && !is_safe_integer(value) {
            return Err(format!(
                "JSON integer cannot be formatted without precision loss: {literal}"
            ));
        }

        // TS：`index = JSON_NUMBER_PATTERN.lastIndex - 1`（循环尾再 +1）。
        index = end;
    }

    Ok(())
}

/// 等价粘性正则 `/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y` 自 `start` 起的
/// 一次匹配，返回匹配结束位置（字符索引）；不匹配返回 `None`。
fn match_json_number(characters: &[char], start: usize) -> Option<usize> {
    let mut index = start;

    if characters.get(index) == Some(&'-') {
        index += 1;
    }

    match characters.get(index) {
        Some('0') => index += 1,
        Some(digit) if digit.is_ascii_digit() => {
            while characters.get(index).is_some_and(|c| c.is_ascii_digit()) {
                index += 1;
            }
        }
        _ => return None,
    }

    if characters.get(index) == Some(&'.') {
        index += 1;
        if !characters.get(index).is_some_and(|c| c.is_ascii_digit()) {
            return None;
        }
        while characters.get(index).is_some_and(|c| c.is_ascii_digit()) {
            index += 1;
        }
    }

    if matches!(characters.get(index), Some('e') | Some('E')) {
        index += 1;
        if matches!(characters.get(index), Some('+') | Some('-')) {
            index += 1;
        }
        if !characters.get(index).is_some_and(|c| c.is_ascii_digit()) {
            return None;
        }
        while characters.get(index).is_some_and(|c| c.is_ascii_digit()) {
            index += 1;
        }
    }

    Some(index)
}

/// TS `Number.isSafeInteger`。
fn is_safe_integer(value: f64) -> bool {
    value.trunc() == value && value.abs() <= MAX_SAFE_INTEGER
}

/// 按 JS `/\r\n|\r|\n/` 切分（`\r\n` 视为单个分隔符）。
fn split_js_lines(input: &str) -> Vec<&str> {
    let bytes = input.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;

    while index < bytes.len() {
        match bytes[index] {
            b'\r' => {
                lines.push(&input[start..index]);
                if bytes.get(index + 1) == Some(&b'\n') {
                    index += 2;
                } else {
                    index += 1;
                }
                start = index;
            }
            b'\n' => {
                lines.push(&input[start..index]);
                index += 1;
                start = index;
            }
            _ => index += 1,
        }
    }

    lines.push(&input[start..]);
    lines
}

/// JS `encodeURIComponent`：未保留集合 `A-Za-z0-9-_.!~*'()`，其余按 UTF-8
/// 字节输出大写 `%XX`。
fn url_encode(input: &str) -> String {
    const HEX_DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(input.len());

    for &byte in input.as_bytes() {
        if is_url_unreserved(byte) {
            output.push(byte as char);
        } else {
            output.push('%');
            output.push(HEX_DIGITS[usize::from(byte >> 4)] as char);
            output.push(HEX_DIGITS[usize::from(byte & 0x0F)] as char);
        }
    }

    output
}

/// JS `encodeURIComponent` 的未保留集合。
fn is_url_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        )
}

/// V8 `decodeURIComponent` 非法序列的 URIError 文案。
const URI_MALFORMED: &str = "URI malformed";

/// JS `decodeURIComponent`：`%XX` 解码为字节流后整段做 UTF-8 校验；`%` 后不足
/// 两位十六进制、或字节流不是合法 UTF-8 时报 `URI malformed`（与 V8 一致）。
/// 未出现 `%` 的字符原样保留（包括 `+`，JS 亦不将 `+` 解码为空格）。
fn url_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            let Some(byte) = bytes
                .get(index + 1..index + 3)
                .and_then(|pair| parse_hex_byte(pair[0], pair[1]))
            else {
                return Err(URI_MALFORMED.to_string());
            };
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(decoded).map_err(|_| URI_MALFORMED.to_string())
}

fn parse_hex_byte(high: u8, low: u8) -> Option<u8> {
    let high = (high as char).to_digit(16)?;
    let low = (low as char).to_digit(16)?;
    Some((high * 16 + low) as u8)
}

/// ECMAScript WhiteSpace + LineTerminator（即 JS `/\s/` 与 `trim()` 的字符集；
/// 不含 `\u{0085}`、含 `\u{FEFF}`）。
fn is_js_whitespace(value: char) -> bool {
    matches!(
        value,
        ' ' | '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// TS `TEXT_TOOLS_PLUGIN_ID`。
pub const TEXT_TOOLS_PLUGIN_ID: &str = "text-tools";

/// TS `TEXT_TOOL_COMMAND_IDS`。
pub const TEXT_TOOL_UPPERCASE_COMMAND_ID: &str = "text-tools.uppercase";
/// TS `TEXT_TOOL_COMMAND_IDS.lowercase`。
pub const TEXT_TOOL_LOWERCASE_COMMAND_ID: &str = "text-tools.lowercase";
/// TS `TEXT_TOOL_COMMAND_IDS.removeBlankLines`。
pub const TEXT_TOOL_REMOVE_BLANK_LINES_COMMAND_ID: &str = "text-tools.remove-blank-lines";
/// TS `TEXT_TOOL_COMMAND_IDS.formatJson`。
pub const TEXT_TOOL_FORMAT_JSON_COMMAND_ID: &str = "text-tools.format-json";
/// TS `TEXT_TOOL_COMMAND_IDS.urlEncode`。
pub const TEXT_TOOL_URL_ENCODE_COMMAND_ID: &str = "text-tools.url-encode";
/// TS `TEXT_TOOL_COMMAND_IDS.urlDecode`。
pub const TEXT_TOOL_URL_DECODE_COMMAND_ID: &str = "text-tools.url-decode";

struct TextToolCommandDefinition {
    id: &'static str,
    keywords: &'static [&'static str],
    kind: TextTransformKind,
    subtitle: &'static str,
    title: &'static str,
}

/// TS `TEXT_TOOL_COMMAND_DEFINITIONS`（文案逐字）。
const TEXT_TOOL_COMMAND_DEFINITIONS: &[TextToolCommandDefinition] = &[
    TextToolCommandDefinition {
        id: TEXT_TOOL_UPPERCASE_COMMAND_ID,
        keywords: &["text", "uppercase", "case"],
        kind: TextTransformKind::Uppercase,
        subtitle: "Convert text to uppercase",
        title: "Text: Uppercase",
    },
    TextToolCommandDefinition {
        id: TEXT_TOOL_LOWERCASE_COMMAND_ID,
        keywords: &["text", "lowercase", "case"],
        kind: TextTransformKind::Lowercase,
        subtitle: "Convert text to lowercase",
        title: "Text: Lowercase",
    },
    TextToolCommandDefinition {
        id: TEXT_TOOL_REMOVE_BLANK_LINES_COMMAND_ID,
        keywords: &["text", "blank", "lines", "remove"],
        kind: TextTransformKind::RemoveBlankLines,
        subtitle: "Remove blank lines from text",
        title: "Text: Remove Blank Lines",
    },
    TextToolCommandDefinition {
        id: TEXT_TOOL_FORMAT_JSON_COMMAND_ID,
        keywords: &["text", "json", "format", "pretty"],
        kind: TextTransformKind::FormatJson,
        subtitle: "Format JSON with indentation",
        title: "Text: Format JSON",
    },
    TextToolCommandDefinition {
        id: TEXT_TOOL_URL_ENCODE_COMMAND_ID,
        keywords: &["text", "url", "encode", "uri"],
        kind: TextTransformKind::UrlEncode,
        subtitle: "URL encode text",
        title: "Text: URL Encode",
    },
    TextToolCommandDefinition {
        id: TEXT_TOOL_URL_DECODE_COMMAND_ID,
        keywords: &["text", "url", "decode", "uri"],
        kind: TextTransformKind::UrlDecode,
        subtitle: "URL decode text",
        title: "Text: URL Decode",
    },
];

/// TS `createTextToolCommands`：静态插件命令，action 为
/// `run-system` + payload `{ command: <命令 id> }`（剪贴板读写由执行层接线，
/// 与 TS 的 launcherCommandService 分工一致）。
pub fn create_text_tool_commands() -> Vec<Command> {
    TEXT_TOOL_COMMAND_DEFINITIONS
        .iter()
        .map(|definition| {
            let mut payload = CommandPayload::new();
            payload.insert("command".into(), Value::String(definition.id.to_string()));

            Command {
                id: definition.id.to_string(),
                source: CommandSource::Plugin,
                title: definition.title.to_string(),
                subtitle: Some(definition.subtitle.to_string()),
                keywords: definition
                    .keywords
                    .iter()
                    .map(|keyword| (*keyword).to_string())
                    .collect(),
                icon: None,
                plugin_id: Some(TEXT_TOOLS_PLUGIN_ID.to_string()),
                action: CommandAction {
                    action_type: CommandActionType::RunSystem,
                    payload,
                },
            }
        })
        .collect()
}

/// TS `getTextToolTransformKind`。
pub fn get_text_tool_transform_kind(command_id: &str) -> Option<TextTransformKind> {
    TEXT_TOOL_COMMAND_DEFINITIONS
        .iter()
        .find(|definition| definition.id == command_id)
        .map(|definition| definition.kind)
}

/// TS `isTextToolCommandId`。
pub fn is_text_tool_command_id(command_id: &str) -> bool {
    get_text_tool_transform_kind(command_id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transform(kind: TextTransformKind, input: &str) -> String {
        apply_text_transform(kind, input).expect("transform should succeed")
    }

    // ---- tests/unit/textTools.test.ts: "text tools transforms" ----

    #[test]
    fn converts_text_to_uppercase_and_lowercase() {
        assert_eq!(
            transform(TextTransformKind::Uppercase, "Command Cabin"),
            "COMMAND CABIN"
        );
        assert_eq!(
            transform(TextTransformKind::Lowercase, "Command Cabin"),
            "command cabin"
        );
    }

    #[test]
    fn removes_blank_lines_while_keeping_non_empty_lines() {
        assert_eq!(
            transform(
                TextTransformKind::RemoveBlankLines,
                "first\n\n  \nsecond\r\nthird"
            ),
            "first\nsecond\nthird"
        );
    }

    #[test]
    fn formats_json_with_stable_indentation_and_insertion_key_order() {
        // 键序对齐 JS 对象插入序（serde_json preserve_order）。
        assert_eq!(
            transform(
                TextTransformKind::FormatJson,
                "{\"name\":\"CommandCabin\",\"enabled\":true}"
            ),
            "{\n  \"name\": \"CommandCabin\",\n  \"enabled\": true\n}"
        );
    }

    #[test]
    fn encodes_and_decodes_url_text() {
        let encoded = transform(
            TextTransformKind::UrlEncode,
            "hello world?x=1&label=Command Cabin",
        );

        assert_eq!(encoded, "hello%20world%3Fx%3D1%26label%3DCommand%20Cabin");
        assert_eq!(
            transform(TextTransformKind::UrlDecode, &encoded),
            "hello world?x=1&label=Command Cabin"
        );
    }

    #[test]
    fn throws_clear_errors_for_invalid_json_and_malformed_url_encoding() {
        let json_error = apply_text_transform(TextTransformKind::FormatJson, "{bad json")
            .expect_err("invalid JSON should fail");
        assert!(json_error.message().contains("Invalid JSON"));
        assert_eq!(json_error.kind, TextTransformKind::FormatJson);

        let url_error = apply_text_transform(TextTransformKind::UrlDecode, "%E0%A4%A")
            .expect_err("malformed percent encoding should fail");
        assert!(url_error.message().contains("Invalid URL encoded text"));
        assert_eq!(url_error.kind, TextTransformKind::UrlDecode);
    }

    #[test]
    fn rejects_json_numbers_that_native_formatting_would_silently_change() {
        let precision_error =
            apply_text_transform(TextTransformKind::FormatJson, "{\"id\":9007199254740993}")
                .expect_err("unsafe integer should fail");
        assert!(
            precision_error.message().contains("precision loss"),
            "unexpected message: {precision_error}"
        );
        assert_eq!(
            precision_error.message(),
            "Invalid JSON: JSON integer cannot be formatted without precision loss: 9007199254740993"
        );

        let range_error = apply_text_transform(TextTransformKind::FormatJson, "{\"value\":1e400}")
            .expect_err("non-finite number should fail");
        assert!(
            range_error.message().contains("finite range"),
            "unexpected message: {range_error}"
        );
        assert_eq!(
            range_error.message(),
            "Invalid JSON: JSON number is outside the supported finite range: 1e400"
        );

        // 字符串里的同款数字不受影响。
        let formatted = transform(
            TextTransformKind::FormatJson,
            "{\"label\":\"9007199254740993\"}",
        );
        assert!(formatted.contains("9007199254740993"));
    }

    // ---- 状态机细节补充（字符串/转义跟踪、粘性正则边界） ----

    #[test]
    fn escaped_quotes_inside_strings_do_not_end_string_tracking() {
        // `\"` 不结束字符串：字符串中的大整数不触发，后续真实数字字面量触发。
        let error = apply_text_transform(
            TextTransformKind::FormatJson,
            "{\"a\":\"x\\\"9007199254740993\",\"b\":9007199254740993}",
        )
        .expect_err("escaped quote must keep string open");
        assert!(error.message().contains("9007199254740993"));
        assert!(error.message().contains("precision loss"));
    }

    #[test]
    fn lone_minus_is_not_a_number_match_and_reaches_parse_error() {
        // `-` 后非数字：粘性正则不匹配 → 校验跳过 → JSON 解析失败。
        let error = apply_text_transform(TextTransformKind::FormatJson, "{\"a\":-}")
            .expect_err("lone minus is invalid JSON");
        assert!(error.message().starts_with("Invalid JSON: "));
    }

    #[test]
    fn safe_integer_boundary_is_allowed() {
        assert_eq!(
            transform(TextTransformKind::FormatJson, "{\"id\":9007199254740991}"),
            "{\n  \"id\": 9007199254740991\n}"
        );
        // 负向边界同样允许。
        assert_eq!(
            transform(TextTransformKind::FormatJson, "{\"id\":-9007199254740991}"),
            "{\n  \"id\": -9007199254740991\n}"
        );
    }

    #[test]
    fn negative_unsafe_integer_is_rejected() {
        let error =
            apply_text_transform(TextTransformKind::FormatJson, "{\"id\":-9007199254740993}")
                .expect_err("negative unsafe integer should fail");
        assert_eq!(
            error.message(),
            "Invalid JSON: JSON integer cannot be formatted without precision loss: -9007199254740993"
        );
    }

    #[test]
    fn exponent_literals_skip_safe_integer_check() {
        // 带指数的字面量不做安全整数检查（TS `!/[eE]/u.test(literal)`）。
        assert!(apply_text_transform(TextTransformKind::FormatJson, "{\"id\":1e2}").is_ok());
    }

    #[test]
    fn integral_floats_format_like_rust_not_js_documented_divergence() {
        // 已记录差异：JS `JSON.stringify({"v":1e2})` 输出 `100`（double 归一），
        // serde_json 保留浮点形态输出 `100.0`。TS 测试未覆盖，此处锁定 native
        // 现状以便后续追踪。
        assert_eq!(
            transform(TextTransformKind::FormatJson, "{\"v\":1e2}"),
            "{\n  \"v\": 100.0\n}"
        );
    }

    // ---- URL 编解码细节 ----

    #[test]
    fn url_encode_keeps_unreserved_set() {
        // A-Za-z0-9-_.!~*'() 不编码。
        assert_eq!(
            transform(TextTransformKind::UrlEncode, "A-Za-z0-9-_.!~*'()"),
            "A-Za-z0-9-_.!~*'()"
        );
        assert_eq!(transform(TextTransformKind::UrlEncode, "+/="), "%2B%2F%3D");
        assert_eq!(transform(TextTransformKind::UrlEncode, "中"), "%E4%B8%AD");
    }

    #[test]
    fn url_decode_keeps_plus_and_rejects_bad_percent_sequences() {
        assert_eq!(transform(TextTransformKind::UrlDecode, "a+b"), "a+b");
        for malformed in ["%", "%1", "%G1", "%E4%B8"] {
            let error = apply_text_transform(TextTransformKind::UrlDecode, malformed)
                .expect_err("malformed sequence should fail");
            assert_eq!(error.message(), "Invalid URL encoded text: URI malformed");
        }
    }

    #[test]
    fn url_decode_rejects_invalid_utf8_byte_sequences() {
        // %80 为裸续字节 → 非法 UTF-8。
        let error = apply_text_transform(TextTransformKind::UrlDecode, "%80")
            .expect_err("bare continuation byte should fail");
        assert_eq!(error.message(), "Invalid URL encoded text: URI malformed");
        assert_eq!(transform(TextTransformKind::UrlDecode, "中"), "中");
        assert_eq!(transform(TextTransformKind::UrlDecode, "%E4%B8%AD"), "中");
    }

    // ---- 命令入口（index.ts 移植） ----

    #[test]
    fn creates_static_plugin_commands_for_each_transform() {
        let commands = create_text_tool_commands();

        let expected: Vec<(&str, TextTransformKind, &str)> = vec![
            (
                TEXT_TOOL_UPPERCASE_COMMAND_ID,
                TextTransformKind::Uppercase,
                "Text: Uppercase",
            ),
            (
                TEXT_TOOL_LOWERCASE_COMMAND_ID,
                TextTransformKind::Lowercase,
                "Text: Lowercase",
            ),
            (
                TEXT_TOOL_REMOVE_BLANK_LINES_COMMAND_ID,
                TextTransformKind::RemoveBlankLines,
                "Text: Remove Blank Lines",
            ),
            (
                TEXT_TOOL_FORMAT_JSON_COMMAND_ID,
                TextTransformKind::FormatJson,
                "Text: Format JSON",
            ),
            (
                TEXT_TOOL_URL_ENCODE_COMMAND_ID,
                TextTransformKind::UrlEncode,
                "Text: URL Encode",
            ),
            (
                TEXT_TOOL_URL_DECODE_COMMAND_ID,
                TextTransformKind::UrlDecode,
                "Text: URL Decode",
            ),
        ];

        assert_eq!(commands.len(), expected.len());
        for (command, (id, kind, title)) in commands.iter().zip(expected) {
            assert_eq!(command.id, id);
            assert_eq!(command.source, CommandSource::Plugin);
            assert_eq!(command.title, title);
            assert_eq!(command.plugin_id.as_deref(), Some(TEXT_TOOLS_PLUGIN_ID));
            assert_eq!(command.action.action_type, CommandActionType::RunSystem);
            assert_eq!(
                command
                    .action
                    .payload
                    .get("command")
                    .and_then(Value::as_str),
                Some(id)
            );
            assert_eq!(get_text_tool_transform_kind(id), Some(kind));
            assert!(is_text_tool_command_id(id));
        }

        // keywords 抽查（对齐 TS 测试的 arrayContaining 断言）。
        assert_eq!(commands[0].keywords, vec!["text", "uppercase", "case"]);
        assert_eq!(
            commands[2].keywords,
            vec!["text", "blank", "lines", "remove"]
        );
    }

    #[test]
    fn unknown_command_ids_are_not_text_tool_commands() {
        assert_eq!(get_text_tool_transform_kind("calculator.result"), None);
        assert!(!is_text_tool_command_id("text-tools"));
        assert!(!is_text_tool_command_id(""));
    }

    #[test]
    fn transform_kind_literals_round_trip() {
        for kind in [
            TextTransformKind::Uppercase,
            TextTransformKind::Lowercase,
            TextTransformKind::RemoveBlankLines,
            TextTransformKind::FormatJson,
            TextTransformKind::UrlEncode,
            TextTransformKind::UrlDecode,
        ] {
            assert_eq!(TextTransformKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(TextTransformKind::parse("UPPERCASE"), None);
    }
}
