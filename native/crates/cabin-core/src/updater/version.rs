//! 更新版本号解析与比较（semver 的 主.次.补丁 严格子集）。
//!
//! **与 TS 更新器的语义对齐（M5 Task 1 调研结论）**：TS 侧
//! `updateController.ts` 自身从不比较版本——比较发生在 electron-updater 内部
//! （完整 semver，含预发布标签语义）；应用未配置 `allowPrerelease` / 更新
//! channel（`release/latest.yml` 与发布产物均为纯 stable），预发布语义实际
//! 未被使用。因此本模块只移植 主.次.补丁 数值比较并**文档化**：
//! - 预发布标签（如 `1.2.3-beta.1`）不被解析——严格拒绝（`parse_version`
//!   只接受纯数字三元组）。GitHub `releases/latest` 端点本身永不返回
//!   draft / prerelease，stable-only 语义与端点行为一致；
//! - 标签前导 `v` 的剥离是 GitHub tag 整形（见 super
//!   [`super::strip_release_tag`]），不属于版本解析；
//! - 严格规则：恰好 3 段、每段非空纯 ASCII 数字、禁前导零（`0` 本身除外）、
//!   每段可容纳于 `u64`；不 trim、不接受 `+`/空白（`"+1".parse::<u64>()`
//!   在 Rust 中合法，故先做字符白名单）。

use std::cmp::Ordering;

use thiserror::Error;

/// 版本解析失败（消息含原始输入，供手动检查的可读错误直出）。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("invalid version {0:?}: expected \"major.minor.patch\" (numeric components, no leading zeros, no prerelease label)")]
pub struct VersionParseError(pub String);

/// `CARGO_PKG_VERSION` 形态（`"1.2.3"`）→ `(major, minor, patch)`。严格解析，
/// 见模块注释；任何非法形态 → [`VersionParseError`]。
pub fn parse_version(text: &str) -> Result<(u64, u64, u64), VersionParseError> {
    let fail = || VersionParseError(text.to_string());
    let Ok(parts) = <[&str; 3]>::try_from(text.split('.').collect::<Vec<&str>>()) else {
        return Err(fail());
    };
    let mut values = [0u64; 3];
    for (index, part) in parts.iter().enumerate() {
        values[index] = component_value(part).ok_or_else(fail)?;
    }
    Ok((values[0], values[1], values[2]))
}

/// 单段解析：非空、全 ASCII 数字、无前导零（"0" 本身除外）、容纳于 u64。
fn component_value(part: &str) -> Option<u64> {
    let bytes = part.as_bytes();
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    part.parse().ok()
}

/// semver 主.次.补丁 数值比较：`a` 新于 `b` → `Greater`。
pub fn compare(a: (u64, u64, u64), b: (u64, u64, u64)) -> Ordering {
    a.cmp(&b)
}

/// 字符串便捷比较（两侧均须为合法版本串）。
pub fn compare_versions(a: &str, b: &str) -> Result<Ordering, VersionParseError> {
    Ok(compare(parse_version(a)?, parse_version(b)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_triples() {
        assert_eq!(parse_version("0.0.0"), Ok((0, 0, 0)));
        assert_eq!(parse_version("1.2.3"), Ok((1, 2, 3)));
        assert_eq!(parse_version("1.0.0"), Ok((1, 0, 0)));
        assert_eq!(
            parse_version("18446744073709551615.0.0"),
            Ok((u64::MAX, 0, 0))
        );
    }

    #[test]
    fn rejects_malformed_versions() {
        // 段数不对 / 空串 / 空白 / 非 JSON-PKG 形态。
        for invalid in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            ".1.2",
            "1..2",
            "1.2.",
            "v1.2.3",
            " 1.2.3",
            "1.2.3 ",
            "1 .2.3",
            "1.2.x",
            "01.2.3",
            "1.02.3",
            "1.2.03",
            "+1.2.3",
            "-1.2.3",
            "1.2.3-beta.1",
            "1.2.3-beta",
            "nightly",
            "99999999999999999999.0.0",
        ] {
            assert_eq!(
                parse_version(invalid),
                Err(VersionParseError(invalid.to_string())),
                "expected rejection for {invalid:?}"
            );
        }
    }

    #[test]
    fn error_message_names_the_offending_input() {
        let error = parse_version("1.2").unwrap_err();
        assert_eq!(
            error.to_string(),
            "invalid version \"1.2\": expected \"major.minor.patch\" (numeric components, no leading zeros, no prerelease label)"
        );
    }

    #[test]
    fn compares_by_major_minor_patch() {
        use Ordering::{Equal, Greater, Less};
        assert_eq!(compare((1, 2, 3), (1, 2, 3)), Equal);
        assert_eq!(compare((1, 2, 4), (1, 2, 3)), Greater);
        assert_eq!(compare((1, 2, 3), (1, 2, 4)), Less);
        assert_eq!(compare((1, 3, 0), (1, 2, 9)), Greater);
        assert_eq!(compare((1, 2, 9), (1, 3, 0)), Less);
        assert_eq!(compare((2, 0, 0), (1, 9, 9)), Greater);
        assert_eq!(compare((1, 9, 9), (2, 0, 0)), Less);
        assert_eq!(compare((0, 0, 0), (0, 0, 0)), Equal);
    }

    #[test]
    fn compare_versions_takes_strings_and_propagates_parse_errors() {
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Ok(Ordering::Equal));
        assert_eq!(compare_versions("1.0.1", "1.0.0"), Ok(Ordering::Greater));
        assert_eq!(compare_versions("0.9.0", "1.0.0"), Ok(Ordering::Less));
        assert_eq!(
            compare_versions("1.0", "1.0.0"),
            Err(VersionParseError("1.0".to_string()))
        );
        assert_eq!(
            compare_versions("1.0.0", "v1.0.0"),
            Err(VersionParseError("v1.0.0".to_string()))
        );
    }
}
