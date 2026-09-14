//! 搜索文本归一化。移植自 packages/core/src/search/tokenize.ts。
//! 差异：source_ranges 以 char 下标计（TS 为 UTF-16 码元）；变音符判定用组合音符区段
//! 近似 JS \p{Diacritic}。

use unicode_normalization::UnicodeNormalization;

pub type SourceRange = (usize, usize);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedSearchTextMapping {
    pub normalized_text: String,
    /// 与 normalized_text 的 char 一一对应，指向源字符串的 char 下标区间（含端点）。
    pub source_ranges: Vec<SourceRange>,
}

fn is_combining_mark(character: char) -> bool {
    matches!(
        character,
        '\u{0300}'..='\u{036F}'
            | '\u{1AB0}'..='\u{1AFF}'
            | '\u{1DC0}'..='\u{1DFF}'
            | '\u{20D0}'..='\u{20FF}'
            | '\u{FE20}'..='\u{FE2F}'
    )
}

pub fn normalize_search_text(value: &str) -> String {
    normalize_search_text_with_mapping(value).normalized_text
}

pub fn normalize_search_text_with_mapping(value: &str) -> NormalizedSearchTextMapping {
    // 阶段 1：逐 char NFKD，记录每个分解产物的来源 char 下标。
    let mut decomposed = String::new();
    let mut ranges: Vec<SourceRange> = Vec::new();
    for (source_index, character) in value.chars().enumerate() {
        let pieces: Vec<char> = character.nfkd().collect();
        for _ in &pieces {
            ranges.push((source_index, source_index));
        }
        decomposed.extend(pieces);
    }

    // 阶段 2：去掉组合音符；被去掉的音符并入前一个输出字符的区间，串首音符并入后一个。
    let mut stripped = String::new();
    let mut stripped_ranges: Vec<SourceRange> = Vec::new();
    let mut leading_start: Option<usize> = None;
    for (character, range) in decomposed.chars().zip(ranges.iter()) {
        if is_combining_mark(character) {
            if let Some(last) = stripped_ranges.last_mut() {
                last.1 = last.1.max(range.1);
            } else {
                leading_start = Some(leading_start.map_or(range.0, |start| start.min(range.0)));
            }
            continue;
        }
        stripped.push(character);
        stripped_ranges.push((leading_start.unwrap_or(range.0), range.1));
        leading_start = None;
    }

    // 阶段 3：逐 char 小写（to_lowercase 可能展开为多 char，区间复制）。
    let mut lowered = String::new();
    let mut lowered_ranges: Vec<SourceRange> = Vec::new();
    for (character, range) in stripped.chars().zip(stripped_ranges.iter()) {
        let pieces: Vec<char> = character.to_lowercase().collect();
        for _ in &pieces {
            lowered_ranges.push(*range);
        }
        lowered.extend(pieces);
    }

    // 阶段 4：去首尾空白、折叠连续空白为单个空格；被折叠的空白保留首个区间。
    let mut normalized_text = String::new();
    let mut source_ranges: Vec<SourceRange> = Vec::new();
    let mut pending_whitespace: Option<SourceRange> = None;
    for (character, range) in lowered.chars().zip(lowered_ranges.iter()) {
        if character.is_whitespace() {
            if !source_ranges.is_empty() {
                pending_whitespace = Some(match pending_whitespace {
                    None => *range,
                    Some((start, _)) => (start, range.1),
                });
            }
            continue;
        }
        if let Some(range) = pending_whitespace.take() {
            normalized_text.push(' ');
            source_ranges.push(range);
        }
        normalized_text.push(character);
        source_ranges.push(*range);
    }

    NormalizedSearchTextMapping {
        normalized_text,
        source_ranges,
    }
}

pub fn tokenize_search_text(value: &str) -> Vec<String> {
    let normalized = normalize_search_text(value);
    if normalized.is_empty() {
        return Vec::new();
    }
    normalized.split(' ').map(str::to_string).collect()
}

pub fn normalize_search_keywords(keywords: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for keyword in keywords {
        let value = normalize_search_text(keyword);
        if !value.is_empty() && !normalized.contains(&value) {
            normalized.push(value);
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_case_whitespace_and_diacritics() {
        assert_eq!(normalize_search_text("  Héllo   WÖRLD  "), "hello world");
    }

    #[test]
    fn nfkd_decomposes_ligatures_and_compatibility_forms() {
        assert_eq!(normalize_search_text("ﬁle ②"), "file 2");
    }

    #[test]
    fn empty_and_whitespace_only_input() {
        assert_eq!(normalize_search_text(""), "");
        assert_eq!(normalize_search_text("   \t  "), "");
    }

    #[test]
    fn mapping_tracks_source_char_indices() {
        let mapping = normalize_search_text_with_mapping("Hé  llo");
        assert_eq!(mapping.normalized_text, "he llo");
        // 'é'（源 char 下标 1）NFKD 为 e + 组合符，输出 'e' 映射回 1
        assert_eq!(mapping.source_ranges[1], (1, 1));
    }

    #[test]
    fn tokenize_splits_on_single_spaces() {
        assert_eq!(
            tokenize_search_text("Visual  Studio Code"),
            vec!["visual", "studio", "code"]
        );
        assert!(tokenize_search_text("  ").is_empty());
    }

    #[test]
    fn keywords_are_normalized_and_deduped_in_first_seen_order() {
        let keywords = vec![
            "Code".to_string(),
            "code".to_string(),
            "  ".to_string(),
            "VS Code".to_string(),
        ];
        assert_eq!(
            normalize_search_keywords(&keywords),
            vec!["code", "vs code"]
        );
    }
}
