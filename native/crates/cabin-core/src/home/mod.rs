//! 空查询首页列表合成。移植自
//! `apps/desktop/src/main/launcher/launcherCommandService.ts` 的
//! `listHomeAppSearchResults`（含其子列表 `listRecentAppSearchResults` /
//! `listPinnedAppSearchResults` 的合并语义）。
//!
//! TS 行为链：
//! 1. recent 子列表：按 `executed_at DESC` 遍历历史，仅保留仍注册且为 app
//!    命令的条目，score = executionCount，至多 limit 条；
//! 2. pinned 子列表：按收藏顺序遍历 pinned 命令，仅保留 app 命令，score = 1，
//!    至多 limit 条；
//! 3. 合并：recent 在前、pinned 在后，按身份键
//!    `(subtitle ?? title).trim().replace('/', '\\').toLowerCase()` 去重
//!    （先发先留），截断到 limit。
//!
//! 分工：注册表解析与 app 命令过滤（TS 的 `registry.get` + `isAppCommand`）
//! 由调用方完成（`is_app_command` 在此提供）；本函数负责两个子列表各自的
//! limit 截断、合并、去重与总截断。score 不随结果返回 —— 首页按合成顺序
//! 展示，TS 侧的 score 仅用于结果对象携带。

use std::collections::HashSet;

use crate::command::types::{Command, CommandActionType, CommandSource};

/// 首页结果上限（TS `SEARCH_RESULT_LIMIT`）。
pub const HOME_RESULT_LIMIT: usize = 10;

/// 一条已解析的 recent 历史条目：命令 + 执行次数
/// （TS `listRecentAppSearchResults` 中 `score = entry.executionCount`）。
#[derive(Debug, Clone, PartialEq)]
pub struct HomeRecentEntry {
    pub command: Command,
    pub execution_count: u64,
}

/// TS `isAppCommand`：`source === 'app' && action.type === 'open-app'`。
pub fn is_app_command(command: &Command) -> bool {
    command.source == CommandSource::App && command.action.action_type == CommandActionType::OpenApp
}

/// TS `createAppResultIdentityKey`（作用于 `Command`，字段与 TS 的
/// `LauncherCommandSearchResult` 一致）：`subtitle ?? title`，
/// trim → `/` 归一为 `\` → 小写。
///
/// pub（M5 UI 修复）：native 首页固定磁贴（`cabin-app::state::home_pinned_tiles`）
/// 复用同一身份键做去重，保证"同一应用不重复上首页"的不变量跨列表/网格一致。
pub fn app_result_identity_key(command: &Command) -> String {
    command
        .subtitle
        .as_deref()
        .unwrap_or(&command.title)
        .trim()
        .replace('/', "\\")
        .to_lowercase()
}

/// 空查询首页合成（TS `listHomeAppSearchResults`）。
///
/// 输入约定：`recent` 已按 `executed_at DESC` 排序并完成注册表解析与 app
/// 过滤；`pinned` 为全部 pinned 收藏命令（已完成 app 过滤），顺序与 TS 的
/// `favoriteCommandIds` 迭代顺序一致。
///
/// 两个子列表先各自截断到 `HOME_RESULT_LIMIT`（对齐 TS 子列表内
/// `results.length >= limit` 的提前 break —— 注意这发生在去重之前，去重
/// 释放的名额不会回流到子列表），再按 recent → pinned 顺序按身份键去重，
/// 截断到 `HOME_RESULT_LIMIT`。
pub fn compose_home_list(recent: &[HomeRecentEntry], pinned: &[Command]) -> Vec<Command> {
    let sections = compose_home_sections(recent, pinned);
    sections.recent.into_iter().chain(sections.pinned).collect()
}

/// 首页合成结果的分组形态（M2 Task 10 首页列表分组头）：与 `compose_home_list`
/// 同一条合成流水线，recent / pinned 子列表分别保留，供 UI 为两组渲染
/// "最近使用" / "固定" 分组头。两组拼接后与 `compose_home_list` 的输出逐项相等
/// （见 parity 测试）；条目顺序、去重与截断语义与 TS `listHomeAppSearchResults`
/// 完全一致。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HomeSections {
    pub recent: Vec<Command>,
    pub pinned: Vec<Command>,
}

/// 分组版首页合成（语义与 `compose_home_list` 相同，见其文档）。
pub fn compose_home_sections(recent: &[HomeRecentEntry], pinned: &[Command]) -> HomeSections {
    let mut sections = HomeSections::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut total: usize = 0;

    'recent_loop: for entry in recent.iter().take(HOME_RESULT_LIMIT) {
        let command = &entry.command;
        if total >= HOME_RESULT_LIMIT {
            break;
        }
        if !seen.insert(app_result_identity_key(command)) {
            continue;
        }
        sections.recent.push(command.clone());
        total += 1;
        if total >= HOME_RESULT_LIMIT {
            break 'recent_loop;
        }
    }
    for command in pinned.iter().take(HOME_RESULT_LIMIT) {
        if total >= HOME_RESULT_LIMIT {
            break;
        }
        if !seen.insert(app_result_identity_key(command)) {
            continue;
        }
        sections.pinned.push(command.clone());
        total += 1;
    }

    sections
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::types::{CommandAction, CommandPayload};

    fn app_command(id: &str, title: &str, subtitle: Option<&str>) -> Command {
        Command {
            id: id.into(),
            source: CommandSource::App,
            title: title.into(),
            subtitle: subtitle.map(str::to_string),
            keywords: vec![],
            icon: None,
            plugin_id: None,
            action: CommandAction {
                action_type: CommandActionType::OpenApp,
                payload: CommandPayload::new(),
            },
        }
    }

    fn recent_entry(id: &str, title: &str, subtitle: Option<&str>, count: u64) -> HomeRecentEntry {
        HomeRecentEntry {
            command: app_command(id, title, subtitle),
            execution_count: count,
        }
    }

    fn ids(commands: &[Command]) -> Vec<&str> {
        commands.iter().map(|command| command.id.as_str()).collect()
    }

    #[test]
    fn home_result_limit_matches_ts_search_result_limit() {
        assert_eq!(HOME_RESULT_LIMIT, 10);
    }

    #[test]
    fn is_app_command_requires_app_source_and_open_app_action() {
        let mut command = app_command("a", "App", None);
        assert!(is_app_command(&command));

        command.source = CommandSource::File;
        assert!(!is_app_command(&command));

        command.source = CommandSource::App;
        command.action.action_type = CommandActionType::OpenPath;
        assert!(!is_app_command(&command));
    }

    #[test]
    fn recent_entries_come_before_pinned() {
        let recent = vec![
            recent_entry("r1", "Recent One", Some(r"C:\apps\one.exe"), 5),
            recent_entry("r2", "Recent Two", Some(r"C:\apps\two.exe"), 1),
        ];
        let pinned = vec![
            app_command("p1", "Pinned One", Some(r"C:\apps\pinned-one.exe")),
            app_command("p2", "Pinned Two", Some(r"C:\apps\pinned-two.exe")),
        ];

        let home = compose_home_list(&recent, &pinned);
        assert_eq!(ids(&home), vec!["r1", "r2", "p1", "p2"]);
    }

    #[test]
    fn duplicate_identity_key_recent_wins_over_pinned() {
        // 同一可执行文件：recent（来自索引的 app 命令）与 pinned（收藏命令）
        // 归一化副标题相同，recent 先出现故保留 recent。
        let recent = vec![recent_entry(
            "app.aaa",
            "WPS Office",
            Some(r"C:\Program Files\WPS\wps.exe"),
            3,
        )];
        let pinned = vec![app_command(
            "favorite.bbb",
            "WPS Office",
            Some(r"c:\program files\wps\wps.exe"),
        )];

        let home = compose_home_list(&recent, &pinned);
        assert_eq!(ids(&home), vec!["app.aaa"]);
    }

    #[test]
    fn identity_key_trims_lowercases_and_unifies_slashes() {
        let recent = vec![recent_entry("r1", "Tool", Some("  C:/Apps/Tool.EXE  "), 1)];
        let pinned = vec![app_command("p1", "Tool", Some(r"c:\apps\tool.exe"))];

        let home = compose_home_list(&recent, &pinned);
        assert_eq!(ids(&home), vec!["r1"]);
    }

    #[test]
    fn identity_key_falls_back_to_title_when_subtitle_missing() {
        let recent = vec![recent_entry("r1", "  Code  ", None, 2)];
        let pinned = vec![
            app_command("p1", "code", None), // 与 r1 同键（title 回退）
            app_command("p2", "Other", None),
        ];

        let home = compose_home_list(&recent, &pinned);
        assert_eq!(ids(&home), vec!["r1", "p2"]);
    }

    #[test]
    fn duplicates_within_recent_list_are_deduped_first_wins() {
        let recent = vec![
            recent_entry("r1", "One", Some(r"C:\apps\one.exe"), 9),
            recent_entry("r2", "One Again", Some(r"c:\apps\one.exe"), 1),
            recent_entry("r3", "Three", Some(r"C:\apps\three.exe"), 1),
        ];

        let home = compose_home_list(&recent, &[]);
        assert_eq!(ids(&home), vec!["r1", "r3"]);
    }

    #[test]
    fn combined_list_is_truncated_to_home_result_limit() {
        let recent: Vec<HomeRecentEntry> = (0..8)
            .map(|i| {
                recent_entry(
                    &format!("r{i}"),
                    &format!("Recent {i}"),
                    Some(&format!(r"C:\apps\r{i}.exe")),
                    1,
                )
            })
            .collect();
        let pinned: Vec<Command> = (0..8)
            .map(|i| {
                app_command(
                    &format!("p{i}"),
                    &format!("Pinned {i}"),
                    Some(&format!(r"C:\apps\p{i}.exe")),
                )
            })
            .collect();

        let home = compose_home_list(&recent, &pinned);
        assert_eq!(home.len(), HOME_RESULT_LIMIT);
        assert_eq!(
            ids(&home),
            vec!["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "p0", "p1"]
        );
    }

    #[test]
    fn sub_list_limit_applies_before_dedup_and_does_not_backfill() {
        // TS 语义：recent 子列表先去重前截断到 10。第 11 条 recent（r10）即使
        // 唯一也不会进入合并；r9 与 r0 同键被去重释放的名额流向 pinned。
        let mut recent: Vec<HomeRecentEntry> = (0..9)
            .map(|i| {
                recent_entry(
                    &format!("r{i}"),
                    &format!("Recent {i}"),
                    Some(&format!(r"C:\apps\r{i}.exe")),
                    1,
                )
            })
            .collect();
        // 子列表第 10 条：与 r0 同键（去重时被丢弃）。
        recent.push(recent_entry(
            "r9",
            "Recent 0 Dup",
            Some(r"C:\apps\r0.exe"),
            1,
        ));
        // 子列表第 11 条：唯一但超出子列表 limit，TS 不会看到它。
        recent.push(recent_entry(
            "r10",
            "Recent Ten",
            Some(r"C:\apps\r10.exe"),
            1,
        ));
        let pinned = vec![app_command("p0", "Pinned", Some(r"C:\apps\p0.exe"))];

        let home = compose_home_list(&recent, &pinned);
        assert_eq!(
            ids(&home),
            vec!["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "p0"]
        );
    }

    #[test]
    fn empty_inputs_yield_empty_list() {
        assert!(compose_home_list(&[], &[]).is_empty());
    }

    #[test]
    fn sections_split_matches_flat_list_order() {
        let recent: Vec<HomeRecentEntry> = (0..3)
            .map(|i| {
                recent_entry(
                    &format!("r{i}"),
                    &format!("Recent {i}"),
                    Some(&format!(r"C:\apps\r{i}.exe")),
                    1,
                )
            })
            .collect();
        let pinned: Vec<Command> = (0..4)
            .map(|i| {
                app_command(
                    &format!("p{i}"),
                    &format!("Pinned {i}"),
                    Some(&format!(r"C:\apps\p{i}.exe")),
                )
            })
            .collect();

        let sections = compose_home_sections(&recent, &pinned);
        assert_eq!(ids(&sections.recent), vec!["r0", "r1", "r2"]);
        assert_eq!(ids(&sections.pinned), vec!["p0", "p1", "p2", "p3"]);
        let flattened: Vec<&str> = sections
            .recent
            .iter()
            .chain(&sections.pinned)
            .map(|command| command.id.as_str())
            .collect();
        assert_eq!(flattened, ids(&compose_home_list(&recent, &pinned)));
    }

    #[test]
    fn duplicate_identity_key_recent_wins_and_stays_in_recent_section() {
        let recent = vec![recent_entry("r0", "WPS", Some(r"C:\Apps\wps.exe"), 3)];
        let pinned = vec![
            app_command("p0", "WPS", Some(r"C:\Apps\wps.exe")),
            app_command("p1", "Other", Some(r"C:\Apps\other.exe")),
        ];

        let sections = compose_home_sections(&recent, &pinned);
        assert_eq!(ids(&sections.recent), vec!["r0"]);
        assert_eq!(ids(&sections.pinned), vec!["p1"]);
    }

    #[test]
    fn sections_share_the_total_home_result_cap() {
        let recent: Vec<HomeRecentEntry> = (0..8)
            .map(|i| {
                recent_entry(
                    &format!("r{i}"),
                    &format!("Recent {i}"),
                    Some(&format!(r"C:\apps\r{i}.exe")),
                    1,
                )
            })
            .collect();
        let pinned: Vec<Command> = (0..8)
            .map(|i| {
                app_command(
                    &format!("p{i}"),
                    &format!("Pinned {i}"),
                    Some(&format!(r"C:\apps\p{i}.exe")),
                )
            })
            .collect();

        let sections = compose_home_sections(&recent, &pinned);
        assert_eq!(
            sections.recent.len() + sections.pinned.len(),
            HOME_RESULT_LIMIT
        );
        assert_eq!(
            ids(&sections.recent),
            vec!["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"]
        );
        assert_eq!(ids(&sections.pinned), vec!["p0", "p1"]);
    }

    #[test]
    fn recent_section_can_hold_a_pinned_command_that_appeared_recently() {
        // recent 与 pinned 同命令时 recent 赢；若 recent 里没有重复则它属于 recent 分组。
        let recent = vec![recent_entry("f1", "Pinned App", Some(r"C:\Apps\p.exe"), 2)];
        let sections = compose_home_sections(&recent, &[]);
        assert_eq!(ids(&sections.recent), vec!["f1"]);
        assert!(sections.pinned.is_empty());
    }

    #[test]
    fn empty_sections_when_inputs_empty() {
        let sections = compose_home_sections(&[], &[]);
        assert!(sections.recent.is_empty());
        assert!(sections.pinned.is_empty());
        assert_eq!(sections, HomeSections::default());
    }

    #[test]
    fn sections_parity_with_flat_list_across_duplicate_mixes() {
        // 固定组合（同键跨组/组内重复/总上限边界）上，分组拼接必须与平面合成逐项一致。
        let recent: Vec<HomeRecentEntry> = vec![
            recent_entry("r0", "One", Some(r"C:\Apps\one.exe"), 9),
            recent_entry("r1", "Two", Some(r"C:\apps\two.exe"), 5),
            recent_entry("r2", "One Again", Some(r"c:\apps\one.exe"), 2),
        ];
        let pinned: Vec<Command> = vec![
            app_command("p0", "Two", Some(r"C:\Apps\TWO.EXE")),
            app_command("p1", "Three", Some(r"C:\Apps\three.exe")),
            app_command("p2", "One", Some(r"C:\Apps\one.exe")),
        ];

        let sections = compose_home_sections(&recent, &pinned);
        let flattened: Vec<Command> = sections
            .recent
            .iter()
            .chain(&sections.pinned)
            .cloned()
            .collect();
        assert_eq!(flattened, compose_home_list(&recent, &pinned));
        assert_eq!(ids(&sections.recent), vec!["r0", "r1"]);
        assert_eq!(ids(&sections.pinned), vec!["p1"]);
    }
}
