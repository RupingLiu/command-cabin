//! 排序层。移植自 packages/core/src/search/ranking.ts，常量与公式逐项保留。

use std::collections::{HashMap, HashSet};

use crate::command::types::{Command, CommandSource};

use super::tokenize::normalize_search_text;

pub mod field_weights {
    pub const TITLE: f64 = 0.3;
    pub const SUBTITLE: f64 = 0.2;
    pub const KEYWORDS: f64 = 0.1;
    pub const EMPTY_QUERY: f64 = 0.0;
}

pub mod ranking_boosts {
    pub const EXACT_TITLE: f64 = 0.4;
    pub const PINNED: f64 = 0.35;
    pub const RECENT: f64 = 0.25;
    pub const HISTORY_SCALE: f64 = 0.08;
    pub const MAX_HISTORY: f64 = 0.3;
}

pub fn default_source_weight(source: CommandSource) -> f64 {
    match source {
        CommandSource::System => 0.16,
        CommandSource::App => 0.14,
        CommandSource::Url => 0.1,
        CommandSource::File => 0.06,
        CommandSource::Plugin => 0.04,
    }
}

pub const RECENT_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const SCORE_PRECISION: f64 = 1_000_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SearchMatchField {
    Title,
    Subtitle,
    Keywords,
    EmptyQuery,
}

impl SearchMatchField {
    pub fn weight(self) -> f64 {
        match self {
            Self::Title => field_weights::TITLE,
            Self::Subtitle => field_weights::SUBTITLE,
            Self::Keywords => field_weights::KEYWORDS,
            Self::EmptyQuery => field_weights::EMPTY_QUERY,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchMatchedBy {
    pub field: SearchMatchField,
    pub indices: Vec<(usize, usize)>,
    pub value: Option<String>,
    pub ref_index: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct HistoryEntry {
    pub execution_count: u64,
    /// Unix 毫秒时间戳。
    pub last_used_at_ms: Option<i64>,
}

#[derive(Debug, Default)]
pub struct RankingContext {
    pub pinned_command_ids: HashSet<String>,
    pub history: HashMap<String, HistoryEntry>,
    pub source_weights: Option<HashMap<CommandSource, f64>>,
    pub history_weight: Option<f64>,
    /// Unix 毫秒时间戳；缺省不计算 recent 分量（与 TS 一致）。
    pub now_ms: Option<i64>,
}

pub struct RankingInput<'a> {
    pub command: Command,
    pub query: String,
    pub normalized_query: Option<&'a str>,
    pub normalized_title: Option<&'a str>,
    /// 越低越好的模糊匹配分（TS 为 Fuse score，0 = 完全匹配）。
    pub fuse_score: f64,
    pub matched_by: Vec<SearchMatchedBy>,
    pub context: Option<&'a RankingContext>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankingComponents {
    pub fuzzy: f64,
    pub field: f64,
    pub source: f64,
    pub history: f64,
    pub pinned: f64,
    pub recent: f64,
    pub exact_title: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryDebug {
    pub execution_count: u64,
    pub last_used_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankingExplanation {
    pub components: RankingComponents,
    pub normalized_query: String,
    pub normalized_title: String,
    pub matched_fields: Vec<SearchMatchField>,
    pub history: Option<HistoryDebug>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankingResult {
    /// 越高越靠前。
    pub score: f64,
    pub explanation: RankingExplanation,
}

/// 非负分数下与 JS Math.round 行为一致（均为远离零方向的最近整数）。
fn round_score(value: f64) -> f64 {
    (value * SCORE_PRECISION).round() / SCORE_PRECISION
}

fn normalize_fuse_score(fuse_score: f64) -> f64 {
    if !fuse_score.is_finite() {
        return 0.0;
    }
    (1.0 - fuse_score).clamp(0.0, 1.0)
}

fn unique_matched_fields(matched_by: &[SearchMatchedBy]) -> Vec<SearchMatchField> {
    let mut fields: Vec<SearchMatchField> = Vec::new();
    for matched in matched_by {
        if !fields.contains(&matched.field) {
            fields.push(matched.field);
        }
    }
    fields
}

fn score_matched_fields(matched_by: &[SearchMatchedBy]) -> f64 {
    unique_matched_fields(matched_by)
        .iter()
        .map(|field| field.weight())
        .sum()
}

fn normalize_weight(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(v) if v.is_finite() => v.max(0.0),
        _ => fallback,
    }
}

fn score_history(execution_count: u64) -> f64 {
    ((execution_count as f64).ln_1p() * ranking_boosts::HISTORY_SCALE)
        .min(ranking_boosts::MAX_HISTORY)
}

fn score_recent_use(entry: Option<&HistoryEntry>, context: Option<&RankingContext>) -> f64 {
    let (Some(now), Some(last_used)) = (
        context.and_then(|c| c.now_ms),
        entry.and_then(|e| e.last_used_at_ms),
    ) else {
        return 0.0;
    };
    let age_ms = (now - last_used).max(0) as u64;
    if age_ms >= RECENT_WINDOW_MS {
        return 0.0;
    }
    ranking_boosts::RECENT * (1.0 - age_ms as f64 / RECENT_WINDOW_MS as f64)
}

pub fn rank_search_candidate(input: &RankingInput) -> RankingResult {
    let normalized_query = input
        .normalized_query
        .map(str::to_string)
        .unwrap_or_else(|| normalize_search_text(&input.query));
    let normalized_title = input
        .normalized_title
        .map(str::to_string)
        .unwrap_or_else(|| normalize_search_text(&input.command.title));
    let history_entry = input
        .context
        .and_then(|context| context.history.get(&input.command.id));
    let history_weight = normalize_weight(input.context.and_then(|c| c.history_weight), 1.0);

    let components = RankingComponents {
        fuzzy: round_score(normalize_fuse_score(input.fuse_score)),
        field: round_score(score_matched_fields(&input.matched_by)),
        source: round_score(normalize_weight(
            input
                .context
                .and_then(|c| c.source_weights.as_ref())
                .and_then(|weights| weights.get(&input.command.source).copied()),
            default_source_weight(input.command.source),
        )),
        history: round_score(
            score_history(history_entry.map_or(0, |entry| entry.execution_count)) * history_weight,
        ),
        pinned: if input
            .context
            .is_some_and(|c| c.pinned_command_ids.contains(&input.command.id))
        {
            ranking_boosts::PINNED
        } else {
            0.0
        },
        recent: round_score(score_recent_use(history_entry, input.context) * history_weight),
        exact_title: if !normalized_query.is_empty() && normalized_query == normalized_title {
            ranking_boosts::EXACT_TITLE
        } else {
            0.0
        },
    };

    let score = round_score(
        components.fuzzy
            + components.field
            + components.source
            + components.history
            + components.pinned
            + components.recent
            + components.exact_title,
    );

    RankingResult {
        score,
        explanation: RankingExplanation {
            components,
            normalized_query,
            normalized_title,
            matched_fields: unique_matched_fields(&input.matched_by),
            history: history_entry.map(|entry| HistoryDebug {
                execution_count: entry.execution_count,
                last_used_at_ms: entry.last_used_at_ms,
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::types::tests::sample_command;

    fn input(
        command: Command,
        fuse_score: f64,
        matched_by: Vec<SearchMatchedBy>,
    ) -> RankingInput<'static> {
        RankingInput {
            command,
            query: "code".into(),
            normalized_query: None,
            normalized_title: None,
            fuse_score,
            matched_by,
            context: None,
        }
    }

    fn title_match() -> Vec<SearchMatchedBy> {
        vec![SearchMatchedBy {
            field: SearchMatchField::Title,
            indices: vec![(0, 3)],
            value: Some("Code".into()),
            ref_index: None,
        }]
    }

    #[test]
    fn exact_title_gets_boost() {
        // 与 TS 测试一致：query 归一化后需等于标题归一化结果，故标题取 "Code" 匹配 query "code"。
        let mut command = sample_command("a", CommandSource::App);
        command.title = "Code".into();
        let result = rank_search_candidate(&input(command, 0.0, title_match()));
        assert_eq!(result.explanation.components.exact_title, 0.4);
        assert_eq!(result.explanation.components.fuzzy, 1.0);
        assert_eq!(result.explanation.components.source, 0.14);
        assert_eq!(result.explanation.components.field, 0.3);
    }

    #[test]
    fn fuzzy_score_is_inverted_and_clamped() {
        let command = sample_command("a", CommandSource::App);
        let result = rank_search_candidate(&input(command.clone(), 2.5, Vec::new()));
        assert_eq!(result.explanation.components.fuzzy, 0.0);
        let result = rank_search_candidate(&input(command, f64::NAN, Vec::new()));
        assert_eq!(result.explanation.components.fuzzy, 0.0);
    }

    #[test]
    fn history_scales_logarithmically_with_cap() {
        let mut context = RankingContext::default();
        context.history.insert(
            "a".into(),
            HistoryEntry {
                execution_count: 10_000_000,
                last_used_at_ms: None,
            },
        );
        let command = sample_command("a", CommandSource::App);
        let mut ranked = input(command, 0.0, Vec::new());
        ranked.context = Some(&context);
        let result = rank_search_candidate(&ranked);
        assert_eq!(result.explanation.components.history, 0.3); // maxHistory 封顶
    }

    #[test]
    fn recent_use_decays_linearly_and_expires() {
        let now_ms = 1_800_000_000_000i64;
        let mut context = RankingContext {
            now_ms: Some(now_ms),
            ..RankingContext::default()
        };
        context.history.insert(
            "a".into(),
            HistoryEntry {
                execution_count: 1,
                last_used_at_ms: Some(now_ms - RECENT_WINDOW_MS as i64 - 1),
            },
        );
        let command = sample_command("a", CommandSource::App);
        let mut ranked = input(command, 0.0, Vec::new());
        ranked.context = Some(&context);
        assert_eq!(
            rank_search_candidate(&ranked).explanation.components.recent,
            0.0
        );
    }

    #[test]
    fn pinned_boost_applies() {
        let mut context = RankingContext::default();
        context.pinned_command_ids.insert("a".into());
        let command = sample_command("a", CommandSource::App);
        let mut ranked = input(command, 0.0, Vec::new());
        ranked.context = Some(&context);
        assert_eq!(
            rank_search_candidate(&ranked).explanation.components.pinned,
            0.35
        );
    }

    #[test]
    fn total_score_is_sum_of_components_rounded() {
        let command = sample_command("a", CommandSource::App);
        let result = rank_search_candidate(&input(command, 0.4, title_match()));
        let c = &result.explanation.components;
        let expected =
            c.fuzzy + c.field + c.source + c.history + c.pinned + c.recent + c.exact_title;
        assert!((result.score - expected).abs() < 1e-9);
    }
}
