//! 自更新领域类型与 GitHub Releases 响应解析（纯逻辑，无 IO）。
//!
//! **分界约定（M4 确立的 core/platform 拆分）**：类型整形与严格解析归本模块
//! （cabin-core::updater），HTTP/文件 IO 归 cabin-platform-windows
//! `updater`；[`crate::indexer::IndexScanResult`] 同款——平台 trait 的参数
//! 类型直接取用核心类型，单一事实来源。
//!
//! 端点与协议（GitHub Releases API）：
//! - `GET https://api.github.com/repos/RupingLiu/command-cabin/releases/latest`
//!   （owner/repo 取自仓库 git remote，见任务报告）。该端点只返回最新
//!   **正式发布**（不含 draft / prerelease），stable-only 语义见
//!   [`version`] 模块注释；
//! - GitHub API 要求 `User-Agent`（缺省 403）——
//!   [`GITHUB_API_USER_AGENT`] = `"CommandCabin-Updater"`；
//!   `Accept: application/vnd.github+json`（API v4 媒体类型）；
//! - 响应只取 `tag_name`（剥前导 `v` → 版本）、`assets[]`（`name` /
//!   `browser_download_url` / `size`）与 `body`（→ 变更说明）；其余字段
//!   忽略。**严格解析**：必填字段缺失 / 类型不符 / 形状非法 →
//!   [`ReleaseParseError`]（手动检查须给出可读错误，静默吞掉畸形响应会
//!   掩盖协议漂移）。
//!
//! 发布资产命名约定（对齐 M5 Task 4 安装包产物）：
//! - 安装包 `CommandCabin-Setup-{version}.exe`（[`installer_asset_name`]，
//!   version 为剥 v 后的三元组串，如 `1.0.0`）；
//! - 校验边车 `<安装包名>.sha512`（[`SHA512_SIDECAR_SUFFIX`]），内容为
//!   **标准 sha512sum 文本格式**：`<128 位十六进制>␠␠<文件名>`（两空格；
//!   二进制指示符 `␠*` 亦接受），见 [`parse_sha512_sidecar`]。**本约定与
//!   electron-updater 的 latest.yml（base64 内嵌）不同**——native 版协议
//!   自洽，选用 sha512sum 事实标准文本格式，发布侧 `sha512sum file >
//!   file.sha512` 即可产出（Task 4 构建脚本逐字该命令）；
//! - 下载侧的边车 URL = 资产 URL + `.sha512`（GitHub
//!   browser_download_url 的最后一段即资产名，追加后缀即边车资产直链）。
//!
//! **安全红线**：发布资产必须携带 `.sha512` 边车；客户端缺边车（HTTP 404
//! 或格式非法）时必须拒绝安装——宁可拒绝升级，绝不执行未校验的下载物
//! （实现在平台层 `updater`，本模块提供其解析半步）。

pub mod version;

pub use version::{compare, compare_versions, parse_version, VersionParseError};

use std::cmp::Ordering;

use thiserror::Error;

/// GitHub Releases `latest` 端点（owner=RupingLiu, repo=command-cabin，
/// 来自仓库 git remote）。
pub const GITHUB_RELEASES_LATEST_ENDPOINT: &str =
    "https://api.github.com/repos/RupingLiu/command-cabin/releases/latest";
/// GitHub API 要求的 User-Agent（缺省请求被 403 拒绝）。
pub const GITHUB_API_USER_AGENT: &str = "CommandCabin-Updater";
/// GitHub API v4 媒体类型。
pub const GITHUB_API_ACCEPT: &str = "application/vnd.github+json";
/// 安装包资产名前缀（`CommandCabin-Setup-{version}.exe`）。
pub const INSTALLER_ASSET_PREFIX: &str = "CommandCabin-Setup-";
/// 校验边车文件后缀。
pub const SHA512_SIDECAR_SUFFIX: &str = ".sha512";
/// 更新检查 HTTP 超时默认值（毫秒）。无 TS 对应常量（electron-updater 自带
/// 传输超时不可逐字移植）；受限网络下手动检查可等待，取宽松 15s。自动检查
/// 失败静默（对齐 TS 更新器），不受该值影响。
pub const DEFAULT_UPDATE_CHECK_TIMEOUT_MS: u64 = 15_000;

/// 发布中的一个可下载资产（GitHub `assets[]` 条目的整形）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseAsset {
    pub name: String,
    /// 下载直链（GitHub `browser_download_url`）。
    pub url: String,
    pub size: u64,
}

/// 一次更新检查的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    /// 剥离前导 `v` 后的版本串（如 `"1.2.3"`）。
    pub version: String,
    /// 发布说明（GitHub release `body`）；缺失 / null / 空白 → `None`。
    pub notes: Option<String>,
    pub assets: Vec<ReleaseAsset>,
}

/// GitHub Releases 响应的严格解析失败（消息可读，手动检查直出）。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("malformed GitHub releases/latest response: {0}")]
pub struct ReleaseParseError(pub String);

/// GitHub `tag_name` → 版本串：剥一个前导 `v`（release tag 约定 `v1.2.3`，
/// 也接受无前缀裸版本）；剥后必须仍是合法版本串（拒收 `nightly` 之类标签
/// ——协议漂移宁可早暴露）。`"v"` 本身 → `None`。
pub fn strip_release_tag(tag: &str) -> Option<String> {
    let version = tag.strip_prefix('v').unwrap_or(tag);
    if version.is_empty() {
        return None;
    }
    parse_version(version).ok()?;
    Some(version.to_string())
}

/// 版本对应的安装包资产名（发布约定，Task 4 构建脚本逐字对齐）。
pub fn installer_asset_name(version: &str) -> String {
    format!("{INSTALLER_ASSET_PREFIX}{version}.exe")
}

/// 在发布资产清单中精确匹配安装包资产（大小写敏感的全名匹配；blockmap
/// 等 `CommandCabin-Setup-1.0.0.exe.*` 相邻产物不误配）。
pub fn find_installer_asset(info: &UpdateInfo) -> Option<&ReleaseAsset> {
    let name = installer_asset_name(&info.version);
    info.assets.iter().find(|asset| asset.name == name)
}

/// 安装包资产名 → 校验边车资产名。
pub fn sidecar_asset_name(asset_name: &str) -> String {
    format!("{asset_name}{SHA512_SIDECAR_SUFFIX}")
}

/// GitHub Releases `latest` 响应体 → [`UpdateInfo`]（严格校验，见模块注释）。
pub fn parse_github_release_response(body: &str) -> Result<UpdateInfo, ReleaseParseError> {
    let fail = |reason: String| ReleaseParseError(reason);
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|error| fail(format!("invalid JSON: {error}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| fail("expected a JSON object".to_string()))?;

    let tag = object
        .get("tag_name")
        .and_then(|value| value.as_str())
        .ok_or_else(|| fail("tag_name must be a string".to_string()))?;
    let version = strip_release_tag(tag)
        .ok_or_else(|| fail(format!("tag_name {tag:?} is not a release version")))?;

    let assets_value = object
        .get("assets")
        .ok_or_else(|| fail("assets[] is required".to_string()))?;
    let assets = assets_value
        .as_array()
        .ok_or_else(|| fail("assets must be an array".to_string()))?
        .iter()
        .map(|asset| {
            let asset = asset
                .as_object()
                .ok_or_else(|| fail("assets[] entries must be objects".to_string()))?;
            let name = read_string_field(asset, "name")
                .ok_or_else(|| fail("asset name must be a non-empty string".to_string()))?;
            let url = read_string_field(asset, "browser_download_url").ok_or_else(|| {
                fail("asset browser_download_url must be a non-empty string".to_string())
            })?;
            let size = asset
                .get("size")
                .and_then(|value| value.as_u64())
                .ok_or_else(|| fail("asset size must be a non-negative integer".to_string()))?;
            Ok(ReleaseAsset { name, url, size })
        })
        .collect::<Result<Vec<ReleaseAsset>, ReleaseParseError>>()?;

    // body：字符串 → 变更说明（trim，空白 → None）；null / 缺失 → None；
    // 其余类型 → 严格拒绝。
    let notes = match object.get("body") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let text = value
                .as_str()
                .ok_or_else(|| fail("body must be a string or null".to_string()))?;
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
    };

    Ok(UpdateInfo {
        version,
        notes,
        assets,
    })
}

/// sha512sum 文本格式 → 目标资产的十六进制摘要（小写归一）。
///
/// 接受 `sha512sum` 事实标准：每行 `<128 位十六进制>␠␠<文件名>` 或
/// `<128 位十六进制>␠*<文件名>`（二进制模式指示符）；文件名须与
/// `asset_name` 完全一致；空行跳过；首个匹配行胜出。CRLF 与行尾空白容忍。
/// 找不到匹配行 / 摘要非法 → `None`（调用方必须拒绝下载物）。
pub fn parse_sha512_sidecar(text: &str, asset_name: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        // 格式：digest + 空格 + 可选 '*' + 文件名。
        let (digest, rest) = line.split_once(' ')?;
        if !digest.is_ascii()
            || digest.len() != 128
            || !digest.bytes().all(|b| b.is_ascii_hexdigit())
        {
            continue;
        }
        let filename = rest.strip_prefix('*').unwrap_or(rest);
        // 容忍分隔符是两空格以外的多空格：文件名前导空格剥掉（sha512sum
        // 产物不会出现带前导空格的文件名）。
        if filename.trim_start() != asset_name {
            continue;
        }
        return Some(digest.to_ascii_lowercase());
    }
    None
}

/// exchange_rate 同款字符串字段读取：字符串且 trim 后非空 → trim 后的值。
fn read_string_field(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    let value = object.get(key)?.as_str()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// 版本决策（检查路径的纯半步）：`current < latest` → 才有更新。相等或
/// 更旧 → 无更新（对齐 TS `update-not-available` 分支）。
pub fn is_newer(latest: &str, current: &str) -> Result<bool, VersionParseError> {
    Ok(compare_versions(latest, current)? == Ordering::Greater)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release_body(tag: &str, body: serde_json::Value) -> String {
        serde_json::json!({
            "tag_name": tag,
            "body": body,
            "assets": [
                {
                    "name": "CommandCabin-Setup-1.2.3.exe",
                    "browser_download_url": "https://github.com/RupingLiu/command-cabin/releases/download/v1.2.3/CommandCabin-Setup-1.2.3.exe",
                    "size": 97_433_771u64,
                },
                {
                    "name": "CommandCabin-Setup-1.2.3.exe.sha512",
                    "browser_download_url": "https://github.com/RupingLiu/command-cabin/releases/download/v1.2.3/CommandCabin-Setup-1.2.3.exe.sha512",
                    "size": 137u64,
                },
            ],
        })
        .to_string()
    }

    fn sample_info() -> UpdateInfo {
        UpdateInfo {
            version: "1.2.3".to_string(),
            notes: Some("release notes".to_string()),
            assets: vec![
                ReleaseAsset {
                    name: "CommandCabin-Setup-1.2.3.exe".to_string(),
                    url: "https://github.com/RupingLiu/command-cabin/releases/download/v1.2.3/CommandCabin-Setup-1.2.3.exe".to_string(),
                    size: 97_433_771,
                },
                ReleaseAsset {
                    name: "CommandCabin-Setup-1.2.3.exe.sha512".to_string(),
                    url: "https://github.com/RupingLiu/command-cabin/releases/download/v1.2.3/CommandCabin-Setup-1.2.3.exe.sha512".to_string(),
                    size: 137,
                },
            ],
        }
    }

    #[test]
    fn strips_release_tags() {
        assert_eq!(strip_release_tag("v1.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(strip_release_tag("1.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(strip_release_tag("v0.0.0").as_deref(), Some("0.0.0"));
        // 剥 v 后必须仍是合法版本串。
        assert_eq!(strip_release_tag("nightly"), None);
        assert_eq!(strip_release_tag("v"), None);
        assert_eq!(strip_release_tag("v1.2"), None);
        assert_eq!(strip_release_tag(""), None);
        // 只剥一个 v（v1.2.3 与 vv1.2.3 的差异刻意暴露——后者是非法标签）。
        assert_eq!(strip_release_tag("vv1.2.3"), None);
    }

    #[test]
    fn parses_valid_release_responses() {
        assert_eq!(
            parse_github_release_response(&release_body("v1.2.3", "release notes".into())),
            Ok(sample_info())
        );
        // 无 v 前缀 tag。
        let parsed = parse_github_release_response(&release_body("1.2.3", "notes".into())).unwrap();
        assert_eq!(parsed.version, "1.2.3");
        // body → notes；空串 / 空白 / null / 缺失 → None。
        assert_eq!(
            parse_github_release_response(&release_body("v1.2.3", "  line1\n\nline2  ".into()))
                .unwrap()
                .notes,
            Some("line1\n\nline2".to_string())
        );
        for empty in [
            serde_json::json!(""),
            serde_json::json!("   "),
            serde_json::Value::Null,
        ] {
            assert_eq!(
                parse_github_release_response(&release_body("v1.2.3", empty))
                    .unwrap()
                    .notes,
                None
            );
        }
        let no_body = r#"{"tag_name":"v1.2.3","assets":[]}"#;
        assert_eq!(
            parse_github_release_response(no_body).unwrap(),
            UpdateInfo {
                version: "1.2.3".to_string(),
                notes: None,
                assets: Vec::new(),
            }
        );
    }

    #[test]
    fn rejects_malformed_release_responses() {
        // 非 JSON / 非对象 / 必填字段缺失或类型不符 / 非法 tag / body 类型错。
        let cases = [
            ("not json at all", "invalid JSON"),
            ("[1,2,3]", "expected a JSON object"),
            ("\"just a string\"", "expected a JSON object"),
            ("123", "expected a JSON object"),
            ("null", "expected a JSON object"),
            ("{}", "tag_name must be a string"),
            (r#"{"tag_name":123}"#, "tag_name must be a string"),
            (
                r#"{"tag_name":""}"#,
                "tag_name \"\" is not a release version",
            ),
            (
                r#"{"tag_name":"v"}"#,
                "tag_name \"v\" is not a release version",
            ),
            (
                r#"{"tag_name":"beta-1"}"#,
                "tag_name \"beta-1\" is not a release version",
            ),
            (
                r#"{"tag_name":"v1.2.3.4"}"#,
                "tag_name \"v1.2.3.4\" is not a release version",
            ),
            (r#"{"tag_name":"v1.2.3"}"#, "assets[] is required"),
            (
                r#"{"tag_name":"v1.2.3","assets":{}}"#,
                "assets must be an array",
            ),
            (
                r#"{"tag_name":"v1.2.3","assets":[1]}"#,
                "assets[] entries must be objects",
            ),
            (
                r#"{"tag_name":"v1.2.3","assets":[{"browser_download_url":"https://x","size":1}]}"#,
                "asset name must be a non-empty string",
            ),
            (
                r#"{"tag_name":"v1.2.3","assets":[{"name":"a.exe","size":1}]}"#,
                "asset browser_download_url must be a non-empty string",
            ),
            (
                r#"{"tag_name":"v1.2.3","assets":[{"name":"","browser_download_url":"https://x","size":1}]}"#,
                "asset name must be a non-empty string",
            ),
            (
                r#"{"tag_name":"v1.2.3","assets":[{"name":"a.exe","browser_download_url":"https://x"}]}"#,
                "asset size must be a non-negative integer",
            ),
            (
                r#"{"tag_name":"v1.2.3","assets":[{"name":"a.exe","browser_download_url":"https://x","size":-1}]}"#,
                "asset size must be a non-negative integer",
            ),
            (
                r#"{"tag_name":"v1.2.3","assets":[{"name":"a.exe","browser_download_url":"https://x","size":1.5}]}"#,
                "asset size must be a non-negative integer",
            ),
            (
                r#"{"tag_name":"v1.2.3","assets":[{"name":"a.exe","browser_download_url":"https://x","size":"1"}]}"#,
                "asset size must be a non-negative integer",
            ),
            (
                r#"{"tag_name":"v1.2.3","assets":[],"body":123}"#,
                "body must be a string or null",
            ),
        ];
        for (body, reason_part) in cases {
            let error = parse_github_release_response(body).unwrap_err();
            assert!(
                error.to_string().contains(reason_part),
                "body {body}: got {error}"
            );
            // 消息前缀固定（serde_json 的行号详情后置，不作精确断言）。
            assert!(
                error
                    .to_string()
                    .starts_with("malformed GitHub releases/latest response: "),
                "body {body}: got {error}"
            );
        }
    }

    #[test]
    fn matches_installer_asset_by_exact_name() {
        let info = sample_info();
        let asset = find_installer_asset(&info).expect("installer asset present");
        assert_eq!(asset.name, "CommandCabin-Setup-1.2.3.exe");
        assert_eq!(asset.size, 97_433_771);

        // 缺失 → None；相邻产物（blockmap / 边车）不误配；大小写敏感。
        let mut without = sample_info();
        without.assets.remove(0);
        assert_eq!(find_installer_asset(&without), None);
        let mismatched = UpdateInfo {
            version: "1.2.3".to_string(),
            notes: None,
            assets: vec![ReleaseAsset {
                name: "CommandCabin-Setup-1.2.3.exe.blockmap".to_string(),
                url: "https://example.com/x".to_string(),
                size: 1,
            }],
        };
        assert_eq!(find_installer_asset(&mismatched), None);
        let wrong_case = UpdateInfo {
            version: "1.2.3".to_string(),
            notes: None,
            assets: vec![ReleaseAsset {
                name: "commandcabin-setup-1.2.3.exe".to_string(),
                url: "https://example.com/x".to_string(),
                size: 1,
            }],
        };
        assert_eq!(find_installer_asset(&wrong_case), None);
    }

    #[test]
    fn builds_installer_and_sidecar_names() {
        assert_eq!(
            installer_asset_name("1.0.0"),
            "CommandCabin-Setup-1.0.0.exe"
        );
        assert_eq!(
            sidecar_asset_name("CommandCabin-Setup-1.0.0.exe"),
            "CommandCabin-Setup-1.0.0.exe.sha512"
        );
        // 边车 URL 约定：资产 URL + 后缀。
        let asset = &sample_info().assets[0];
        assert_eq!(
            format!("{}{SHA512_SIDECAR_SUFFIX}", asset.url),
            sample_info().assets[1].url
        );
    }

    #[test]
    fn parses_sha512sum_sidecar_format() {
        let name = "CommandCabin-Setup-1.0.0.exe";
        let digest = "a".repeat(128);
        // 标准 sha512sum：两空格。
        assert_eq!(
            parse_sha512_sidecar(&format!("{digest}  {name}\n"), name).as_deref(),
            Some(digest.as_str())
        );
        // 二进制指示符 ` *`。
        assert_eq!(
            parse_sha512_sidecar(&format!("{digest} *{name}"), name).as_deref(),
            Some(digest.as_str())
        );
        // CRLF / 行尾空白 / 多空格分隔。
        assert_eq!(
            parse_sha512_sidecar(&format!("{digest}  {name}\r\n"), name).as_deref(),
            Some(digest.as_str())
        );
        assert_eq!(
            parse_sha512_sidecar(&format!("{digest}   {name}  "), name).as_deref(),
            Some(digest.as_str())
        );
        // 大写十六进制 → 小写归一。
        let upper = "A".repeat(128);
        assert_eq!(
            parse_sha512_sidecar(&format!("{upper}  {name}"), name).as_deref(),
            Some(digest.as_str())
        );
        // 多行清单：匹配行胜出；空行跳过。
        let list = format!(
            "{}  other.exe\n\n{}  {name}\n{}  third.exe\n",
            "b".repeat(128),
            digest,
            "c".repeat(128)
        );
        assert_eq!(
            parse_sha512_sidecar(&list, name).as_deref(),
            Some(digest.as_str())
        );
        // 找不到目标文件名 → None。
        assert_eq!(
            parse_sha512_sidecar(&format!("{digest}  other.exe"), name),
            None
        );
    }

    #[test]
    fn rejects_invalid_sha512_sidecars() {
        let name = "CommandCabin-Setup-1.0.0.exe";
        let good = "a".repeat(128);
        // 摘要长度 / 非十六进制 / 缺分隔符 / 文件名大小写不符。
        assert_eq!(
            parse_sha512_sidecar(&format!("{}  {name}", "a".repeat(127)), name),
            None
        );
        assert_eq!(
            parse_sha512_sidecar(&format!("{}  {name}", "a".repeat(129)), name),
            None
        );
        assert_eq!(
            parse_sha512_sidecar(&format!("{}  {name}", "z".repeat(128)), name),
            None
        );
        assert_eq!(parse_sha512_sidecar(&format!("{good}{name}"), name), None);
        assert_eq!(
            parse_sha512_sidecar(&format!("{good}  CommandCabin-setup-1.0.0.exe"), name),
            None
        );
        // 全空 / 全非匹配。
        assert_eq!(parse_sha512_sidecar("", name), None);
        assert_eq!(parse_sha512_sidecar("\n\n  \r\n", name), None);
    }

    #[test]
    fn is_newer_decision() {
        assert!(is_newer("1.2.3", "1.2.2").unwrap());
        assert!(!is_newer("1.2.3", "1.2.3").unwrap());
        assert!(!is_newer("1.2.2", "1.2.3").unwrap());
        assert!(is_newer("2.0.0", "1.9.9").unwrap());
        assert!(is_newer("1.0.1", "1.0.0").unwrap());
        assert!(is_newer("1.1.0", "1.0.99").unwrap());
        assert_eq!(is_newer("1.2", "1.0.0").unwrap_err().0, "1.2");
    }
}
