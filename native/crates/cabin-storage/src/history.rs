//! 命令执行历史仓储。移植自 `packages/core/src/storage/historyRepository.ts`
//! 的 `recordExecution` / `listRecentForRanking` / `removeByCommandId`。
//! `command_history` 表由迁移 1 创建。
//!
//! 已知偏差（与 favorites 端口同一约定，见 favorites.rs 模块文档）：
//!
//! - TS 的 `executedAt` 接受 `Date | string` 并经由 `new Date(v).toISOString()`
//!   归一化（接受额外 JS 日期格式、把偏移换算为 UTC）。本端口只接受
//!   ISO 8601 形态字符串（含范围校验）并原样存储；`None` 由 `iso_now`
//!   生成规范 UTC ISO。非法形态报 TS 原文
//!   `Invalid date for command history recordExecution executedAt: {value}`。
//! - TS 读路径把 `source` 当字符串原样透传；本端口在
//!   `list_recent_for_ranking` / `record_execution` 读路径将其解析为
//!   `CommandSource`（类型层要求），无法解析时报错。该报错无 TS 对应物。
//! - TS 的 limit 运行时校验（safe integer >= 0）由 `u32` 类型层接管，
//!   仅保留 clamp 到 `MAX_RECENT_HISTORY_LIMIT`。
//! - 写路径 “metadata 必须是 JSON object” 由 `Map<String, Value>` 类型层
//!   保证；读路径（`record_execution` 的 RETURNING）仍按 TS
//!   `mapCommandHistoryRow` 校验存储形态。
//! - `getByCommandId` / `listRecent` / `clear` 不在 M2 任务范围，未移植。

use rusqlite::{named_params, params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use cabin_core::command::types::CommandSource;

use crate::error::StorageError;
use crate::migrations::iso_now;
use crate::timestamp::is_iso8601_timestamp;

/// TS `DEFAULT_RECENT_HISTORY_LIMIT`。
pub const DEFAULT_RECENT_HISTORY_LIMIT: u32 = 20;
/// TS `MAX_RECENT_HISTORY_LIMIT`。
pub const MAX_RECENT_HISTORY_LIMIT: u32 = 100;

/// TS `RecordCommandExecutionInput`。
#[derive(Debug, Clone, PartialEq)]
pub struct RecordExecution<'a> {
    pub command_id: &'a str,
    pub title: &'a str,
    pub source: CommandSource,
    pub subtitle: Option<&'a str>,
    /// ISO 8601；`None` = 当前时间。
    pub executed_at: Option<&'a str>,
    /// 缺省 `{}`；“必须是 JSON object” 由类型层保证。
    pub metadata: Option<&'a Map<String, Value>>,
}

/// TS `CommandHistoryEntry`。
#[derive(Debug, Clone, PartialEq)]
pub struct CommandHistoryEntry {
    pub id: i64,
    pub command_id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub source: CommandSource,
    pub execution_count: u64,
    pub executed_at: String,
    pub metadata: Map<String, Value>,
}

fn invalid_history(message: impl Into<String>) -> StorageError {
    StorageError::InvalidCommandHistory(message.into())
}

/// TS `formatStorageValueContext({ table: 'command_history', field, commandId })`。
fn history_field_context(field: &str, command_id: &str) -> String {
    format!("command_history {field} for command \"{command_id}\"")
}

/// TS `normalizeStorageDate` 的形态校验版（偏差见模块文档）：
/// `None` → 当前时间；否则校验 ISO 8601 形态并原样保留。
fn normalize_executed_at(value: Option<&str>) -> Result<String, StorageError> {
    match value {
        None => Ok(iso_now()),
        Some(raw) if is_iso8601_timestamp(raw) => Ok(raw.to_string()),
        Some(raw) => Err(invalid_history(format!(
            "Invalid date for command history recordExecution executedAt: {raw}"
        ))),
    }
}

/// 数据库行形态（TS `CommandHistoryRow`）。
struct CommandHistoryRow {
    id: i64,
    command_id: String,
    title: String,
    subtitle: Option<String>,
    source: String,
    execution_count: i64,
    executed_at: String,
    metadata: String,
}

fn read_command_history_row(row: &rusqlite::Row) -> rusqlite::Result<CommandHistoryRow> {
    Ok(CommandHistoryRow {
        id: row.get(0)?,
        command_id: row.get(1)?,
        title: row.get(2)?,
        subtitle: row.get(3)?,
        source: row.get(4)?,
        execution_count: row.get(5)?,
        executed_at: row.get(6)?,
        metadata: row.get(7)?,
    })
}

/// 读路径 source 解析（偏差：TS 透传字符串，见模块文档）。
fn parse_stored_source(raw: &str, command_id: &str) -> Result<CommandSource, StorageError> {
    CommandSource::parse(raw).ok_or_else(|| {
        invalid_history(format!(
            "Invalid command history source in {}: unsupported source",
            history_field_context("source", command_id)
        ))
    })
}

/// 存储的 execution_count 经 CHECK (execution_count > 0) 保证为正；
/// 转换为 u64 的失败分支为防御性代码。
fn stored_execution_count(value: i64, command_id: &str) -> Result<u64, StorageError> {
    u64::try_from(value).map_err(|_| {
        invalid_history(format!(
            "Invalid command history execution count in {}: must be positive",
            history_field_context("execution_count", command_id)
        ))
    })
}

/// TS `mapCommandHistoryRow`：读路径校验 metadata 必须是 JSON object。
fn map_command_history_row(row: &CommandHistoryRow) -> Result<CommandHistoryEntry, StorageError> {
    let context = history_field_context("metadata", &row.command_id);
    let value: Value = serde_json::from_str(&row.metadata)
        .map_err(|err| invalid_history(format!("Invalid JSON in {context}: {err}")))?;
    let metadata = value.as_object().cloned().ok_or_else(|| {
        invalid_history(format!(
            "Invalid command history metadata in {context}: metadata must be an object"
        ))
    })?;

    Ok(CommandHistoryEntry {
        id: row.id,
        command_id: row.command_id.clone(),
        title: row.title.clone(),
        subtitle: row.subtitle.clone(),
        source: parse_stored_source(&row.source, &row.command_id)?,
        execution_count: stored_execution_count(row.execution_count, &row.command_id)?,
        executed_at: row.executed_at.clone(),
        metadata,
    })
}

/// 历史仓储（TS `createHistoryRepository`）。无缓存。
pub struct HistoryRepository<'a> {
    conn: &'a Connection,
}

impl<'a> HistoryRepository<'a> {
    pub fn new(conn: &'a Connection) -> HistoryRepository<'a> {
        HistoryRepository { conn }
    }

    /// TS `recordExecution`：UPSERT（`ON CONFLICT(command_id)`），冲突时
    /// title/subtitle/source/executed_at/metadata 刷新为新值，
    /// execution_count 在旧值上 +1。RETURNING 回读整行并做读路径校验。
    pub fn record_execution(
        &self,
        input: RecordExecution,
    ) -> Result<CommandHistoryEntry, StorageError> {
        let executed_at = normalize_executed_at(input.executed_at)?;
        let metadata = input.metadata.cloned().unwrap_or_default();
        // 已校验的 metadata（类型层保证是 object）序列化不会失败
        // （TS `stringifyStorageJson`）。
        let metadata_json =
            serde_json::to_string(&metadata).expect("serializing history metadata cannot fail");

        let row = self
            .conn
            .query_row(
                "
                INSERT INTO command_history (
                    command_id,
                    title,
                    subtitle,
                    source,
                    execution_count,
                    executed_at,
                    metadata
                )
                VALUES (
                    @commandId,
                    @title,
                    @subtitle,
                    @source,
                    1,
                    @executedAt,
                    @metadata
                )
                ON CONFLICT(command_id) DO UPDATE SET
                    title = excluded.title,
                    subtitle = excluded.subtitle,
                    source = excluded.source,
                    execution_count = command_history.execution_count + 1,
                    executed_at = excluded.executed_at,
                    metadata = excluded.metadata
                RETURNING id, command_id, title, subtitle, source, execution_count, executed_at, metadata
                ",
                named_params! {
                    "@commandId": input.command_id,
                    "@title": input.title,
                    "@subtitle": input.subtitle,
                    "@source": input.source.as_str(),
                    "@executedAt": executed_at,
                    "@metadata": metadata_json,
                },
                read_command_history_row,
            )
            .optional()?;

        // TS：UPSERT 未返回行则报 `Command history entry was not saved: {id}`（防御性）。
        let row = row.ok_or_else(|| {
            invalid_history(format!(
                "Command history entry was not saved: {}",
                input.command_id
            ))
        })?;
        map_command_history_row(&row)
    }

    /// TS `listRecentForRanking`：`ORDER BY executed_at DESC, id DESC`，
    /// limit clamp 到 `MAX_RECENT_HISTORY_LIMIT`。
    ///
    /// 返回 `(command_id, source, execution_count, executed_at)` 元组，供
    /// 调用方组装 `cabin_core::search::ranking::RankingContext` 的 history
    /// （command_id → execution_count / last_used_at_ms）。
    pub fn list_recent_for_ranking(
        &self,
        limit: u32,
    ) -> Result<Vec<(String, CommandSource, u64, String)>, StorageError> {
        let limit = limit.min(MAX_RECENT_HISTORY_LIMIT);
        let mut stmt = self.conn.prepare(
            "
            SELECT command_id, source, execution_count, executed_at
            FROM command_history
            ORDER BY executed_at DESC, id DESC
            LIMIT ?1
            ",
        )?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        rows.iter()
            .map(|(command_id, source, execution_count, executed_at)| {
                Ok((
                    command_id.clone(),
                    parse_stored_source(source, command_id)?,
                    stored_execution_count(*execution_count, command_id)?,
                    executed_at.clone(),
                ))
            })
            .collect()
    }

    /// TS `removeByCommandId`：返回是否有行被删除。
    pub fn remove(&self, command_id: &str) -> Result<bool, StorageError> {
        Ok(self.conn.execute(
            "DELETE FROM command_history WHERE command_id = ?1",
            params![command_id],
        )? > 0)
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

    fn input(command_id: &str) -> RecordExecution<'_> {
        RecordExecution {
            command_id,
            title: "Command",
            source: CommandSource::App,
            subtitle: None,
            executed_at: None,
            metadata: None,
        }
    }

    fn expect_invalid_history(err: &StorageError, expected_message: &str) {
        match err {
            StorageError::InvalidCommandHistory(message) => assert_eq!(message, expected_message),
            other => panic!("expected InvalidCommandHistory, got {other:?}"),
        }
    }

    fn assert_iso8601(value: &str) {
        assert!(
            value.ends_with('Z') && value.contains('T') && value.len() >= 20,
            "expected ISO 8601 UTC, got {value:?}"
        );
    }

    #[test]
    fn limit_constants_match_ts() {
        assert_eq!(DEFAULT_RECENT_HISTORY_LIMIT, 20);
        assert_eq!(MAX_RECENT_HISTORY_LIMIT, 100);
    }

    // ---- record_execution -------------------------------------------------

    #[test]
    fn record_execution_inserts_new_entry_with_defaults() {
        let conn = open_db();
        let repository = HistoryRepository::new(&conn);

        let entry = repository
            .record_execution(RecordExecution {
                command_id: "app.abc",
                title: "WPS Office",
                source: CommandSource::App,
                subtitle: Some(r"C:\Program Files\WPS\wps.exe"),
                ..input("")
            })
            .expect("record");

        assert!(entry.id >= 1);
        assert_eq!(entry.command_id, "app.abc");
        assert_eq!(entry.title, "WPS Office");
        assert_eq!(
            entry.subtitle.as_deref(),
            Some(r"C:\Program Files\WPS\wps.exe")
        );
        assert_eq!(entry.source, CommandSource::App);
        assert_eq!(entry.execution_count, 1);
        assert_iso8601(&entry.executed_at);
        assert_eq!(entry.metadata, Map::new());
    }

    #[test]
    fn record_execution_upsert_increments_count_and_refreshes_fields() {
        let conn = open_db();
        let repository = HistoryRepository::new(&conn);

        let first = repository
            .record_execution(RecordExecution {
                command_id: "app.abc",
                title: "Old Title",
                subtitle: Some(r"C:\old.exe"),
                source: CommandSource::App,
                executed_at: Some("2026-05-15T10:00:00.000Z"),
                metadata: Some(&Map::from_iter([("color".into(), "blue".into())])),
            })
            .expect("first record");

        let second = repository
            .record_execution(RecordExecution {
                command_id: "app.abc",
                title: "New Title",
                subtitle: None,
                source: CommandSource::System,
                executed_at: Some("2026-05-16T10:00:00.000Z"),
                metadata: Some(&Map::new()),
            })
            .expect("second record");

        // id 稳定（同一行），计数在旧值上 +1，字段刷新为 excluded.*。
        assert_eq!(second.id, first.id);
        assert_eq!(second.execution_count, 2);
        assert_eq!(second.title, "New Title");
        assert_eq!(second.subtitle, None);
        assert_eq!(second.source, CommandSource::System);
        assert_eq!(second.executed_at, "2026-05-16T10:00:00.000Z");
        assert_eq!(second.metadata, Map::new());

        let third = repository
            .record_execution(RecordExecution {
                command_id: "app.abc",
                ..input("")
            })
            .expect("third record");
        assert_eq!(third.id, first.id);
        assert_eq!(third.execution_count, 3);
        assert_eq!(third.title, "Command");
    }

    #[test]
    fn record_execution_round_trips_metadata() {
        let conn = open_db();
        let repository = HistoryRepository::new(&conn);

        let metadata = Map::from_iter([
            ("pluginId".into(), "com.example.plugin".into()),
            ("count".into(), 42.into()),
        ]);
        let entry = repository
            .record_execution(RecordExecution {
                command_id: "plugin.com.example.plugin.cmd",
                source: CommandSource::Plugin,
                metadata: Some(&metadata),
                ..input("")
            })
            .expect("record");

        assert_eq!(entry.metadata, metadata);
    }

    #[test]
    fn record_execution_validates_executed_at_shape_with_ts_message() {
        let conn = open_db();
        let repository = HistoryRepository::new(&conn);

        let err = repository
            .record_execution(RecordExecution {
                command_id: "app.bad",
                executed_at: Some("not-a-date"),
                ..input("")
            })
            .expect_err("bad executed_at rejected");
        expect_invalid_history(
            &err,
            "Invalid date for command history recordExecution executedAt: not-a-date",
        );

        let err = repository
            .record_execution(RecordExecution {
                command_id: "app.bad",
                executed_at: Some("2026-02-29T00:00:00Z"),
                ..input("")
            })
            .expect_err("2026 is not a leap year");
        expect_invalid_history(
            &err,
            "Invalid date for command history recordExecution executedAt: 2026-02-29T00:00:00Z",
        );

        assert!(
            repository
                .list_recent_for_ranking(MAX_RECENT_HISTORY_LIMIT)
                .expect("list")
                .is_empty(),
            "rejected input must not be written"
        );

        // 合法形态原样保留（含偏移，与 favorites 端口同一约定）。
        let entry = repository
            .record_execution(RecordExecution {
                command_id: "app.offset",
                executed_at: Some("2024-02-29T12:30:00+02:00"),
                ..input("")
            })
            .expect("leap day with offset accepted");
        assert_eq!(entry.executed_at, "2024-02-29T12:30:00+02:00");
    }

    // ---- list_recent_for_ranking ------------------------------------------

    #[test]
    fn list_recent_for_ranking_orders_by_executed_at_desc_then_id_desc() {
        let conn = open_db();
        let repository = HistoryRepository::new(&conn);

        for (command_id, executed_at) in [
            ("app.old", "2026-05-15T10:00:00.000Z"),
            ("app.tie-first", "2026-05-17T10:00:00.000Z"),
            ("app.new", "2026-05-18T10:00:00.000Z"),
            ("app.tie-second", "2026-05-17T10:00:00.000Z"),
        ] {
            repository
                .record_execution(RecordExecution {
                    command_id,
                    executed_at: Some(executed_at),
                    ..input("")
                })
                .expect("record");
        }

        let rows = repository
            .list_recent_for_ranking(DEFAULT_RECENT_HISTORY_LIMIT)
            .expect("list");
        let order: Vec<&str> = rows.iter().map(|(id, _, _, _)| id.as_str()).collect();
        // executed_at DESC；并列时 id DESC（后插入的在前）。
        assert_eq!(
            order,
            vec!["app.new", "app.tie-second", "app.tie-first", "app.old"]
        );
        // 元组形态：source / count / executed_at 随行返回。
        let (_, source, count, executed_at) = &rows[0];
        assert_eq!(*source, CommandSource::App);
        assert_eq!(*count, 1);
        assert_eq!(executed_at, "2026-05-18T10:00:00.000Z");
    }

    #[test]
    fn list_recent_for_ranking_honours_limit_and_clamps_to_max() {
        let conn = open_db();
        // 手写批量插入（绕过仓储逐条 upsert，105 行）。
        for i in 0..105 {
            conn.execute(
                "INSERT INTO command_history (command_id, title, source, executed_at)
                 VALUES (?1, 'Command', 'app', ?2)",
                params![
                    format!("app.{i:03}"),
                    format!("2026-05-15T10:{:02}:{:02}.000Z", i / 60, i % 60)
                ],
            )
            .expect("insert");
        }
        let repository = HistoryRepository::new(&conn);

        assert_eq!(
            repository.list_recent_for_ranking(2).expect("list").len(),
            2
        );
        // clamp 到 MAX_RECENT_HISTORY_LIMIT。
        assert_eq!(
            repository
                .list_recent_for_ranking(u32::MAX)
                .expect("list")
                .len(),
            MAX_RECENT_HISTORY_LIMIT as usize
        );
        assert!(repository
            .list_recent_for_ranking(0)
            .expect("list")
            .is_empty());
        // 最新优先。
        let rows = repository
            .list_recent_for_ranking(MAX_RECENT_HISTORY_LIMIT)
            .expect("list");
        assert_eq!(rows[0].0, "app.104");
    }

    #[test]
    fn list_recent_for_ranking_rejects_unknown_stored_source() {
        let conn = open_db();
        conn.execute(
            "INSERT INTO command_history (command_id, title, source, executed_at)
             VALUES ('app.bogus', 'Bogus', 'bogus-source', '2026-05-15T10:00:00.000Z')",
            [],
        )
        .expect("insert");
        let repository = HistoryRepository::new(&conn);

        let err = repository
            .list_recent_for_ranking(DEFAULT_RECENT_HISTORY_LIMIT)
            .expect_err("unknown stored source must fail");
        expect_invalid_history(
            &err,
            "Invalid command history source in command_history source for command \"app.bogus\": unsupported source",
        );
    }

    #[test]
    fn record_execution_upsert_refreshes_corrupted_stored_row() {
        // 读路径（RETURNING 后的 mapCommandHistoryRow）会校验存储的 metadata，
        // 但 upsert 总是用新值刷新 metadata，无法经公共 API 触发该校验 ——
        // 与 favorites 端口一样属防御性代码（TS 同）。此处改为验证：手写坏行
        // 经同 id upsert 后被刷新为合法值，且计数仍在旧值（1）上 +1。
        let conn = open_db();
        conn.execute(
            "INSERT INTO command_history (command_id, title, source, executed_at, metadata)
             VALUES ('app.corrupt', 'Corrupt', 'app', '2026-05-15T10:00:00.000Z', '{bad-json')",
            [],
        )
        .expect("insert");
        let repository = HistoryRepository::new(&conn);

        // upsert 用新 metadata 覆盖坏行；计数仍在旧值（1）上 +1。
        let entry = repository
            .record_execution(RecordExecution {
                command_id: "app.corrupt",
                ..input("")
            })
            .expect("upsert refreshes corrupted row");
        assert_eq!(entry.execution_count, 2);
        assert_eq!(entry.metadata, Map::new());
    }

    // ---- remove -------------------------------------------------------------

    #[test]
    fn remove_deletes_by_command_id_and_reports_whether_a_row_changed() {
        let conn = open_db();
        let repository = HistoryRepository::new(&conn);

        repository
            .record_execution(RecordExecution {
                command_id: "app.abc",
                ..input("")
            })
            .expect("record");

        assert!(repository.remove("app.abc").expect("remove"));
        assert!(!repository.remove("app.abc").expect("remove again"));
        assert!(repository
            .list_recent_for_ranking(DEFAULT_RECENT_HISTORY_LIMIT)
            .expect("list")
            .is_empty());
    }
}
