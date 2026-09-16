//! 搜索引擎。移植自 packages/core/src/search/searchEngine.ts，Fuse.js 由 nucleo-matcher
//! 替代（子序列匹配，无容错拼写）。nucleo 原始分通过“查询对自身匹配”的分值归一化为
//! 越低越好的 fuse_score 语义，排序公式与 TS 完全一致。
//!
//! Fuse → nucleo 语义差异：
//! - nucleo 是子序列匹配，不支持 Fuse 的容错拼写；含空格的查询被 Pattern 拆成多个
//!   atom，每个 atom 都必须在字段内命中（子序列）才算匹配。
//! - 归一化方式：以查询对自身做匹配得到 `perfect_score`，
//!   `fuse_score = 1 - (raw/perfect).clamp(0,1)`，从而复用 Task 4 的排序层而不改公式。
//! - 精确子串轮 matched_by 的 indices 为源字符串 char 区间（经 tokenize 的
//!   source_ranges 映射）；模糊轮 indices 为归一化文本上的 char 下标（nucleo 对
//!   非 ASCII 文本按 grapheme 首字符计，归一化后两者基本一致）。
//! - 与 TS 一致，pinned/history 加成只影响已匹配命令的排序；补充轮对未覆盖的
//!   boosted 文档去重后再匹配。查询中的标点按普通文本处理，不启用模式操作符。

use std::collections::{HashMap, HashSet};

use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use crate::command::types::Command;

use super::ranking::{
    rank_search_candidate, RankingContext, RankingExplanation, RankingInput, SearchMatchField,
    SearchMatchedBy,
};
use super::tokenize::{normalize_search_text, normalize_search_text_with_mapping, SourceRange};

const DEFAULT_SEARCH_LIMIT: usize = 20;
const DEFAULT_RANKING_CANDIDATE_LIMIT: usize = 100;

#[derive(Debug, Clone)]
struct SearchDocument {
    command: Command,
    normalized_title: String,
    title_source_ranges: Vec<SourceRange>,
    normalized_subtitle: Option<String>,
    subtitle_source_ranges: Option<Vec<SourceRange>>,
    normalized_keywords: Vec<String>,
    keyword_source_ranges: Vec<Vec<SourceRange>>,
}

impl SearchDocument {
    fn new(command: &Command) -> Self {
        let title = normalize_search_text_with_mapping(&command.title);
        let (subtitle_text, subtitle_ranges) = command
            .subtitle
            .as_deref()
            .map(normalize_search_text_with_mapping)
            .map(|mapping| (Some(mapping.normalized_text), Some(mapping.source_ranges)))
            .unwrap_or((None, None));
        let keyword_mappings: Vec<_> = command
            .keywords
            .iter()
            .map(|keyword| normalize_search_text_with_mapping(keyword))
            .collect();
        Self {
            command: command.clone(),
            normalized_title: title.normalized_text,
            title_source_ranges: title.source_ranges,
            normalized_subtitle: subtitle_text,
            subtitle_source_ranges: subtitle_ranges,
            normalized_keywords: keyword_mappings
                .iter()
                .map(|mapping| mapping.normalized_text.clone())
                .collect(),
            keyword_source_ranges: keyword_mappings
                .into_iter()
                .map(|mapping| mapping.source_ranges)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchResultItem {
    pub command: Command,
    pub score: f64,
    /// 越低越好的模糊分（与 TS 的 Fuse score 语义对齐）。
    pub fuzzy_score: f64,
    pub matched_by: Vec<SearchMatchedBy>,
    pub ranking: RankingExplanation,
}

#[derive(Default)]
pub struct SearchOptions<'a> {
    pub limit: Option<usize>,
    pub include_all_on_empty_query: Option<bool>,
    pub ranking: Option<&'a RankingContext>,
}

#[derive(Clone)]
struct RankedCandidate {
    document_index: usize,
    score: f64,
    fuzzy_score: f64,
    matched_by: Vec<SearchMatchedBy>,
    ranking: RankingExplanation,
}

pub struct SearchEngine {
    documents: Vec<SearchDocument>,
    document_index_by_id: HashMap<String, usize>,
    limit: usize,
    include_all_on_empty_query: bool,
}

impl SearchEngine {
    pub fn new(commands: Vec<Command>) -> Self {
        let mut engine = Self {
            documents: Vec::new(),
            document_index_by_id: HashMap::new(),
            limit: DEFAULT_SEARCH_LIMIT,
            include_all_on_empty_query: true,
        };
        engine.update(commands);
        engine
    }

    pub fn update(&mut self, commands: Vec<Command>) {
        self.documents = commands.iter().map(SearchDocument::new).collect();
        self.document_index_by_id = self
            .documents
            .iter()
            .enumerate()
            .map(|(index, document)| (document.command.id.clone(), index))
            .collect();
    }

    pub fn upsert(&mut self, command: Command) {
        let document = SearchDocument::new(&command);
        match self.document_index_by_id.get(&command.id) {
            Some(&index) => self.documents[index] = document,
            None => {
                self.document_index_by_id
                    .insert(command.id.clone(), self.documents.len());
                self.documents.push(document);
            }
        }
    }

    pub fn remove(&mut self, command_id: &str) -> bool {
        let Some(index) = self.document_index_by_id.remove(command_id) else {
            return false;
        };
        self.documents.remove(index);
        self.document_index_by_id = self
            .documents
            .iter()
            .enumerate()
            .map(|(index, document)| (document.command.id.clone(), index))
            .collect();
        true
    }

    pub fn clear(&mut self) {
        self.update(Vec::new());
    }

    pub fn search(&self, query: &str, options: SearchOptions) -> Vec<SearchResultItem> {
        let normalized_query = normalize_search_text(query);
        let limit = options.limit.unwrap_or(self.limit);
        if limit == 0 {
            return Vec::new();
        }
        if normalized_query.is_empty() {
            return self.search_empty_query(query, limit, &options);
        }
        self.search_ranked(query, &normalized_query, limit, options.ranking)
    }

    fn search_empty_query(
        &self,
        query: &str,
        limit: usize,
        options: &SearchOptions,
    ) -> Vec<SearchResultItem> {
        if !options
            .include_all_on_empty_query
            .unwrap_or(self.include_all_on_empty_query)
        {
            return Vec::new();
        }
        let mut top: Vec<RankedCandidate> = Vec::new();
        for index in 0..self.documents.len() {
            let candidate = self.rank_candidate(
                index,
                query,
                "",
                1.0,
                vec![SearchMatchedBy {
                    field: SearchMatchField::EmptyQuery,
                    indices: Vec::new(),
                    value: Some(String::new()),
                    ref_index: None,
                }],
                options.ranking,
            );
            insert_top_candidate(&self.documents, &mut top, candidate, limit);
        }
        top.into_iter()
            .map(|candidate| self.to_result(candidate))
            .collect()
    }

    fn search_ranked(
        &self,
        query: &str,
        normalized_query: &str,
        limit: usize,
        context: Option<&RankingContext>,
    ) -> Vec<SearchResultItem> {
        let mut top: Vec<RankedCandidate> = Vec::new();
        let mut exact_indices: HashSet<usize> = HashSet::new();

        // 第一轮：归一化字段上的精确子串匹配，fuse_score = 0（完全匹配）。
        for (index, document) in self.documents.iter().enumerate() {
            let matched_by = exact_matches(document, normalized_query);
            if matched_by.is_empty() {
                continue;
            }
            exact_indices.insert(index);
            let candidate =
                self.rank_candidate(index, query, normalized_query, 0.0, matched_by, context);
            insert_top_candidate(&self.documents, &mut top, candidate, limit);
        }

        if exact_indices.len() != self.documents.len() {
            // 第二轮：nucleo 模糊匹配，取 max(limit, 100) 个候选。
            let mut matcher = Matcher::new(Config::DEFAULT);
            let pattern = Pattern::new(
                normalized_query,
                CaseMatching::Ignore,
                Normalization::Smart,
                AtomKind::Fuzzy,
            );
            let mut haystack_buf: Vec<char> = Vec::new();
            let mut perfect_indices: Vec<u32> = Vec::new();
            let perfect_score = pattern
                .indices(
                    Utf32Str::new(normalized_query, &mut haystack_buf),
                    &mut matcher,
                    &mut perfect_indices,
                )
                .unwrap_or(1)
                .max(1);
            let candidate_limit = limit.max(DEFAULT_RANKING_CANDIDATE_LIMIT);
            let mut fuzzy: Vec<(usize, u32, Vec<SearchMatchedBy>)> = Vec::new();

            for (index, document) in self.documents.iter().enumerate() {
                if exact_indices.contains(&index) {
                    continue;
                }
                if let Some((raw, matched_by)) =
                    fuzzy_match_document(&mut matcher, &pattern, document, &mut haystack_buf)
                {
                    fuzzy.push((index, raw, matched_by));
                }
            }
            fuzzy.sort_by_key(|entry| std::cmp::Reverse(entry.1));
            fuzzy.truncate(candidate_limit);

            let mut fuzzy_indices: HashSet<usize> = HashSet::new();
            for (index, raw, matched_by) in fuzzy {
                fuzzy_indices.insert(index);
                let fuse_score = 1.0 - (raw as f64 / perfect_score as f64).clamp(0.0, 1.0);
                let candidate = self.rank_candidate(
                    index,
                    query,
                    normalized_query,
                    fuse_score,
                    matched_by,
                    context,
                );
                insert_top_candidate(&self.documents, &mut top, candidate, limit);
            }

            // 第三轮：pinned/history 加成文档即使模糊分低也进入候选（TS 行为：
            // 对 boosted 文档单独跑一轮匹配；这里对前两轮未覆盖的 boosted 文档补一轮）。
            for boosted_id in boosted_command_ids(context) {
                let Some(&index) = self.document_index_by_id.get(&boosted_id) else {
                    continue;
                };
                if exact_indices.contains(&index) || fuzzy_indices.contains(&index) {
                    continue;
                }
                let document = &self.documents[index];
                let Some((raw, matched_by)) =
                    fuzzy_match_document(&mut matcher, &pattern, document, &mut haystack_buf)
                else {
                    continue;
                };
                let fuse_score = 1.0 - (raw as f64 / perfect_score as f64).clamp(0.0, 1.0);
                let candidate = self.rank_candidate(
                    index,
                    query,
                    normalized_query,
                    fuse_score,
                    matched_by,
                    context,
                );
                insert_top_candidate(&self.documents, &mut top, candidate, limit);
            }
        }

        top.into_iter()
            .map(|candidate| self.to_result(candidate))
            .collect()
    }

    fn rank_candidate(
        &self,
        document_index: usize,
        query: &str,
        normalized_query: &str,
        fuse_score: f64,
        matched_by: Vec<SearchMatchedBy>,
        context: Option<&RankingContext>,
    ) -> RankedCandidate {
        let document = &self.documents[document_index];
        let result = rank_search_candidate(&RankingInput {
            command: document.command.clone(),
            query: query.to_string(),
            normalized_query: Some(normalized_query),
            normalized_title: Some(&document.normalized_title),
            fuse_score,
            matched_by: matched_by.clone(),
            context,
        });
        // matched_by 保留原始命中（含 indices/value）；ranking.explanation 只带字段清单
        RankedCandidate {
            document_index,
            score: result.score,
            fuzzy_score: fuse_score,
            matched_by,
            ranking: result.explanation,
        }
    }

    fn to_result(&self, candidate: RankedCandidate) -> SearchResultItem {
        SearchResultItem {
            command: self.documents[candidate.document_index].command.clone(),
            score: candidate.score,
            fuzzy_score: candidate.fuzzy_score,
            matched_by: candidate.matched_by,
            ranking: candidate.ranking,
        }
    }
}

fn exact_matches(document: &SearchDocument, normalized_query: &str) -> Vec<SearchMatchedBy> {
    let mut matched_by = Vec::new();
    append_exact_match(
        &mut matched_by,
        SearchMatchField::Title,
        &document.command.title,
        &document.normalized_title,
        &document.title_source_ranges,
        normalized_query,
        None,
    );
    if let (Some(subtitle), Some(normalized), Some(ranges)) = (
        document.command.subtitle.as_deref(),
        document.normalized_subtitle.as_deref(),
        document.subtitle_source_ranges.as_deref(),
    ) {
        append_exact_match(
            &mut matched_by,
            SearchMatchField::Subtitle,
            subtitle,
            normalized,
            ranges,
            normalized_query,
            None,
        );
    }
    for (index, keyword) in document.command.keywords.iter().enumerate() {
        append_exact_match(
            &mut matched_by,
            SearchMatchField::Keywords,
            keyword,
            &document.normalized_keywords[index],
            &document.keyword_source_ranges[index],
            normalized_query,
            Some(index),
        );
    }
    matched_by
}

fn append_exact_match(
    matched_by: &mut Vec<SearchMatchedBy>,
    field: SearchMatchField,
    value: &str,
    normalized_value: &str,
    source_ranges: &[SourceRange],
    normalized_query: &str,
    ref_index: Option<usize>,
) {
    let Some(start) = normalized_value.find(normalized_query) else {
        return;
    };
    // char 下标（normalize 输出按 char 对齐）
    let char_start = normalized_value[..start].chars().count();
    let query_len = normalized_query.chars().count();
    let char_end = char_start + query_len - 1;
    let (Some(&start_range), Some(&end_range)) =
        (source_ranges.get(char_start), source_ranges.get(char_end))
    else {
        return;
    };
    matched_by.push(SearchMatchedBy {
        field,
        indices: vec![(start_range.0, end_range.1)],
        value: Some(value.to_string()),
        ref_index,
    });
}

/// 对 title/subtitle/keywords 逐个字段做模糊匹配，返回（最佳原始分, 各字段 matched_by）。
fn fuzzy_match_document(
    matcher: &mut Matcher,
    pattern: &Pattern,
    document: &SearchDocument,
    haystack_buf: &mut Vec<char>,
) -> Option<(u32, Vec<SearchMatchedBy>)> {
    let mut best: Option<u32> = None;
    let mut matched_by = Vec::new();

    let mut indices: Vec<u32> = Vec::new();
    if let Some(score) = pattern.indices(
        Utf32Str::new(&document.normalized_title, haystack_buf),
        matcher,
        &mut indices,
    ) {
        best = Some(score);
        matched_by.push(SearchMatchedBy {
            field: SearchMatchField::Title,
            indices: indices_to_ranges(&indices),
            value: Some(document.command.title.clone()),
            ref_index: None,
        });
    }
    if let Some(normalized_subtitle) = document.normalized_subtitle.as_deref() {
        indices.clear();
        if let Some(score) = pattern.indices(
            Utf32Str::new(normalized_subtitle, haystack_buf),
            matcher,
            &mut indices,
        ) {
            best = Some(best.map_or(score, |b: u32| b.max(score)));
            matched_by.push(SearchMatchedBy {
                field: SearchMatchField::Subtitle,
                indices: indices_to_ranges(&indices),
                value: document.command.subtitle.clone(),
                ref_index: None,
            });
        }
    }
    for (index, normalized_keyword) in document.normalized_keywords.iter().enumerate() {
        indices.clear();
        if let Some(score) = pattern.indices(
            Utf32Str::new(normalized_keyword, haystack_buf),
            matcher,
            &mut indices,
        ) {
            best = Some(best.map_or(score, |b: u32| b.max(score)));
            matched_by.push(SearchMatchedBy {
                field: SearchMatchField::Keywords,
                indices: indices_to_ranges(&indices),
                value: document.command.keywords.get(index).cloned(),
                ref_index: Some(index),
            });
        }
    }

    best.map(|score| (score, matched_by))
}

/// nucleo 返回命中 char 下标列表（多 atom 查询时按 atom 追加，整体无序）；排序去重后
/// 折叠为连续区间（与 TS Fuse indices 语义一致）。
fn indices_to_ranges(indices: &[u32]) -> Vec<(usize, usize)> {
    let mut sorted: Vec<u32> = indices.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for &index in &sorted {
        let index = index as usize;
        match ranges.last_mut() {
            Some(last) if index == last.1 + 1 => last.1 = index,
            _ => ranges.push((index, index)),
        }
    }
    ranges
}

fn boosted_command_ids(context: Option<&RankingContext>) -> HashSet<String> {
    let Some(context) = context else {
        return HashSet::new();
    };
    let mut ids = context.pinned_command_ids.clone();
    ids.extend(context.history.keys().cloned());
    ids
}

/// TS insertTopCandidate：分数降序 → fuzzy 升序 → 归一化标题 → 命令 id。
fn insert_top_candidate(
    documents: &[SearchDocument],
    top: &mut Vec<RankedCandidate>,
    candidate: RankedCandidate,
    limit: usize,
) {
    if top.len() == limit {
        if let Some(worst) = top.last() {
            if compare_candidates(documents, &candidate, worst) != std::cmp::Ordering::Less {
                return;
            }
        }
    }
    let insert_at = top
        .iter()
        .position(|existing| {
            compare_candidates(documents, &candidate, existing) == std::cmp::Ordering::Less
        })
        .unwrap_or(top.len());
    top.insert(insert_at, candidate);
    top.truncate(limit);
}

fn compare_candidates(
    documents: &[SearchDocument],
    left: &RankedCandidate,
    right: &RankedCandidate,
) -> std::cmp::Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| {
            left.fuzzy_score
                .partial_cmp(&right.fuzzy_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .then_with(|| {
            documents[left.document_index]
                .normalized_title
                .cmp(&documents[right.document_index].normalized_title)
        })
        .then_with(|| {
            documents[left.document_index]
                .command
                .id
                .cmp(&documents[right.document_index].command.id)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::types::{CommandAction, CommandActionType, CommandPayload, CommandSource};
    use crate::search::ranking::{HistoryEntry, RankingContext};

    fn command(id: &str, source: CommandSource, title: &str, keywords: &[&str]) -> Command {
        Command {
            id: id.into(),
            source,
            title: title.into(),
            subtitle: None,
            keywords: keywords.iter().map(|k| k.to_string()).collect(),
            icon: None,
            plugin_id: None,
            action: CommandAction {
                action_type: CommandActionType::OpenApp,
                payload: CommandPayload::new(),
            },
        }
    }

    fn engine() -> SearchEngine {
        SearchEngine::new(vec![
            command(
                "app.vscode",
                CommandSource::App,
                "Visual Studio Code",
                &["code", "编辑器"],
            ),
            command(
                "app.calculator",
                CommandSource::App,
                "Calculator",
                &["计算器"],
            ),
            command("sys.settings", CommandSource::System, "Settings", &["设置"]),
        ])
    }

    #[test]
    fn empty_query_returns_all_ranked() {
        let results = engine().search("", SearchOptions::default());
        assert_eq!(results.len(), 3);
        // System 来源分最高，排最前
        assert_eq!(results[0].command.id, "sys.settings");
    }

    #[test]
    fn exact_substring_beats_fuzzy() {
        let results = engine().search("code", SearchOptions::default());
        assert_eq!(results[0].command.id, "app.vscode");
        assert_eq!(results[0].fuzzy_score, 0.0);
    }

    #[test]
    fn fuzzy_subsequence_matches() {
        let results = engine().search("vsc", SearchOptions::default());
        assert!(results.iter().any(|r| r.command.id == "app.vscode"));
    }

    #[test]
    fn limit_is_respected() {
        let results = engine().search(
            "",
            SearchOptions {
                limit: Some(2),
                ..Default::default()
            },
        );
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn pinned_candidate_requires_text_match() {
        let mut context = RankingContext::default();
        context.pinned_command_ids.insert("app.calculator".into());
        let results = engine().search(
            "zzz-no-match",
            SearchOptions {
                ranking: Some(&context),
                ..Default::default()
            },
        );
        // TS searchEngine.ts: boostedFuse.search(normalizedQuery) only yields matches.
        assert!(results.is_empty());
    }

    #[test]
    fn history_candidate_requires_text_match() {
        let mut context = RankingContext::default();
        context.history.insert(
            "app.calculator".into(),
            HistoryEntry {
                execution_count: 500,
                last_used_at_ms: None,
            },
        );
        let results = engine().search(
            "zzz-no-match",
            SearchOptions {
                ranking: Some(&context),
                ..Default::default()
            },
        );
        assert!(results.is_empty());
    }

    #[test]
    fn boosted_fuzzy_candidate_outside_normal_window_appears_only_once() {
        // TS getBoostedDocuments collects pinned/history IDs in a Set before searching.
        // Equal fuzzy scores leave shared.149 outside the normal 100-candidate window.
        let commands = (0..150)
            .map(|index| {
                command(
                    &format!("shared.{index:03}"),
                    CommandSource::App,
                    "Visual Studio Code",
                    &[],
                )
            })
            .collect();
        let engine = SearchEngine::new(commands);
        for (pinned, history) in [(true, false), (false, true), (true, true)] {
            let mut context = RankingContext::default();
            if pinned {
                context.pinned_command_ids.insert("shared.149".into());
            }
            if history {
                context.history.insert(
                    "shared.149".into(),
                    HistoryEntry {
                        execution_count: 500,
                        last_used_at_ms: None,
                    },
                );
            }
            let results = engine.search(
                "vsc",
                SearchOptions {
                    limit: Some(2),
                    ranking: Some(&context),
                    ..Default::default()
                },
            );
            assert_eq!(results.len(), 2);
            assert_eq!(results[0].command.id, "shared.149");
            assert_ne!(results[0].command.id, results[1].command.id);
            assert!(!results[0].matched_by.is_empty());
        }
    }

    #[test]
    fn search_punctuation_does_not_enable_pattern_operators() {
        // TS createFuseOptions does not enable extended search. Launcher input is text.
        for query in ["!", "^", "$", "'", "!missing", "^visual", "code$"] {
            assert!(
                engine().search(query, SearchOptions::default()).is_empty(),
                "unexpected operator matches for {query:?}"
            );
        }
    }

    #[test]
    fn punctuation_participates_in_fuzzy_matching() {
        for (query, title) in [
            ("!alpha", "! a l p h a"),
            ("^alpha", "^ a l p h a"),
            ("alpha$", "a l p h a $"),
            ("'alpha", "' a l p h a"),
        ] {
            let engine = SearchEngine::new(vec![
                command("literal", CommandSource::App, title, &[]),
                command("plain", CommandSource::App, "alpha", &[]),
            ]);
            let results = engine.search(query, SearchOptions::default());
            assert_eq!(results.len(), 1, "query: {query:?}");
            assert_eq!(results[0].command.id, "literal");
        }
    }

    #[test]
    fn history_boosts_ranking() {
        let mut context = RankingContext::default();
        context.history.insert(
            "app.calculator".into(),
            HistoryEntry {
                execution_count: 500,
                last_used_at_ms: None,
            },
        );
        let engine = engine();
        let boosted = engine.search(
            "",
            SearchOptions {
                ranking: Some(&context),
                ..Default::default()
            },
        );
        let plain = engine.search("", SearchOptions::default());
        let boosted_pos = boosted
            .iter()
            .position(|r| r.command.id == "app.calculator")
            .unwrap();
        let plain_pos = plain
            .iter()
            .position(|r| r.command.id == "app.calculator")
            .unwrap();
        assert!(boosted_pos < plain_pos);
    }

    #[test]
    fn upsert_and_remove_update_index() {
        let mut engine = engine();
        engine.upsert(command("app.notepad", CommandSource::App, "Notepad", &[]));
        assert!(engine
            .search("notepad", SearchOptions::default())
            .iter()
            .any(|r| r.command.id == "app.notepad"));
        assert!(engine.remove("app.notepad"));
        assert!(!engine
            .search("notepad", SearchOptions::default())
            .iter()
            .any(|r| r.command.id == "app.notepad"));
    }
}
