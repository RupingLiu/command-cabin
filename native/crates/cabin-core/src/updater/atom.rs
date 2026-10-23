//! GitHub Releases **Atom 订阅源**的解析（纯逻辑，无 IO）。
//!
//! **为什么存在**：`api.github.com` 对**未认证**请求按**出口 IP** 限流
//! 60 次/小时，共享出口（公司 NAT、机场节点）极易被邻居打满，此后所有
//! 请求一律 `403 rate limit exceeded`——这正是 v1.0.12 实机反馈的
//! `update check failed: HTTP 403` 根因。而 GitHub 的网页侧
//! `GET https://github.com/{owner}/{repo}/releases.atom` 是**普通网页
//! 流量**：不消耗 API 配额、不受该限流影响、也不需要 token。
//!
//! 于是检查路径的主通道改为 Atom 源，API 仅作兜底（见平台层 `updater`）。
//! 代价是 Atom 不含 `assets[]`——版本与发布说明够用，资产改为按**发布
//! 约定拼装**（[`release_download_url`]）：`release` 标签、资产名与下载
//! 路径三者都是本地可推导的确定性命名，配合 `.sha512` 边车校验，安全性
//! 与 API 元数据路径等价（甚至更弱依赖：不信任远端返回的资产清单）。
//!
//! **只取首条 entry**：GitHub 的 releases feed 按发布时间倒序，首条即最新
//! 正式发布（draft / prerelease 不进 feed，stable-only 语义与
//! `releases/latest` 一致）。pre-release 标签（`v1.2.3-beta.1`）会被
//! [`strip_release_tag`] 拒绝——此时回退 API 通道，语义不漂移。

use crate::updater::{strip_release_tag, update_download_asset_name, update_sidecar_asset_name};

/// GitHub releases Atom 源端点（**零 API 配额**）。
pub const GITHUB_RELEASES_ATOM_ENDPOINT: &str =
    "https://github.com/RupingLiu/command-cabin/releases.atom";
/// GitHub 下载直链前缀（`{owner}/{repo}` 部分）。
const GITHUB_DOWNLOAD_ROOT: &str = "https://github.com/RupingLiu/command-cabin/releases/download";

/// Atom 源解析失败（消息可读，手动检查直出）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("malformed GitHub releases.atom response: {0}")]
pub struct AtomParseError(pub String);

/// Atom 源中的一条发布（只保留更新检查需要的字段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AtomRelease {
    /// 剥前导 `v` 后的版本串（如 `"1.2.3"`）。
    pub version: String,
    /// 原始 release 标签（如 `"v1.2.3"`；构造下载 URL 用）。
    pub tag: String,
    /// 发布说明（Atom `content` 的 HTML 已转成纯文本；空白 → `None`）。
    pub notes: Option<String>,
}

/// 构造某版本的安装包下载直链（**发布约定**，与资产名规则同源）。
///
/// `releases/download/{tag}/{asset_name}` 是 GitHub 的确定性路径；配合
/// `.sha512` 边车（[`update_sidecar_asset_name`]）即可完成“先取摘要、再
/// 校验下载物”的安全流程，无需 API 的 `assets[]` 元数据。
pub fn release_download_url(tag: &str, version: &str) -> String {
    format!(
        "{GITHUB_DOWNLOAD_ROOT}/{tag}/{}",
        update_download_asset_name(version)
    )
}

/// 构造某版本安装包的 `.sha512` 边车直链。
pub fn release_sidecar_url(tag: &str, version: &str) -> String {
    format!(
        "{GITHUB_DOWNLOAD_ROOT}/{tag}/{}",
        update_sidecar_asset_name(version)
    )
}

/// Atom 源 XML → 最新一条发布。**严格解析**：源结构非法、无 entry、首条
/// 缺 id/link 或无合法版本标签 → [`AtomParseError`]（调用方回退 API 通道）。
///
/// 只用首条 entry；`content` 缺失不算错误（发布可以没有说明）。
pub fn parse_releases_atom(xml: &str) -> Result<AtomRelease, AtomParseError> {
    let document = roxmltree::Document::parse(xml)
        .map_err(|error| AtomParseError(format!("invalid XML: {error}")))?;
    let root = document.root_element();
    if !root.tag_name().name().eq_ignore_ascii_case("feed") {
        return Err(AtomParseError(format!(
            "expected an Atom <feed>, got <{}>",
            root.tag_name().name()
        )));
    }

    let entry = root
        .children()
        .find(|node| node.is_element() && node.tag_name().name().eq_ignore_ascii_case("entry"))
        .ok_or_else(|| AtomParseError("feed has no <entry> element".to_string()))?;

    let title = child_text(&entry, "title").unwrap_or_default();
    let tag = entry_tag(&entry, &title)
        .ok_or_else(|| AtomParseError("entry has no release tag".to_string()))?;
    let version = strip_release_tag(&tag).ok_or_else(|| {
        AtomParseError(format!(
            "release tag {tag:?} is not a stable release version (prerelease or non-version tag)"
        ))
    })?;

    let notes = child_text(&entry, "content").and_then(|html| html_to_text(&html));

    Ok(AtomRelease {
        version,
        tag,
        notes,
    })
}

/// 取 entry 内的子元素文本（直接子节点；Atom 的 entry 字段都是直接子元素）。
fn child_text(node: &roxmltree::Node<'_, '_>, name: &str) -> Option<String> {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name().eq_ignore_ascii_case(name))
        .map(|child| child.text().unwrap_or_default().trim().to_string())
        .filter(|text| !text.is_empty())
}

/// 从 entry 推断 release 标签：优先 `<link rel="alternate">` 的
/// `/releases/tag/{tag}` 尾段，退化为 `<id>` 的 `.../v1.2.3` 尾段，最后
/// 尝试从 `<title>` 里抽 `v1.2.3` 形态的 token。
///
/// **每个候选都先过 [`strip_release_tag`] 校验**——id / title 的尾段常常
/// 不是版本（`Repository/1`、`Notes for`），跳过它们继续找；全都不像版本
/// 时返回首个候选，让调用方给出“标签不是稳定版本”的可读错误。
fn entry_tag(entry: &roxmltree::Node<'_, '_>, title: &str) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();

    for href in entry
        .children()
        .filter(|node| node.is_element() && node.tag_name().name().eq_ignore_ascii_case("link"))
        .filter_map(|node| node.attribute("href"))
    {
        if let Some(tag) = href.rsplit("/releases/tag/").next() {
            if !tag.is_empty() && !tag.contains('/') && tag != href {
                candidates.push(tag.to_string());
            }
        }
    }
    if let Some(id) = child_text(entry, "id") {
        if let Some(tag) = id.rsplit('/').next() {
            if !tag.is_empty() {
                candidates.push(tag.to_string());
            }
        }
    }
    for token in title.split_whitespace() {
        let token = token.trim_end_matches([',', '.', ':', ';']);
        if strip_release_tag(token).is_some() {
            candidates.push(token.to_string());
        }
    }

    candidates
        .iter()
        .find(|tag| strip_release_tag(tag).is_some())
        .cloned()
        .or_else(|| candidates.into_iter().next())
}

/// 发布说明 HTML → 纯文本。
///
/// GitHub 的 `content` 是**转义过的 HTML 片段**（`&lt;h1&gt;...`），XML 解析
/// 已还原为真正的 HTML 文本，所以这里只需把标签与常见实体去掉。发布说明
/// 只在两个地方露面（设置页 available 状态行的首行摘要），因此不做完整
/// 的 HTML 渲染：剥标签、解四种基本实体、压掉空行即可。
fn html_to_text(html: &str) -> Option<String> {
    let mut out = String::with_capacity(html.len());
    let mut chars = html.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '<' => {
                // 丢到下一个 '>'；标签边界当成空格分隔（`a<br>b` → "a b"）。
                for inner in chars.by_ref() {
                    if inner == '>' {
                        break;
                    }
                }
                out.push('\n');
            }
            '&' => {
                // 收实体名（到 ';' 或 32 个字符为止）；未知实体按原文保留。
                let mut entity = String::new();
                let mut closed = false;
                for inner in chars.by_ref() {
                    if inner == ';' {
                        closed = true;
                        break;
                    }
                    if entity.len() >= 32 || inner.is_whitespace() {
                        break;
                    }
                    entity.push(inner);
                }
                if closed {
                    match entity.as_str() {
                        "amp" => out.push('&'),
                        "lt" => out.push('<'),
                        "gt" => out.push('>'),
                        "quot" => out.push('"'),
                        "apos" => out.push('\''),
                        "nbsp" => out.push(' '),
                        // 数字实体（`&#39;` / `&#x27;`）。
                        other => match decode_numeric_entity(other) {
                            Some(decoded) => out.push(decoded),
                            None => {
                                out.push('&');
                                out.push_str(other);
                                out.push(';');
                            }
                        },
                    }
                } else {
                    out.push('&');
                    out.push_str(&entity);
                }
            }
            '\r' => {}
            other => out.push(other),
        }
    }

    // 逐行 trim、丢掉空行、去掉 Markdown 标题记号（与 notes_summary 一致）。
    let lines: Vec<&str> = out
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(lines.join("\n"))
}

/// `&#39;` / `&#x27;` → 字符；其余 → None。
fn decode_numeric_entity(entity: &str) -> Option<char> {
    let digits = entity.strip_prefix('#')?;
    let code = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => digits.parse::<u32>().ok()?,
    };
    char::from_u32(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GitHub releases.atom 的真实形状（v1.0.12 抓取，正文截断）。
    const REAL_FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/RupingLiu/command-cabin/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/RupingLiu/command-cabin/releases"/>
  <title>Release notes from command-cabin</title>
  <entry>
    <id>tag:github.com,2008:Repository/1239669936/v1.0.12</id>
    <updated>2026-10-15T04:06:25Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/RupingLiu/command-cabin/releases/tag/v1.0.12"/>
    <title>CommandCabin v1.0.12</title>
    <content type="html">&lt;h1&gt;CommandCabin v1.0.12&lt;/h1&gt;
&lt;p&gt;Fix the search placeholder overlap.&lt;/p&gt;
</content>
    <author>
      <name>RupingLiu</name>
    </author>
    <media:thumbnail height="30" width="30" url="https://avatars.githubusercontent.com/u/8169416?s=60&amp;v=4"/>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1239669936/v1.0.11</id>
    <link rel="alternate" type="text/html" href="https://github.com/RupingLiu/command-cabin/releases/tag/v1.0.11"/>
    <title>CommandCabin v1.0.11</title>
  </entry>
</feed>
"#;

    #[test]
    fn parses_the_newest_release_from_a_real_feed() {
        let release = parse_releases_atom(REAL_FEED).expect("real feed parses");
        assert_eq!(release.version, "1.0.12");
        assert_eq!(release.tag, "v1.0.12");
        assert_eq!(
            release.notes.as_deref(),
            Some("CommandCabin v1.0.12\nFix the search placeholder overlap.")
        );
    }

    #[test]
    fn parses_a_minimal_feed_without_content() {
        let feed = r#"<feed><entry>
            <id>tag:github.com,2008:Repository/1/v2.3.4</id>
            <link rel="alternate" href="https://github.com/o/r/releases/tag/v2.3.4"/>
            <title>v2.3.4</title>
        </entry></feed>"#;
        let release = parse_releases_atom(feed).expect("minimal feed parses");
        assert_eq!(release.version, "2.3.4");
        assert_eq!(release.tag, "v2.3.4");
        assert_eq!(release.notes, None);
    }

    #[test]
    fn falls_back_to_id_then_title_for_the_tag() {
        // 无 link：用 id 尾段。
        let feed = r#"<feed><entry>
            <id>tag:github.com,2008:Repository/1/v3.0.0</id>
            <title>some notes</title>
        </entry></feed>"#;
        assert_eq!(parse_releases_atom(feed).unwrap().tag, "v3.0.0");

        // id 也无斜杠尾段可用：用 title token。
        let feed = r#"<feed><entry>
            <id>1</id>
            <title>Notes for v4.5.6</title>
        </entry></feed>"#;
        let release = parse_releases_atom(feed).unwrap();
        assert_eq!(release.tag, "v4.5.6");
        assert_eq!(release.version, "4.5.6");
    }

    #[test]
    fn rejects_prerelease_and_non_version_tags() {
        let feed = r#"<feed><entry>
            <id>tag:github.com,2008:Repository/1/v1.2.3-beta.1</id>
            <link rel="alternate" href="https://github.com/o/r/releases/tag/v1.2.3-beta.1"/>
            <title>beta</title>
        </entry></feed>"#;
        let error = parse_releases_atom(feed).unwrap_err();
        assert!(
            error.to_string().contains("not a stable release version"),
            "{error}"
        );
    }

    #[test]
    fn rejects_malformed_feeds() {
        for (feed, reason) in [
            ("not xml at all", "invalid XML"),
            ("<html><body/></html>", "expected an Atom <feed>"),
            ("<feed></feed>", "feed has no <entry> element"),
        ] {
            let error = parse_releases_atom(feed).unwrap_err();
            assert!(
                error.to_string().contains(reason),
                "{feed:?} → {error} (want {reason})"
            );
        }
    }

    #[test]
    fn download_urls_follow_the_release_convention() {
        assert_eq!(
            release_download_url("v1.2.3", "1.2.3"),
            "https://github.com/RupingLiu/command-cabin/releases/download/v1.2.3/CommandCabin-Setup-1.2.3.exe"
        );
        assert_eq!(
            release_sidecar_url("v1.2.3", "1.2.3"),
            "https://github.com/RupingLiu/command-cabin/releases/download/v1.2.3/CommandCabin-Setup-1.2.3.exe.sha512"
        );
    }

    #[test]
    fn html_to_text_strips_markup_and_entities() {
        assert_eq!(
            html_to_text("<h1>Title</h1>\n<p>Body &amp; more</p>").as_deref(),
            Some("Title\nBody & more")
        );
        // 行内标签变空格分隔，空行被压掉。
        assert_eq!(html_to_text("a<br>b\n\n\nc").as_deref(), Some("a\nb\nc"));
        // 数字实体。
        assert_eq!(html_to_text("it&#39;s &#x2F;").as_deref(), Some("it's /"));
        // 未知实体保留原文；空白 → None。
        assert_eq!(html_to_text("&unknown;").as_deref(), Some("&unknown;"));
        assert_eq!(html_to_text("   \n\t\n"), None);
        assert_eq!(html_to_text(""), None);
    }
}
