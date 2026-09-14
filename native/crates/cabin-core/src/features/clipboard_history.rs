//! 剪贴板历史命令构造。移植自
//! `packages/built-in-plugins/clipboard-history/src/index.ts` 的命令部分
//! （`createClipboardHistoryCommands` / `createClipboardHistoryCommandId` /
//! `isClipboardHistoryCommandId` 与相关常量）。
//!
//! 语义保真要点：
//! - 命令形态（TS `index.ts` 全量）：每个历史条目一条命令，无独立的
//!   "clear" 命令（TS 的仓储 `clear()` 由桌面 launcher 服务直接调用，不构造
//!   命令；确认语义在桌面接线层，不属本模块）。
//!   - id：`clipboard-history.entry.{entryId}`；
//!   - source：`plugin`，pluginId：`clipboard-history`；
//!   - title：固定 `Clipboard History`（所有条目相同，靠 subtitle 区分）；
//!   - subtitle：预览文本（见下）；keywords：`["clip", "clipboard", "history", preview]`；
//!   - action：`copy-text`，payload `{ text: entry.text }`（原文完整回拷）。
//! - 预览截断窗口与长度上限均按 JS `string.length`（UTF-16 码元数）计：
//!   先取原文前 200 个码元（`MAX_CLIPBOARD_PREVIEW_WINDOW`），把 `\s+`
//!   折叠为单个空格并 trim；若仍超过 93 个码元则取前 92 个码元加 `...`
//!   （TS `MAX_CLIPBOARD_PREVIEW_LENGTH - 1`）。窗口外的空白不会被折叠
//!   （TS 测试 "only processes a truncated window" 锁定该行为）。
//! - `\s` 与 `trim()` 采用 ECMAScript WhiteSpace + LineTerminator 字符集
//!   （与 features::calculator 的 `is_js_whitespace` 相同集合；storage 侧的
//!   clipboard 仓储持有一份等价私有实现，跨 crate 不互引）。

pub mod watcher;

use crate::command::types::{
    Command, CommandAction, CommandActionType, CommandPayload, CommandSource,
};

/// TS `CLIPBOARD_HISTORY_PLUGIN_ID`。
pub const CLIPBOARD_HISTORY_PLUGIN_ID: &str = "clipboard-history";
/// TS `CLIPBOARD_HISTORY_COMMAND_PREFIX`。
pub const CLIPBOARD_HISTORY_COMMAND_PREFIX: &str = "clipboard-history.entry.";

const MAX_CLIPBOARD_PREVIEW_LENGTH: usize = 93;
const MAX_CLIPBOARD_PREVIEW_WINDOW: usize = 200;

/// TS `ClipboardHistoryEntry` 的最小视图（命令构造只读取 id 与 text；
/// copied_at 随形状保留，供调用方对齐 cabin-storage 条目）。
#[derive(Debug, Clone, PartialEq)]
pub struct ClipboardHistoryEntry {
    pub id: i64,
    pub text: String,
    pub copied_at: String,
}

/// TS `createClipboardHistoryCommandId`。
pub fn create_clipboard_history_command_id(entry_id: i64) -> String {
    format!("{CLIPBOARD_HISTORY_COMMAND_PREFIX}{entry_id}")
}

/// TS `isClipboardHistoryCommandId`。
pub fn is_clipboard_history_command_id(command_id: &str) -> bool {
    command_id.starts_with(CLIPBOARD_HISTORY_COMMAND_PREFIX)
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

/// TS `text.slice(0, max)`：按 UTF-16 码元截断（字符边界整字符截取，见
/// storage clipboard 模块的同名偏差说明）。
fn slice_utf16(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for character in text.chars() {
        let length = character.len_utf16();
        if units + length > max {
            break;
        }
        units += length;
        out.push(character);
    }
    out
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// TS `truncatePreview`：窗口截断 → `/\s+/g` → `' '` → trim → 93 码元上限。
fn truncate_preview(text: &str) -> String {
    let window = slice_utf16(text, MAX_CLIPBOARD_PREVIEW_WINDOW);

    let mut single_line = String::new();
    let mut in_whitespace_run = false;
    for character in window.chars() {
        if is_js_whitespace(character) {
            in_whitespace_run = true;
            continue;
        }
        if in_whitespace_run {
            single_line.push(' ');
            in_whitespace_run = false;
        }
        single_line.push(character);
    }
    // TS 在折叠后 trim；折叠本身已去掉首尾空白 run，但窗口可能以空白开头。
    let single_line = js_trim(&single_line).to_string();

    if utf16_len(&single_line) <= MAX_CLIPBOARD_PREVIEW_LENGTH {
        return single_line;
    }

    format!(
        "{}...",
        slice_utf16(&single_line, MAX_CLIPBOARD_PREVIEW_LENGTH - 1)
    )
}

/// TS `createClipboardHistoryCommands`：每个条目一条 `copy-text` 命令。
pub fn create_clipboard_history_commands(entries: &[ClipboardHistoryEntry]) -> Vec<Command> {
    entries
        .iter()
        .map(|entry| {
            let preview = truncate_preview(&entry.text);
            let mut payload = CommandPayload::new();
            payload.insert("text".into(), entry.text.clone().into());

            Command {
                id: create_clipboard_history_command_id(entry.id),
                source: CommandSource::Plugin,
                title: "Clipboard History".to_string(),
                subtitle: Some(preview.clone()),
                keywords: vec![
                    "clip".to_string(),
                    "clipboard".to_string(),
                    "history".to_string(),
                    preview,
                ],
                icon: None,
                plugin_id: Some(CLIPBOARD_HISTORY_PLUGIN_ID.to_string()),
                action: CommandAction {
                    action_type: CommandActionType::CopyText,
                    payload,
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: i64, text: &str) -> ClipboardHistoryEntry {
        ClipboardHistoryEntry {
            id,
            text: text.to_string(),
            copied_at: "2026-07-30T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn command_ids_use_prefix_and_match_predicate() {
        assert_eq!(
            create_clipboard_history_command_id(7),
            "clipboard-history.entry.7"
        );
        assert!(is_clipboard_history_command_id("clipboard-history.entry.7"));
        assert!(is_clipboard_history_command_id("clipboard-history.entry."));
        assert!(!is_clipboard_history_command_id("clipboard-history"));
        assert!(!is_clipboard_history_command_id("clipboard.entry.7"));
    }

    #[test]
    fn creates_copy_text_commands_with_plugin_shape() {
        let commands = create_clipboard_history_commands(&[entry(3, "  copied value \n")]);

        assert_eq!(commands.len(), 1);
        let command = &commands[0];
        assert_eq!(command.id, "clipboard-history.entry.3");
        assert_eq!(command.source, CommandSource::Plugin);
        assert_eq!(command.title, "Clipboard History");
        assert_eq!(command.subtitle.as_deref(), Some("copied value"));
        assert_eq!(
            command.keywords,
            vec![
                "clip".to_string(),
                "clipboard".to_string(),
                "history".to_string(),
                "copied value".to_string(),
            ]
        );
        assert_eq!(command.plugin_id.as_deref(), Some("clipboard-history"));
        assert_eq!(command.action.action_type, CommandActionType::CopyText);
        // action 携带完整原文（含首尾空白），预览仅用于 subtitle/keywords。
        assert_eq!(
            command
                .action
                .payload
                .get("text")
                .and_then(|value| value.as_str()),
            Some("  copied value \n")
        );
    }

    #[test]
    fn creates_one_command_per_entry() {
        let commands = create_clipboard_history_commands(&[entry(1, "a"), entry(2, "b")]);
        assert_eq!(
            commands
                .iter()
                .map(|command| command.id.as_str())
                .collect::<Vec<_>>(),
            vec!["clipboard-history.entry.1", "clipboard-history.entry.2"]
        );
        assert_eq!(commands[1].subtitle.as_deref(), Some("b"));
    }

    #[test]
    fn truncates_long_text_to_window_length_in_tests() {
        // 对齐 TS 测试 "runs real package-scoped tests ..."：超长文本保存后
        // 命令 id/keywords 形态正常，keywords 不携带全文。
        let long_text = "A".repeat(20_001);
        let commands = create_clipboard_history_commands(&[entry(9, &long_text)]);
        let command = &commands[0];
        assert!(command.id.starts_with("clipboard-history.entry."));
        let joined = command.keywords.join("");
        assert_ne!(joined.encode_utf16().count(), 20_001);
        // 200 A 的窗口折叠后仍超 93 码元 → 前 92 A + "..."。
        assert_eq!(
            command.subtitle.as_deref(),
            Some(&*format!("{}...", "A".repeat(92)))
        );
    }

    #[test]
    fn only_processes_a_truncated_window_when_building_previews_for_long_texts() {
        let long_text = format!("a{}{}", " ".repeat(1_000), "Z".repeat(50));
        let commands = create_clipboard_history_commands(&[entry(1, &long_text)]);

        // 200 码元窗口之外（'Z' 串）不参与折叠，因此尾部 'Z' 不会进入预览。
        let command = &commands[0];
        assert_eq!(command.subtitle.as_deref(), Some("a"));
        assert!(!command.keywords.join(" ").contains('Z'));
    }

    #[test]
    fn preview_appends_ellipsis_when_folded_text_exceeds_max_length() {
        // 100 个 'a'：折叠后 100 码元 > 93 → 取前 92 码元 + '...'。
        let commands = create_clipboard_history_commands(&[entry(1, &"a".repeat(100))]);
        assert_eq!(
            commands[0].subtitle.as_deref(),
            Some(&*format!("{}...", "a".repeat(92)))
        );
    }

    #[test]
    fn preview_handles_whitespace_only_and_empty_text() {
        let commands = create_clipboard_history_commands(&[entry(1, " \r\n\t "), entry(2, "")]);
        assert_eq!(commands[0].subtitle.as_deref(), Some(""));
        assert_eq!(commands[1].subtitle.as_deref(), Some(""));
    }

    #[test]
    fn preview_counts_utf16_units_for_astral_boundaries() {
        // 星面字符占 2 个码元：92 个码元边界落在字符中间时整字符截取。
        let astral = "\u{1F600}".repeat(60); // 120 码元
        let commands = create_clipboard_history_commands(&[entry(1, &astral)]);
        let subtitle = commands[0].subtitle.as_deref().expect("subtitle");
        assert_eq!(utf16_len(subtitle), 95); // 46 个 emoji（92 码元）+ "..."（3）
        assert!(subtitle.ends_with("..."));
    }
}
