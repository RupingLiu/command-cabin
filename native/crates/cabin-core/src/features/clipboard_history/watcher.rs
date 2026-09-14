//! 剪贴板轮询纯逻辑。移植自
//! `packages/built-in-plugins/clipboard-history/src/clipboardWatcher.ts`
//! 的决策核心（`DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS` /
//! `normalizeClipboardTextForComparison` / poll 的空值-去重-产出顺序）。
//!
//! TS 的 watcher 是闭包工厂（timer + `activePoll` 串行化 + `onText` 回调）；
//! Rust 侧拆成"纯决策函数 + 定时器所有者"两半，本模块只含前者（无 I/O、
//! 无时钟、无回调），定时器所有权在 cabin-app（M4 Task 7 接线）：
//! Slint Timer 以 `DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS`（1000ms）间隔驱动，
//! 每次 tick 调 `ClipboardReader::read_text` 并把结果交给 [`poll_step`]；
//! `poll_step` 返回 `Some(原文)` 即 TS 的 `onText(text)`。
//!
//! TS 语义逐条对齐（clipboardWatcher.ts）：
//! - 归一化 = `text.trim()`（ECMAScript 字符集，复用父模块的
//!   `js_trim`）；`lastNormalizedText` 存归一化后的文本，`onText` 收原文。
//! - poll 顺序：normalize → `length === 0 || normalized === lastNormalized`
//!   跳过 → `onText(原文)` → 记录归一化文本。空值检查先于重复比较（TS
//!   初值 `''` 与空串相等的分支被空值短路先行吸收，因此 Rust 用
//!   `last_text: Option<String>`（None = 尚无产出）与 TS 行为等价）。
//! - 读错误（TS readText 抛错 → onError）与读侧 `Ok(None)`（非文本内容）
//!   都由定时器所有者在调用 [`poll_step`] 前处理/上报；`poll_step` 的
//!   `None` 输入表示"本 tick 无文本"，不改写 `last_text`——对应 TS 错误
//!   路径不改写 `lastNormalizedText`。
//! - `activePoll` 串行化（在飞 poll 期间并发 poll 返回同一 promise）与
//!   start/stop（start 幂等且立即 poll 一次；stop 清 timer 并 `await`
//!   在飞 poll）同样是定时器所有者职责：若某次 read 尚未返回，跳过重叠
//!   的 tick（等价 TS 返回在飞 promise），stop 时等待在飞读结束。

/// TS `DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS`。
pub const DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS: u64 = 1_000;

/// 轮询决策的可变状态（TS `lastNormalizedText` + `intervalMs` 闭包变量）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollState {
    /// 最近一次产出的归一化（JS trim）文本；None = 尚无产出。
    pub last_text: Option<String>,
    /// 轮询间隔毫秒。`poll_step` 不消费；供定时器所有者取用。
    pub interval_ms: u64,
}

impl Default for PollState {
    fn default() -> Self {
        Self {
            last_text: None,
            interval_ms: DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS,
        }
    }
}

/// 单次 tick 决策：`current` 是定时器所有者读到的剪贴板文本（`None` =
/// 非文本内容，或读错误已由所有者上报）。返回 `Some(原文)` 表示应产出
/// （TS `onText(text)`），`None` 表示跳过（空/重复/无文本）。
///
/// 去重按归一化（JS trim）文本比较，与 TS `lastNormalizedText` 一致；
/// 原文可能带首尾空白，产出时原样返回（`state.last_text` 存归一化文本）。
pub fn poll_step(state: &mut PollState, current: Option<String>) -> Option<String> {
    let text = current?;
    let normalized = super::js_trim(&text);
    if normalized.is_empty() || state.last_text.as_deref() == Some(normalized) {
        return None;
    }
    state.last_text = Some(normalized.to_string());
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_interval_matches_ts_constant() {
        assert_eq!(DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS, 1_000);
        assert_eq!(
            PollState::default(),
            PollState {
                last_text: None,
                interval_ms: 1_000,
            }
        );
    }

    #[test]
    fn first_non_empty_text_emits_original_and_records_normalized() {
        let mut state = PollState::default();
        let emitted = poll_step(&mut state, Some("  hello world \n".to_string()));
        // TS onText 收原文（未 trim）……
        assert_eq!(emitted.as_deref(), Some("  hello world \n"));
        // ……状态存归一化文本。
        assert_eq!(state.last_text.as_deref(), Some("hello world"));
    }

    #[test]
    fn unchanged_text_is_skipped() {
        let mut state = PollState::default();
        poll_step(&mut state, Some("copy".to_string()));
        assert_eq!(poll_step(&mut state, Some("copy".to_string())), None);
        assert_eq!(state.last_text.as_deref(), Some("copy"));
    }

    #[test]
    fn whitespace_only_difference_is_deduplicated() {
        let mut state = PollState::default();
        assert_eq!(
            poll_step(&mut state, Some("  value  ".to_string())).as_deref(),
            Some("  value  ")
        );
        // 仅首尾空白不同的重复拷贝按 TS trim 语义跳过。
        assert_eq!(poll_step(&mut state, Some("value".to_string())), None);
        assert_eq!(
            poll_step(&mut state, Some("\t value \r\n".to_string())),
            None
        );
    }

    #[test]
    fn empty_and_whitespace_only_reads_are_skipped() {
        let mut state = PollState::default();
        assert_eq!(poll_step(&mut state, Some(String::new())), None);
        assert_eq!(poll_step(&mut state, Some("   ".to_string())), None);
        assert_eq!(poll_step(&mut state, Some(" \r\n\t ".to_string())), None);
        // 空值跳过不改写状态。
        assert_eq!(state.last_text, None);
    }

    #[test]
    fn none_read_is_skipped_without_touching_state() {
        let mut state = PollState::default();
        poll_step(&mut state, Some("kept".to_string()));
        // 非文本内容 / 读错误已由定时器所有者上报：等价 TS 错误路径不改写
        // lastNormalizedText，后续同值仍应跳过。
        assert_eq!(poll_step(&mut state, None), None);
        assert_eq!(state.last_text.as_deref(), Some("kept"));
        assert_eq!(poll_step(&mut state, Some("kept".to_string())), None);
    }

    #[test]
    fn changed_text_after_skips_emits_again() {
        let mut state = PollState::default();
        poll_step(&mut state, Some("first".to_string()));
        poll_step(&mut state, Some(String::new()));
        poll_step(&mut state, None);
        let emitted = poll_step(&mut state, Some("second".to_string()));
        assert_eq!(emitted.as_deref(), Some("second"));
        assert_eq!(state.last_text.as_deref(), Some("second"));
    }

    #[test]
    fn same_text_with_interior_whitespace_only_differs_by_trim() {
        let mut state = PollState::default();
        // 中部空白参与比较：两者归一化后不同 → 产出原文。
        assert_eq!(
            poll_step(&mut state, Some("a\nb".to_string())).as_deref(),
            Some("a\nb")
        );
        assert_eq!(
            poll_step(&mut state, Some("a b".to_string())).as_deref(),
            Some("a b")
        );
        // "a\nb" 与 "a b" 归一化都非彼此（trim 只去首尾），互不吞并。
        assert_eq!(state.last_text.as_deref(), Some("a b"));
    }
}
