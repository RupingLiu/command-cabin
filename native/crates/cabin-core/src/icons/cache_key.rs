//! 结果级图标缓存键。移植自 `apps/desktop/src/main/icons/appIconResolver.ts`
//! 的 `createResultIconCacheKey`。
//!
//! 形状：`<RESULT_ICON_CACHE_VERSION>:<result_id>:<sha256(json).hex 前 16 位>`，
//! 其中 json 为 compact 序列化的候选数组；候选为空/缺省时回退到
//! `[icon, subtitle]`（`None` 序列化为 `null`，对齐 `JSON.stringify` 的
//! `undefined → null` 语义）。

use std::fmt::Write as _;

use sha2::{Digest, Sha256};

use super::{RESULT_ICON_CACHE_HASH_LENGTH, RESULT_ICON_CACHE_VERSION};

/// 构造结果级图标缓存键。`candidates` 为 `Some` 且非空时使用之；否则回退
/// `[icon, subtitle]`（`None` → JSON `null`）。
pub fn result_icon_cache_key(
    result_id: &str,
    candidates: Option<&[String]>,
    icon: Option<&str>,
    subtitle: Option<&str>,
) -> String {
    let fingerprint_source: Vec<Option<String>> = match candidates {
        Some(list) if !list.is_empty() => list.iter().map(|item| Some(item.clone())).collect(),
        _ => vec![icon.map(str::to_string), subtitle.map(str::to_string)],
    };
    let json = serde_json::to_string(&fingerprint_source).unwrap_or_else(|_| "[]".to_string());
    format!(
        "{RESULT_ICON_CACHE_VERSION}:{result_id}:{}",
        sha256_hex_prefix(json.as_bytes())
    )
}

fn sha256_hex_prefix(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    let end = RESULT_ICON_CACHE_HASH_LENGTH.min(hex.len());
    hex[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable_for_known_candidates() {
        // sha256(`["a","b"]`) = 0473ef2dc0d324ab...（作者期用 sha256sum 校验）
        let candidates = vec!["a".to_string(), "b".to_string()];
        let key = result_icon_cache_key("result-1", Some(&candidates), None, None);
        assert_eq!(key, "app-result-v6:result-1:0473ef2dc0d324ab");
    }

    #[test]
    fn key_falls_back_to_icon_and_subtitle() {
        // sha256(`["icon.png","Sub"]`) = ef3183c600413c07...
        let key = result_icon_cache_key("result-1", None, Some("icon.png"), Some("Sub"));
        assert_eq!(key, "app-result-v6:result-1:ef3183c600413c07");
        // 空候选数组同样走回退（对齐 TS `iconCandidates.length > 0` 判定）。
        let empty: Vec<String> = Vec::new();
        assert_eq!(
            result_icon_cache_key("result-1", Some(&empty), Some("icon.png"), Some("Sub")),
            "app-result-v6:result-1:ef3183c600413c07"
        );
    }

    #[test]
    fn key_serializes_missing_parts_as_null() {
        // sha256(`[null,null]`) = 95cb9b4f84ceff13...
        assert_eq!(
            result_icon_cache_key("r", None, None, None),
            "app-result-v6:r:95cb9b4f84ceff13"
        );
        // sha256(`[null,"Sub"]`) = e2bfa6c97bdd3a0c...
        assert_eq!(
            result_icon_cache_key("r", None, None, Some("Sub")),
            "app-result-v6:r:e2bfa6c97bdd3a0c"
        );
    }

    #[test]
    fn different_result_ids_produce_different_keys() {
        let candidates = vec!["a".to_string()];
        assert_ne!(
            result_icon_cache_key("r1", Some(&candidates), None, None),
            result_icon_cache_key("r2", Some(&candidates), None, None)
        );
    }

    /// UI 修复 4：v4 → v5（提取尺寸）；UI 修复 8：v5 → v6（alpha 管线修复）。旧键与新键必然
    /// 不同（前缀参与键构造），磁盘缓存中遗留的 v4 条目因此永远命不中，随
    /// 256 条目上限自然逐出——本测试钉住该失效语义。
    #[test]
    fn version_bump_invalidates_v4_keys() {
        let candidates = vec!["a".to_string(), "b".to_string()];
        let key = result_icon_cache_key("result-1", Some(&candidates), None, None);
        assert!(key.starts_with(RESULT_ICON_CACHE_VERSION));
        assert_eq!(RESULT_ICON_CACHE_VERSION, "app-result-v6");
        // 相同 result_id 与候选的 v4 键（历史条目）与新键不同 → 不可再命中。
        let legacy_v4_key = key.replacen(RESULT_ICON_CACHE_VERSION, "app-result-v4", 1);
        assert_ne!(key, legacy_v4_key);
    }

    #[test]
    fn fingerprint_is_sixteen_lowercase_hex_chars() {
        let key = result_icon_cache_key("r", None, None, None);
        let fingerprint = key.split(':').next_back().unwrap();
        assert_eq!(fingerprint.len(), RESULT_ICON_CACHE_HASH_LENGTH);
        assert!(fingerprint
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn sha256_hex_prefix_matches_known_vector() {
        assert_eq!(
            sha256_hex_prefix(b"abc").len(),
            RESULT_ICON_CACHE_HASH_LENGTH
        );
        // sha256("abc") = ba7816bf8f01cfea...
        assert_eq!(sha256_hex_prefix(b"abc"), "ba7816bf8f01cfea");
    }
}
