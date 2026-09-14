//! Migration framework. Ported from `packages/core/src/storage/migrations.ts`.
//!
//! Migration IDs/names are append-only; the SQL is verbatim-identical to the TS
//! version so the existing `command-cabin.sqlite` can be reused.

use rusqlite::Connection;

use crate::error::StorageError;

/// Custom application logic for a migration (e.g. idempotent DDL).
pub type MigrationApplyFn = fn(&Connection, &str) -> Result<(), StorageError>;

/// A single storage migration, mirroring the TS `StorageMigration` shape.
pub struct Migration {
    pub id: i64,
    pub name: &'static str,
    pub sql: &'static str,
    /// Optional custom application logic. When `None`,
    /// the migration runs as a plain `execute_batch(sql)`.
    pub apply: Option<MigrationApplyFn>,
}

/// Storage migrations, verbatim port of the TS `STORAGE_MIGRATIONS` (ids 1-5).
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        id: 1,
        name: "001_initial_storage",
        sql: "
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS command_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                command_id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                subtitle TEXT,
                source TEXT NOT NULL,
                execution_count INTEGER NOT NULL DEFAULT 1 CHECK (execution_count > 0),
                executed_at TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}'
            );

            CREATE INDEX IF NOT EXISTS idx_command_history_executed_at
                ON command_history(executed_at DESC);

            CREATE TABLE IF NOT EXISTS plugins (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                description TEXT,
                main TEXT NOT NULL,
                ui TEXT,
                enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                permissions TEXT NOT NULL DEFAULT '[]',
                installed_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_plugins_name
                ON plugins(name COLLATE NOCASE);

            CREATE TABLE IF NOT EXISTS plugin_data (
                plugin_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (plugin_id, key),
                FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
            );
        ",
        apply: None,
    },
    Migration {
        id: 2,
        name: "002_favorites",
        sql: "
            CREATE TABLE IF NOT EXISTS favorites (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK (kind IN ('file', 'folder', 'url')),
                title TEXT NOT NULL,
                path TEXT,
                url TEXT,
                keywords TEXT NOT NULL DEFAULT '[]',
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                CHECK (
                    (
                        kind IN ('file', 'folder')
                        AND path IS NOT NULL
                        AND length(trim(path)) > 0
                        AND url IS NULL
                    )
                    OR (
                        kind = 'url'
                        AND url IS NOT NULL
                        AND length(trim(url)) > 0
                        AND path IS NULL
                    )
                )
            );

            CREATE INDEX IF NOT EXISTS idx_favorites_title
                ON favorites(title COLLATE NOCASE);
        ",
        apply: None,
    },
    Migration {
        id: 3,
        name: "003_clipboard_history",
        sql: "
            CREATE TABLE IF NOT EXISTS clipboard_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL UNIQUE,
                copied_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_clipboard_history_copied_at
                ON clipboard_history(copied_at DESC);
        ",
        apply: None,
    },
    Migration {
        id: 4,
        name: "004_plugin_root",
        sql: "
            ALTER TABLE plugins
                ADD COLUMN plugin_root TEXT;
        ",
        apply: Some(|database, sql| {
            let mut stmt = database.prepare("PRAGMA table_info(plugins)")?;
            let has_column = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<String>, _>>()?
                .iter()
                .any(|name| name == "plugin_root");
            if !has_column {
                database.execute_batch(sql)?;
            }
            Ok(())
        }),
    },
    Migration {
        id: 5,
        name: "005_clipboard_history_normalized_text",
        sql: "
            ALTER TABLE clipboard_history
                ADD COLUMN normalized_text TEXT NOT NULL DEFAULT '';

            CREATE INDEX idx_clipboard_history_normalized_text
                ON clipboard_history(normalized_text);
        ",
        apply: None,
    },
];

/// Outcome of a `run_migrations` call.
#[derive(Debug, PartialEq, Eq)]
pub struct MigrationResult {
    /// IDs of migrations applied by this call, in application order.
    pub applied_migration_ids: Vec<i64>,
}

/// Validates static migration definitions (TS `validateStorageMigrationDefinitions`).
///
/// Rules: ids are positive safe integers (guaranteed by `i64` for the safe range,
/// so only positivity is checked), strictly increasing, and neither ids nor names
/// may repeat.
pub fn validate_migration_definitions(migrations: &[Migration]) -> Result<(), StorageError> {
    let mut previous_id = 0i64;
    for migration in migrations {
        if migration.id <= 0 {
            return Err(StorageError::InvalidMigrationDefinitions(format!(
                "migration IDs must be positive integers; got {}",
                migration.id
            )));
        }
        if migration.id <= previous_id {
            return Err(StorageError::InvalidMigrationDefinitions(format!(
                "migration IDs must be strictly increasing; {} followed {}",
                migration.id, previous_id
            )));
        }
        if migrations.iter().filter(|m| m.id == migration.id).count() > 1 {
            return Err(StorageError::InvalidMigrationDefinitions(format!(
                "duplicate migration id {}",
                migration.id
            )));
        }
        if migrations
            .iter()
            .filter(|m| m.name == migration.name)
            .count()
            > 1
        {
            return Err(StorageError::InvalidMigrationDefinitions(format!(
                "duplicate migration name \"{}\"",
                migration.name
            )));
        }
        previous_id = migration.id;
    }
    Ok(())
}

/// Verifies already-applied bookkeeping rows against the current definitions
/// (TS `verifyAppliedMigrations`).
fn verify_applied_migrations(
    applied: &[(i64, String)],
    migrations: &[Migration],
) -> Result<(), StorageError> {
    let mut previous_id = 0i64;
    for (id, name) in applied {
        if *id <= 0 || *id <= previous_id {
            return Err(StorageError::InvalidAppliedMigrations(format!(
                "applied migration IDs must be positive and strictly increasing; got {id}"
            )));
        }
        if applied
            .iter()
            .filter(|(other_id, _)| other_id == id)
            .count()
            > 1
            || applied
                .iter()
                .filter(|(_, other_name)| other_name == name)
                .count()
                > 1
        {
            return Err(StorageError::InvalidAppliedMigrations(format!(
                "duplicate applied migration id {id} or name \"{name}\""
            )));
        }
        if let Some(definition) = migrations.iter().find(|m| m.id == *id) {
            if definition.name != name {
                return Err(StorageError::InvalidAppliedMigrations(format!(
                    "migration id {id} was applied as \"{name}\" but current definition is \"{}\"",
                    definition.name
                )));
            }
        }
        if let Some(definition) = migrations.iter().find(|m| m.name == *name) {
            if definition.id != *id {
                return Err(StorageError::InvalidAppliedMigrations(format!(
                    "migration name \"{name}\" was applied with id {id} but current definition uses id {}",
                    definition.id
                )));
            }
        }
        previous_id = *id;
    }
    for (id, name) in applied {
        if !migrations.iter().any(|m| m.id == *id || m.name == *name) {
            return Err(StorageError::InvalidAppliedMigrations(format!(
                "unknown applied migration id {id} with name \"{name}\""
            )));
        }
    }
    Ok(())
}

/// Applies pending migrations, one transaction per migration (TS `runMigrations`).
pub fn run_migrations(database: &Connection) -> Result<MigrationResult, StorageError> {
    validate_migration_definitions(MIGRATIONS)?;

    database.execute_batch(
        "CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL
        );",
    )?;

    let applied: Vec<(i64, String)> = {
        let mut stmt = database.prepare("SELECT id, name FROM migrations ORDER BY rowid")?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        rows
    };

    verify_applied_migrations(&applied, MIGRATIONS)?;

    let mut newly_applied = Vec::new();
    for migration in MIGRATIONS {
        if applied.iter().any(|(id, _)| *id == migration.id) {
            continue;
        }
        let tx = database.unchecked_transaction()?;
        match migration.apply {
            Some(apply) => apply(&tx, migration.sql)?,
            None => tx.execute_batch(migration.sql)?,
        }
        tx.execute(
            "INSERT INTO migrations (id, name, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![migration.id, migration.name, iso_now()],
        )?;
        tx.commit()?;
        newly_applied.push(migration.id);
    }

    Ok(MigrationResult {
        applied_migration_ids: newly_applied,
    })
}

/// ISO 8601 UTC timestamp (same shape as TS `new Date().toISOString()`).
/// Implemented without a third-party time dependency.
pub(crate) fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    civil_from_unix(secs)
}

fn civil_from_unix(secs: u64) -> String {
    // Howard Hinnant's civil-from-days algorithm.
    let days = (secs / 86_400) as i64;
    let secs_of_day = secs % 86_400;
    let (hour, minute, second) = (
        secs_of_day / 3600,
        secs_of_day % 3600 / 60,
        secs_of_day % 60,
    );
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn fresh_database_applies_all_migrations() {
        let conn = Connection::open_in_memory().unwrap();
        let result = run_migrations(&conn).unwrap();
        assert_eq!(result.applied_migration_ids, vec![1, 2, 3, 4, 5]);
        // 表已建
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM migrations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 5);
        // plugin_root 列存在（迁移 4 的条件 apply）
        let mut stmt = conn.prepare("PRAGMA table_info(plugins)").unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(|c| c.unwrap())
            .collect();
        assert!(columns.contains(&"plugin_root".to_string()));
    }

    #[test]
    fn rerun_applies_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let result = run_migrations(&conn).unwrap();
        assert!(result.applied_migration_ids.is_empty());
    }

    #[test]
    fn unknown_applied_migration_is_rejected() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn.execute(
            "INSERT INTO migrations (id, name, applied_at) VALUES (99, '099_unknown', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let err = run_migrations(&conn).unwrap_err();
        assert!(matches!(err, StorageError::InvalidAppliedMigrations(_)));
    }

    #[test]
    fn duplicate_definition_id_is_rejected() {
        let migrations = [
            Migration {
                id: 1,
                name: "a",
                sql: "SELECT 1",
                apply: None,
            },
            Migration {
                id: 1,
                name: "b",
                sql: "SELECT 1",
                apply: None,
            },
        ];
        let err = validate_migration_definitions(&migrations).unwrap_err();
        assert!(matches!(err, StorageError::InvalidMigrationDefinitions(_)));
    }
}
