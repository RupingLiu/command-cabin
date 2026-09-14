//! 剪贴板历史仓储。移植自
//! `packages/built-in-plugins/clipboard-history/src/clipboardRepository.ts`。
//! `clipboard_history` 表由迁移 3 创建（id AUTOINCREMENT、text UNIQUE、
//! copied_at），迁移 5 追加 `normalized_text NOT NULL DEFAULT ''` 列与索引。
//!
//! 语义保真要点（与 favorites/history 端口同一约定）：
//!
//! - `save_text`：先把文本按 UTF-16 码元截断到 `CLIPBOARD_HISTORY_MAX_TEXT_LENGTH`
//!   （TS `slice(0, 20_000)`，**截断而非拒存**）；`normalized_text` =
//!   `text.trim()`（JS trim 字符集，非 Rust `char::is_whitespace`——多
//!   `\u{FEFF}`、缺 `\u{85}`）。trim 后为空 → 返回 `None`（不落库）。
//! - 去重优先按 `normalized_text` 查重（`LIMIT 1`）：命中则整行 UPDATE
//!   （text、normalized_text、copied_at 全部刷新为新值，id 不变）；未命中
//!   则 `INSERT ... ON CONFLICT(text) DO UPDATE SET copied_at =
//!   excluded.copied_at`（该分支仅在 normalized_text 查重漏掉而 text 撞
//!   UNIQUE 时触发，例如迁移 5 之前的旧行 normalized_text 为默认 `''`；
//!   此时 normalized_text **保持旧值**，与 TS 一致）。整个
//!   查重-写入-修剪过程在单事务内完成。
//! - 每次 save 后修剪：保留 `copied_at DESC, id DESC` 前
//!   `MAX_CLIPBOARD_HISTORY_LIMIT`（200）行，其余删除。
//! - `list_recent`：`ORDER BY copied_at DESC, id DESC`，limit clamp 到
//!   `min(limit, 200)`；TS 的“safe integer >= 0”运行时校验由 `u32` 类型层
//!   接管（偏差同 history.rs）。
//! - `search`：查询串 trim + 截断到 20_000；空查询退化为 `list_recent`；
//!   否则 `text LIKE '%pattern%' ESCAPE '\'`，pattern 中的 `\`、`%`、`_`
//!   逐字转义（与 TS `escapeLikePattern` 一致；LIKE 对 ASCII 大小写不敏感，
//!   语义由同一 SQLite 引擎保证）。
//! - `copied_at` 形态校验 + 原样存储（M2 T4/T5 先例）：非法形态报 TS 原文
//!   `Invalid clipboard history copiedAt date: {value}`；`None` 由 `iso_now`
//!   生成规范 UTC ISO。
//! - 读路径行校验逐字移植 TS `validateClipboardHistoryRow` 报错文案。
//! - TS 接口全量为 `saveText` / `listRecent` / `search` / `clear` 四个方法；
//!   任务简报中的 `remove(id)` / `count` 在 TS 中不存在（桌面侧只用
//!   `listRecent` 与 `clear`），因此不移植。

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::StorageError;
use crate::migrations::iso_now;
use crate::timestamp::is_iso8601_timestamp;

/// TS `DEFAULT_CLIPBOARD_HISTORY_LIMIT`。
pub const DEFAULT_CLIPBOARD_HISTORY_LIMIT: u32 = 20;
/// TS `MAX_CLIPBOARD_HISTORY_LIMIT`。
pub const MAX_CLIPBOARD_HISTORY_LIMIT: u32 = 200;
/// TS `CLIPBOARD_HISTORY_MAX_TEXT_LENGTH`。
pub const CLIPBOARD_HISTORY_MAX_TEXT_LENGTH: usize = 20_000;

/// TS `ClipboardHistoryEntry`。
#[derive(Debug, Clone, PartialEq)]
pub struct ClipboardHistoryEntry {
    pub id: i64,
    pub text: String,
    pub copied_at: String,
}

fn invalid_clipboard(message: impl Into<String>) -> StorageError {
    StorageError::InvalidClipboardHistory(message.into())
}

/// TS `normalizeClipboardTextForComparison`：JS `String.prototype.trim()`。
/// 字符集为 ECMAScript WhiteSpace + LineTerminator（与 calculator 的
/// `is_js_whitespace` 相同集合，跨 crate 各持一份私有实现）。
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

/// TS `truncateClipboardText`：按 UTF-16 码元截断到
/// `CLIPBOARD_HISTORY_MAX_TEXT_LENGTH`。偏差：TS `slice` 可把星面字符
/// （surrogate pair）截成孤立代理项；Rust `String` 无法表示，故在字符
/// 边界整字符截断（同一输入在 20_000 边界附近的行为差异仅限此场景）。
fn truncate_clipboard_text(text: &str) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for character in text.chars() {
        let length = character.len_utf16();
        if units + length > CLIPBOARD_HISTORY_MAX_TEXT_LENGTH {
            break;
        }
        units += length;
        out.push(character);
    }
    out
}

/// TS `normalizeClipboardSearchQuery`：trim + 截断（同上按 UTF-16 计）。
fn normalize_clipboard_search_query(query: &str) -> String {
    truncate_clipboard_text(js_trim(query))
}

/// TS `escapeLikePattern`：`\`、`%`、`_` 逐一转义。
fn escape_like_pattern(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(character);
    }
    out
}

/// TS `normalizeDate` 的形态校验版（偏差见模块文档）：
/// `None` → 当前时间；否则校验 ISO 8601 形态并原样保留。
fn normalize_copied_at(value: Option<&str>) -> Result<String, StorageError> {
    match value {
        None => Ok(iso_now()),
        Some(raw) if is_iso8601_timestamp(raw) => Ok(raw.to_string()),
        Some(raw) => Err(invalid_clipboard(format!(
            "Invalid clipboard history copiedAt date: {raw}"
        ))),
    }
}

/// 数据库行形态（TS 只取 `id, text, copied_at` 三列）。
struct ClipboardHistoryRow {
    id: i64,
    text: String,
    copied_at: String,
}

fn read_clipboard_history_row(row: &rusqlite::Row) -> rusqlite::Result<ClipboardHistoryRow> {
    Ok(ClipboardHistoryRow {
        id: row.get(0)?,
        text: row.get(1)?,
        copied_at: row.get(2)?,
    })
}

/// TS `validateClipboardHistoryRow` + `mapClipboardHistoryRow`：报错文案逐字。
fn map_clipboard_history_row(
    row: ClipboardHistoryRow,
) -> Result<ClipboardHistoryEntry, StorageError> {
    // TS：`!Number.isSafeInteger(row.id) || row.id <= 0`。
    if row.id <= 0 || row.id.abs() > 9_007_199_254_740_991 {
        return Err(invalid_clipboard(format!(
            "Invalid clipboard history row {}: id must be a positive integer",
            row.id
        )));
    }

    // TS：`typeof row.text !== 'string' || row.text.length === 0`（length 为
    // UTF-16 码元数）。
    if row.text.encode_utf16().count() == 0 {
        return Err(invalid_clipboard(format!(
            "Invalid clipboard history row {}: text must be a non-empty string",
            row.id
        )));
    }

    if row.text.encode_utf16().count() > CLIPBOARD_HISTORY_MAX_TEXT_LENGTH {
        return Err(invalid_clipboard(format!(
            "Invalid clipboard history row {}: text exceeds maximum length",
            row.id
        )));
    }

    // TS：`new Date(row.copied_at)` 有限性检查 → 形态校验（偏差见模块文档）。
    if !is_iso8601_timestamp(&row.copied_at) {
        return Err(invalid_clipboard(format!(
            "Invalid clipboard history row {}: copied_at must be a valid date",
            row.id
        )));
    }

    Ok(ClipboardHistoryEntry {
        id: row.id,
        text: row.text,
        copied_at: row.copied_at,
    })
}

/// 剪贴板历史仓储（TS `createClipboardHistoryRepository`）。无缓存。
pub struct ClipboardHistoryRepository<'a> {
    conn: &'a Connection,
}

impl<'a> ClipboardHistoryRepository<'a> {
    pub fn new(conn: &'a Connection) -> ClipboardHistoryRepository<'a> {
        ClipboardHistoryRepository { conn }
    }

    /// TS `saveText`：截断 → trim 归一 → 单事务内（normalized 查重更新 /
    /// UNIQUE 冲突更新 copied_at / 新插入 → 修剪到 200 行）→ 按 text 回读
    /// 并做行校验。trim 后为空返回 `None`（不落库）。
    pub fn save_text(
        &self,
        text: &str,
        copied_at: Option<&str>,
    ) -> Result<Option<ClipboardHistoryEntry>, StorageError> {
        let text = truncate_clipboard_text(text);
        let normalized_text = js_trim(&text).to_string();

        if normalized_text.is_empty() {
            return Ok(None);
        }

        let copied_at = normalize_copied_at(copied_at)?;

        let transaction = self.conn.unchecked_transaction()?;
        // TS `selectByNormalizedText ... LIMIT 1`。
        let duplicate: Option<i64> = transaction
            .query_row(
                "SELECT id FROM clipboard_history WHERE normalized_text = ?1 LIMIT 1",
                params![normalized_text],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(id) = duplicate {
            transaction.execute(
                "UPDATE clipboard_history
                 SET text = ?1, normalized_text = ?2, copied_at = ?3
                 WHERE id = ?4",
                params![text, normalized_text, copied_at, id],
            )?;
        } else {
            transaction.execute(
                "INSERT INTO clipboard_history (text, normalized_text, copied_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(text) DO UPDATE SET
                   copied_at = excluded.copied_at",
                params![text, normalized_text, copied_at],
            )?;
        }

        // TS `pruneOldRows(MAX_CLIPBOARD_HISTORY_LIMIT)`。
        transaction.execute(
            "DELETE FROM clipboard_history
             WHERE id NOT IN (
               SELECT id FROM clipboard_history
               ORDER BY copied_at DESC, id DESC
               LIMIT ?1
             )",
            params![MAX_CLIPBOARD_HISTORY_LIMIT],
        )?;
        transaction.commit()?;

        // TS：事务后按 text 回读；读不到即抛
        // `Clipboard history entry was not saved.`（防御性）。
        let row = self
            .conn
            .query_row(
                "SELECT id, text, copied_at FROM clipboard_history WHERE text = ?1",
                params![text],
                read_clipboard_history_row,
            )
            .optional()?
            .ok_or_else(|| invalid_clipboard("Clipboard history entry was not saved."))?;
        map_clipboard_history_row(row).map(Some)
    }

    /// TS `listRecent`：`ORDER BY copied_at DESC, id DESC`，limit clamp 到
    /// `MAX_CLIPBOARD_HISTORY_LIMIT`（TS 默认 20 由常量承担）。
    pub fn list_recent(&self, limit: u32) -> Result<Vec<ClipboardHistoryEntry>, StorageError> {
        let limit = limit.min(MAX_CLIPBOARD_HISTORY_LIMIT);
        let mut statement = self.conn.prepare(
            "SELECT id, text, copied_at
             FROM clipboard_history
             ORDER BY copied_at DESC, id DESC
             LIMIT ?1",
        )?;
        let rows = statement
            .query_map(params![limit], read_clipboard_history_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(map_clipboard_history_row).collect()
    }

    /// TS `search`：空查询（trim 后）退化为 `listRecent`；否则子串
    /// `LIKE '%…%' ESCAPE '\'`，同序同 clamp。
    pub fn search(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<ClipboardHistoryEntry>, StorageError> {
        let normalized_query = normalize_clipboard_search_query(query);

        if normalized_query.is_empty() {
            return self.list_recent(limit);
        }

        let limit = limit.min(MAX_CLIPBOARD_HISTORY_LIMIT);
        let pattern = format!("%{}%", escape_like_pattern(&normalized_query));
        let mut statement = self.conn.prepare(
            "SELECT id, text, copied_at
             FROM clipboard_history
             WHERE text LIKE ?1 ESCAPE '\\'
             ORDER BY copied_at DESC, id DESC
             LIMIT ?2",
        )?;
        let rows = statement
            .query_map(params![pattern, limit], read_clipboard_history_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(map_clipboard_history_row).collect()
    }

    /// TS `clear`：删除全部行，返回受影响行数。
    pub fn clear(&self) -> Result<usize, StorageError> {
        Ok(self.conn.execute("DELETE FROM clipboard_history", [])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        crate::migrations::run_migrations(&conn).expect("run migrations");
        conn
    }

    fn save(repository: &ClipboardHistoryRepository, text: &str) -> ClipboardHistoryEntry {
        repository
            .save_text(text, None)
            .expect("save")
            .expect("entry returned for non-whitespace text")
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM clipboard_history", [], |row| {
            row.get(0)
        })
        .expect("count")
    }

    fn expect_invalid_clipboard(err: &StorageError, expected_message: &str) {
        match err {
            StorageError::InvalidClipboardHistory(message) => {
                assert_eq!(message, expected_message)
            }
            other => panic!("expected InvalidClipboardHistory, got {other:?}"),
        }
    }

    #[test]
    fn limit_constants_match_ts() {
        assert_eq!(DEFAULT_CLIPBOARD_HISTORY_LIMIT, 20);
        assert_eq!(MAX_CLIPBOARD_HISTORY_LIMIT, 200);
        assert_eq!(CLIPBOARD_HISTORY_MAX_TEXT_LENGTH, 20_000);
    }

    // ---- save_text ---------------------------------------------------------

    #[test]
    fn save_inserts_entry_with_generated_iso_timestamp_and_returns_it() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);

        let entry = save(&repository, "hello");
        assert!(entry.id >= 1);
        assert_eq!(entry.text, "hello");
        assert!(
            entry.copied_at.ends_with('Z') && entry.copied_at.contains('T'),
            "expected ISO 8601 UTC, got {:?}",
            entry.copied_at
        );
    }

    #[test]
    fn save_preserves_original_whitespace_but_ignores_whitespace_only_text() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);

        assert!(repository
            .save_text(" \r\n\t ", None)
            .expect("save")
            .is_none());

        let original_text = "  copied value\r\nwith trailing whitespace  \n";
        let entry = save(&repository, original_text);
        assert_eq!(entry.text, original_text);

        let entries = repository
            .list_recent(DEFAULT_CLIPBOARD_HISTORY_LIMIT)
            .expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, original_text);
    }

    #[test]
    fn save_truncates_text_beyond_max_length() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);

        let long_text = "A".repeat(CLIPBOARD_HISTORY_MAX_TEXT_LENGTH + 1);
        let entry = save(&repository, &long_text);
        assert_eq!(
            entry.text.encode_utf16().count(),
            CLIPBOARD_HISTORY_MAX_TEXT_LENGTH
        );
    }

    #[test]
    fn save_rejects_invalid_copied_at_with_ts_message() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);

        let err = repository
            .save_text("hello", Some("not-a-date"))
            .expect_err("bad copied_at rejected");
        expect_invalid_clipboard(&err, "Invalid clipboard history copiedAt date: not-a-date");

        let err = repository
            .save_text("hello", Some("2026-02-30T00:00:00.000Z"))
            .expect_err("invalid calendar date rejected");
        expect_invalid_clipboard(
            &err,
            "Invalid clipboard history copiedAt date: 2026-02-30T00:00:00.000Z",
        );
        assert_eq!(count(&conn), 0, "rejected input must not be written");
    }

    #[test]
    fn save_accepts_valid_copied_at_shape_and_stores_it_unchanged() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);

        let entry = repository
            .save_text("hello", Some("2026-07-29T00:00:00.000Z"))
            .expect("save")
            .expect("entry");
        assert_eq!(entry.copied_at, "2026-07-29T00:00:00.000Z");
    }

    // ---- 去重（normalized_text）与 UNIQUE 冲突 -------------------------------

    #[test]
    fn save_updates_one_normalized_duplicate_with_the_latest_original_text() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);

        let first = repository
            .save_text("duplicate", Some("2026-07-29T00:00:00.000Z"))
            .expect("save")
            .expect("first");
        let latest_text = "\tduplicate \r\n";
        let latest = repository
            .save_text(latest_text, Some("2026-07-30T00:00:00.000Z"))
            .expect("save")
            .expect("latest");

        assert_eq!(latest.id, first.id);
        assert_eq!(latest.text, latest_text);

        let entries = repository
            .list_recent(DEFAULT_CLIPBOARD_HISTORY_LIMIT)
            .expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, first.id);
        assert_eq!(entries[0].text, latest_text);
        assert_eq!(entries[0].copied_at, "2026-07-30T00:00:00.000Z");
    }

    #[test]
    fn save_updates_a_normalized_duplicate_without_growing_the_table() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);

        let first = repository
            .save_text("a", Some("2026-07-29T00:00:00.000Z"))
            .expect("save")
            .expect("first");
        let second = repository
            .save_text("a ", Some("2026-07-30T00:00:00.000Z"))
            .expect("save")
            .expect("second");

        assert_eq!(second.id, first.id);
        assert_eq!(second.text, "a ");
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn save_same_text_updates_copied_at_in_place() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);

        let first = repository
            .save_text("same text", Some("2026-07-29T00:00:00.000Z"))
            .expect("save")
            .expect("first");
        let second = repository
            .save_text("same text", Some("2026-07-30T00:00:00.000Z"))
            .expect("save")
            .expect("second");

        assert_eq!(second.id, first.id);
        assert_eq!(second.copied_at, "2026-07-30T00:00:00.000Z");
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn save_hits_text_unique_conflict_when_normalized_lookup_misses() {
        // 迁移 5 之前的旧行 normalized_text 为默认 ''：normalized 查重漏掉、
        // text 撞 UNIQUE → `ON CONFLICT(text) DO UPDATE SET copied_at`（仅刷
        // copied_at，normalized_text 保持旧值——与 TS 逐字对齐）。
        let conn = open_db();
        conn.execute(
            "INSERT INTO clipboard_history (text, normalized_text, copied_at)
             VALUES ('legacy', '', '2026-07-01T00:00:00.000Z')",
            [],
        )
        .expect("insert legacy row");
        let repository = ClipboardHistoryRepository::new(&conn);

        let entry = repository
            .save_text("legacy", Some("2026-07-30T00:00:00.000Z"))
            .expect("save")
            .expect("entry");
        assert_eq!(entry.id, 1);
        assert_eq!(entry.copied_at, "2026-07-30T00:00:00.000Z");
        assert_eq!(count(&conn), 1);

        let normalized_text: String = conn
            .query_row(
                "SELECT normalized_text FROM clipboard_history WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("normalized_text");
        assert_eq!(
            normalized_text, "",
            "upsert must not rewrite normalized_text"
        );
    }

    #[test]
    fn keeps_deduplicating_and_pruning_correctly_with_many_entries() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);

        for index in 0..250 {
            save(&repository, &format!("entry-{index}"));
        }
        assert_eq!(
            count(&conn),
            200,
            "table is pruned to the cap on every save"
        );

        // 最老的 entry-0 已被修剪，normalized 查重落空 → 作为新行插入，
        // 表保持在 200 行上限。
        let duplicate = save(&repository, "entry-0 ");
        assert_eq!(duplicate.text, "entry-0 ");
        assert_eq!(count(&conn), 200);
    }

    // ---- list_recent ---------------------------------------------------------

    #[test]
    fn list_recent_orders_by_copied_at_desc_then_id_desc() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);

        for (text, copied_at) in [
            ("old", "2026-07-01T00:00:00.000Z"),
            ("tie-first", "2026-07-03T00:00:00.000Z"),
            ("new", "2026-07-04T00:00:00.000Z"),
            ("tie-second", "2026-07-03T00:00:00.000Z"),
        ] {
            repository
                .save_text(text, Some(copied_at))
                .expect("save")
                .expect("entry");
        }

        let entries = repository
            .list_recent(DEFAULT_CLIPBOARD_HISTORY_LIMIT)
            .expect("list");
        let order: Vec<&str> = entries.iter().map(|entry| entry.text.as_str()).collect();
        assert_eq!(order, vec!["new", "tie-second", "tie-first", "old"]);
    }

    #[test]
    fn list_recent_honours_limit_and_clamps_to_max() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);
        for index in 0..250u32 {
            repository
                .save_text(&format!("entry-{index:03}"), None)
                .expect("save")
                .expect("entry");
        }

        assert_eq!(
            repository.list_recent(2).expect("list").len(),
            2,
            "explicit limit honoured"
        );
        assert_eq!(
            repository.list_recent(u32::MAX).expect("list").len(),
            MAX_CLIPBOARD_HISTORY_LIMIT as usize,
            "limit clamps to 200"
        );
        assert!(repository.list_recent(0).expect("list").is_empty());

        // 默认条数语义：恰好取最新 20 条。
        let default_entries = repository
            .list_recent(DEFAULT_CLIPBOARD_HISTORY_LIMIT)
            .expect("list");
        assert_eq!(
            default_entries.len(),
            DEFAULT_CLIPBOARD_HISTORY_LIMIT as usize
        );
        assert_eq!(default_entries[0].text, "entry-249");
    }

    #[test]
    fn list_recent_rejects_stored_rows_with_ts_row_validation_messages() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);
        save(&repository, "good");
        // 绕过仓储写入坏 copied_at（模拟外部损坏）。
        conn.execute(
            "INSERT INTO clipboard_history (text, normalized_text, copied_at)
             VALUES ('broken', 'broken', 'not-a-date')",
            [],
        )
        .expect("insert broken row");

        let err = repository
            .list_recent(DEFAULT_CLIPBOARD_HISTORY_LIMIT)
            .expect_err("broken copied_at rejected");
        expect_invalid_clipboard(
            &err,
            "Invalid clipboard history row 2: copied_at must be a valid date",
        );
    }

    // ---- search ---------------------------------------------------------

    #[test]
    fn search_matches_substring_and_orders_recently_first() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);
        for (text, copied_at) in [
            ("alpha command", "2026-07-01T00:00:00.000Z"),
            ("beta ALPHA note", "2026-07-02T00:00:00.000Z"),
            ("gamma", "2026-07-03T00:00:00.000Z"),
        ] {
            repository
                .save_text(text, Some(copied_at))
                .expect("save")
                .expect("entry");
        }

        let hits = repository
            .search("alpha", DEFAULT_CLIPBOARD_HISTORY_LIMIT)
            .expect("search");
        let order: Vec<&str> = hits.iter().map(|entry| entry.text.as_str()).collect();
        // SQLite LIKE 对 ASCII 大小写不敏感；新条目在前。
        assert_eq!(order, vec!["beta ALPHA note", "alpha command"]);

        assert!(repository
            .search("zzz-absent", DEFAULT_CLIPBOARD_HISTORY_LIMIT)
            .expect("search")
            .is_empty());
    }

    #[test]
    fn search_escapes_like_metacharacters() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);
        save(&repository, "50%_off");
        save(&repository, "50aXoff");
        save(&repository, "plain path");

        // '%' 与 '_' 必须按字面量匹配：LIKE 转义后 '50%_off' 只命中自身。
        let hits = repository
            .search("50%_off", DEFAULT_CLIPBOARD_HISTORY_LIMIT)
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "50%_off");

        let hits = repository
            .search("path", DEFAULT_CLIPBOARD_HISTORY_LIMIT)
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "plain path");
    }

    #[test]
    fn search_with_blank_query_falls_back_to_list_recent() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);
        save(&repository, "first");
        save(&repository, "second");

        let hits = repository
            .search("  \r\n\t ", DEFAULT_CLIPBOARD_HISTORY_LIMIT)
            .expect("search");
        let order: Vec<&str> = hits.iter().map(|entry| entry.text.as_str()).collect();
        assert_eq!(order, vec!["second", "first"]);
    }

    // ---- clear ---------------------------------------------------------

    #[test]
    fn clear_deletes_every_row_and_reports_the_number_of_removed_rows() {
        let conn = open_db();
        let repository = ClipboardHistoryRepository::new(&conn);
        save(&repository, "a");
        save(&repository, "b");
        save(&repository, "c");

        assert_eq!(repository.clear().expect("clear"), 3);
        assert_eq!(count(&conn), 0);
        assert_eq!(repository.clear().expect("clear again"), 0);
    }
}
