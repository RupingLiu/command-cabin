//! dataUrl 形状助手：PNG / ico 字节 ↔ `data:image/...;base64,<...>`。
//!
//! MIME 规则对齐 TS `windowsAppUserModelIconResolver.ts`：`.ico` →
//! `image/x-icon`，其余 → `image/png`。

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

const DATA_URL_PREFIX: &str = "data:image/";
const BASE64_SEGMENT_MARKER: &str = ";base64,";
const PNG_MIME_TYPE: &str = "image/png";
const ICO_MIME_TYPE: &str = "image/x-icon";

/// 是否为图像 dataUrl（`data:image/` 前缀）。磁盘缓存只接受该形状的条目。
pub fn is_image_data_url(value: &str) -> bool {
    value.starts_with(DATA_URL_PREFIX)
}

/// PNG 字节 → `data:image/png;base64,<...>`。
pub fn png_bytes_to_data_url(bytes: &[u8]) -> String {
    icon_bytes_to_data_url(bytes, ".png")
}

/// 图标字节 → dataUrl。扩展名 `.ico`（大小写不敏感，允许省略前导点）→
/// `image/x-icon`，其余 → `image/png`。
pub fn icon_bytes_to_data_url(bytes: &[u8], extension: &str) -> String {
    let mime_type = mime_type_for_extension(extension);
    format!("data:{mime_type};base64,{}", STANDARD.encode(bytes))
}

/// 解析 `data:image/...;base64,<payload>` 为原始字节。
/// 非 `data:image/` 前缀、缺 base64 段或 base64 非法 → `None`。
pub fn data_url_to_bytes(data_url: &str) -> Option<Vec<u8>> {
    let rest = data_url.strip_prefix(DATA_URL_PREFIX)?;
    let payload = rest.split_once(BASE64_SEGMENT_MARKER)?.1;
    STANDARD.decode(payload).ok()
}

fn mime_type_for_extension(extension: &str) -> &'static str {
    let without_dot = extension.strip_prefix('.').unwrap_or(extension);
    if without_dot.eq_ignore_ascii_case("ico") {
        ICO_MIME_TYPE
    } else {
        PNG_MIME_TYPE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_bytes_round_trip_through_data_url() {
        let png = b"\x89PNG\r\n\x1a\nfake-image-bytes";
        let data_url = png_bytes_to_data_url(png);
        assert!(data_url.starts_with("data:image/png;base64,"));
        assert_eq!(
            data_url_to_bytes(&data_url).as_deref(),
            Some(png.as_slice())
        );
    }

    #[test]
    fn png_bytes_encode_expected_base64() {
        // base64("hello") = "aGVsbG8="
        assert_eq!(
            png_bytes_to_data_url(b"hello"),
            "data:image/png;base64,aGVsbG8="
        );
    }

    #[test]
    fn ico_extension_uses_x_icon_mime() {
        assert_eq!(
            icon_bytes_to_data_url(b"hello", ".ico"),
            "data:image/x-icon;base64,aGVsbG8="
        );
        assert_eq!(
            icon_bytes_to_data_url(b"hello", ".ICO"),
            "data:image/x-icon;base64,aGVsbG8="
        );
        // 省略前导点也按 ico 处理（宽于 TS 的 PowerShell `-eq '.ico'`，便于调用方）。
        assert_eq!(
            icon_bytes_to_data_url(b"hello", "ico"),
            "data:image/x-icon;base64,aGVsbG8="
        );
    }

    #[test]
    fn other_extensions_use_png_mime() {
        assert_eq!(
            icon_bytes_to_data_url(b"hello", ".png"),
            "data:image/png;base64,aGVsbG8="
        );
        assert_eq!(
            icon_bytes_to_data_url(b"hello", ""),
            "data:image/png;base64,aGVsbG8="
        );
    }

    #[test]
    fn data_url_to_bytes_rejects_non_image_prefixes() {
        assert_eq!(data_url_to_bytes("data:text/plain;base64,aGVsbG8="), None);
        assert_eq!(data_url_to_bytes("not-a-data-url"), None);
        assert_eq!(data_url_to_bytes(""), None);
    }

    #[test]
    fn data_url_to_bytes_rejects_missing_or_invalid_base64() {
        assert_eq!(data_url_to_bytes("data:image/png"), None);
        assert_eq!(
            data_url_to_bytes("data:image/png;base64,"),
            Some(Vec::new())
        );
        assert_eq!(data_url_to_bytes("data:image/png;base64,!!!!"), None);
    }

    #[test]
    fn is_image_data_url_matches_prefix_only() {
        assert!(is_image_data_url("data:image/png;base64,AAA"));
        assert!(is_image_data_url("data:image/x-icon;base64,AAA"));
        assert!(!is_image_data_url("data:text/plain;base64,AAA"));
        assert!(!is_image_data_url("https://example.com/icon.png"));
    }
}
