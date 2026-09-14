//! Settings repository. Ported from `packages/core/src/storage/settingsRepository.ts`.
//!
//! Single-row storage: the `settings` table holds one row keyed by
//! [`SETTINGS_KEY`] whose `value` is the full settings JSON and whose
//! `updated_at` is an ISO 8601 UTC timestamp. Reads merge the stored JSON over
//! [`Settings::default`] (TS `createSettingsFromPatch` semantics) so partial
//! rows written by older builds keep working.
//!
//! Load-time validation mirrors the TS `validateSettingsPatch` allow-lists:
//! unknown keys, wrong types, bad theme/language enums, out-of-domain
//! `search.maxResults`, and non-numeric boosts are rejected with the TS error
//! message prefix `Invalid settings in settings key "command-cabin": `. The TS
//! port target emits `Invalid JSON in ...` for syntactically malformed JSON;
//! this port deliberately uses the same `Invalid settings in ...` prefix for
//! malformed JSON as well, per the M2 task brief.
//!
//! Known deviations from the TS original (documented per task instructions):
//!
//! - First `get` on an empty table persists the defaults immediately
//!   (brief-mandated "首读落库"); TS only caches defaults in memory until the
//!   first `updateSettings` write.
//! - Malformed stored JSON reports `Invalid settings in settings key
//!   "command-cabin": invalid JSON: ...`; TS reports `Invalid JSON in settings
//!   key "command-cabin": ...`.
//! - Stored `search.maxResults` above `i32::MAX` is **clamped** to `i32::MAX`
//!   on load with a stderr note (M5 ruling: data continuity first — rejecting
//!   the whole settings row would brick startup over one oversized value; TS
//!   accepts safe integers up to 2^53 - 1). Non-integer / negative values are
//!   still rejected with the TS error message.
//! - `update` routes through `Settings::apply_patch`, which rejects blank
//!   hotkeys; the TS `validateSettingsPatch` write path only type-checks and
//!   would accept them.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use cabin_core::settings::{Language, Settings, SettingsError, SettingsPatch, Theme};

use crate::error::StorageError;
use crate::migrations::iso_now;

/// Row key of the single settings row (TS `SETTINGS_KEY`).
pub const SETTINGS_KEY: &str = "command-cabin";

/// TS `SETTINGS_KEYS` allow-list for stored settings objects.
const SETTINGS_KEYS: &[&str] = &[
    "hotkey",
    "screenshotHotkey",
    "delayedScreenshotHotkey",
    "hideOnBlur",
    "theme",
    "language",
    "launchAtLogin",
    "preserveSearchQuery",
    "search",
];

/// TS `SEARCH_SETTINGS_KEYS` allow-list for the nested `search` object.
const SEARCH_SETTINGS_KEYS: &[&str] = &[
    "maxResults",
    "historyBoost",
    "pluginBoost",
    "appBoost",
    "fileBoost",
];

fn invalid_settings(reason: impl Into<String>) -> StorageError {
    StorageError::InvalidSettings(reason.into())
}

/// Reads, writes, and caches the single settings row (TS `createSettingsRepository`).
pub struct SettingsRepository<'a> {
    conn: &'a Connection,
    cached: Option<Settings>,
}

impl<'a> SettingsRepository<'a> {
    pub fn new(conn: &'a Connection) -> SettingsRepository<'a> {
        SettingsRepository { conn, cached: None }
    }

    /// Returns the cached settings, loading and validating them on first call.
    ///
    /// No row → defaults are persisted immediately and returned. A row that
    /// fails parsing or validation yields [`StorageError::InvalidSettings`].
    pub fn get(&mut self) -> Result<Settings, StorageError> {
        Ok(self.load_cached()?.clone())
    }

    /// Validates `patch` via `Settings::apply_patch`, upserts the merged
    /// settings, and returns them (TS `updateSettings`).
    pub fn update(&mut self, patch: &SettingsPatch) -> Result<Settings, StorageError> {
        let updated = self
            .load_cached()?
            .apply_patch(patch)
            .map_err(|err| match err {
                SettingsError::Invalid(reason) => invalid_settings(reason),
            })?;
        self.save(&updated)?;
        self.cached = Some(updated.clone());
        Ok(updated)
    }

    /// Writes and returns the default settings (TS `resetSettings`).
    pub fn reset(&mut self) -> Result<Settings, StorageError> {
        let defaults = Settings::default();
        self.save(&defaults)?;
        self.cached = Some(defaults.clone());
        Ok(defaults)
    }

    fn load_cached(&mut self) -> Result<&Settings, StorageError> {
        if self.cached.is_none() {
            let row: Option<String> = self
                .conn
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    params![SETTINGS_KEY],
                    |row| row.get(0),
                )
                .optional()?;

            let settings = match row {
                Some(value) => parse_stored_settings(&value)?,
                None => {
                    // Brief-mandated 首读落库: persist defaults on first read.
                    let defaults = Settings::default();
                    self.save(&defaults)?;
                    defaults
                }
            };
            self.cached = Some(settings);
        }
        Ok(self.cached.as_ref().expect("cache just populated"))
    }

    /// Upserts the full settings row (TS `saveSettings`): merged settings are
    /// re-validated, serialized, and written with an ISO 8601 UTC timestamp.
    fn save(&self, settings: &Settings) -> Result<(), StorageError> {
        validate_merged_settings(settings)?;
        let value = serde_json::to_string(settings)
            .map_err(|err| invalid_settings(format!("settings could not be serialized: {err}")))?;
        self.conn.execute(
            "INSERT INTO settings (key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at",
            params![SETTINGS_KEY, value, iso_now()],
        )?;
        Ok(())
    }
}

/// Parses and validates a stored settings row, merging it over the defaults
/// (TS `parseStorageJson` + `validateSettingsPatch` + `createSettingsFromPatch`).
fn parse_stored_settings(value: &str) -> Result<Settings, StorageError> {
    let parsed: Value = serde_json::from_str(value)
        .map_err(|err| invalid_settings(format!("invalid JSON: {err}")))?;
    validate_stored_settings(&parsed)
}

/// TS `validateSettingsPatch` on a stored value, followed by a merge over
/// `Settings::default`. The error checks run in the TS source order so the
/// first reported reason matches the TS build.
fn validate_stored_settings(value: &Value) -> Result<Settings, StorageError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_settings("settings must be an object"))?;

    for key in object.keys() {
        if !SETTINGS_KEYS.contains(&key.as_str()) {
            return Err(invalid_settings(format!("unknown setting \"{key}\"")));
        }
    }

    let mut settings = Settings::default();

    if let Some(hotkey) = optional_string(object, "hotkey")? {
        settings.hotkey = hotkey;
    }
    if let Some(hotkey) = optional_string(object, "screenshotHotkey")? {
        settings.screenshot_hotkey = hotkey;
    }
    if let Some(hotkey) = optional_string(object, "delayedScreenshotHotkey")? {
        settings.delayed_screenshot_hotkey = hotkey;
    }
    if let Some(hide_on_blur) = optional_boolean(object, "hideOnBlur")? {
        settings.hide_on_blur = hide_on_blur;
    }
    if let Some(launch_at_login) = optional_boolean(object, "launchAtLogin")? {
        settings.launch_at_login = launch_at_login;
    }
    if let Some(preserve) = optional_boolean(object, "preserveSearchQuery")? {
        settings.preserve_search_query = preserve;
    }

    if let Some(theme) = object.get("theme") {
        settings.theme = match theme.as_str() {
            Some("system") => Theme::System,
            Some("light") => Theme::Light,
            Some("dark") => Theme::Dark,
            _ => {
                return Err(invalid_settings(
                    "theme must be \"system\", \"light\", or \"dark\"",
                ));
            }
        };
    }

    if let Some(language) = object.get("language") {
        settings.language = match language.as_str() {
            Some("zh-CN") => Language::ZhCn,
            Some("zh-TW") => Language::ZhTw,
            Some("en-US") => Language::EnUs,
            _ => {
                return Err(invalid_settings(
                    "language must be \"zh-CN\", \"zh-TW\", or \"en-US\"",
                ));
            }
        };
    }

    if let Some(search) = object.get("search") {
        let search = search
            .as_object()
            .ok_or_else(|| invalid_settings("search must be an object"))?;

        for key in search.keys() {
            if !SEARCH_SETTINGS_KEYS.contains(&key.as_str()) {
                return Err(invalid_settings(format!(
                    "unknown search setting \"{key}\""
                )));
            }
        }

        if let Some(max_results) = search.get("maxResults") {
            // TS: Number.isSafeInteger(maxResults) && maxResults >= 0. The Rust
            // field is u32 and cabin-core caps patches at i32::MAX. M5 收口裁决
            // （数据连续性优先）：load 时超过 i32::MAX 的存量值钳制到 i32::MAX
            // 并在 stderr 打一条说明，而不是整份设置拒收——拒收会让损坏/超大
            // 值阻断整个应用启动（TS 侧按 safe-integer 全量接受）。写路径的
            // patch 域仍在 cabin-core 收口为 i32::MAX。
            let value = match max_results.as_u64() {
                Some(value) if value <= i32::MAX as u64 => value as u32,
                Some(value) => {
                    eprintln!(
                        "CommandCabin: stored search.maxResults {value} exceeds the supported \
                         maximum, clamped to {}",
                        i32::MAX
                    );
                    i32::MAX as u32
                }
                None => {
                    return Err(invalid_settings(
                        "search.maxResults must be a safe integer >= 0",
                    ))
                }
            };
            settings.search.max_results = value;
        }

        if let Some(boost) = optional_number(search, "historyBoost")? {
            settings.search.history_boost = boost;
        }
        if let Some(boost) = optional_number(search, "pluginBoost")? {
            settings.search.plugin_boost = boost;
        }
        if let Some(boost) = optional_number(search, "appBoost")? {
            settings.search.app_boost = boost;
        }
        if let Some(boost) = optional_number(search, "fileBoost")? {
            settings.search.file_boost = boost;
        }
    }

    Ok(settings)
}

fn optional_string(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<String>, StorageError> {
    match object.get(field) {
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(invalid_settings(format!("{field} must be a string"))),
        None => Ok(None),
    }
}

fn optional_boolean(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<bool>, StorageError> {
    match object.get(field) {
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid_settings(format!("{field} must be a boolean"))),
        None => Ok(None),
    }
}

/// TS `validateOptionalFiniteNumber`. Parsed JSON numbers are finite by
/// construction, so only the type check can fail on this path.
fn optional_number(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<f64>, StorageError> {
    match object.get(field) {
        Some(value) => match value.as_f64() {
            Some(number) => Ok(Some(number)),
            None => Err(invalid_settings(format!("search.{field} must be a number"))),
        },
        None => Ok(None),
    }
}

/// TS `saveSettings` re-validates merged settings before writing. Typed
/// settings can only violate the finite-boost invariant, so that is all that
/// is re-checked here.
fn validate_merged_settings(settings: &Settings) -> Result<(), StorageError> {
    let boosts = [
        ("historyBoost", settings.search.history_boost),
        ("pluginBoost", settings.search.plugin_boost),
        ("appBoost", settings.search.app_boost),
        ("fileBoost", settings.search.file_boost),
    ];
    for (field, value) in boosts {
        if !value.is_finite() {
            return Err(invalid_settings(format!("search.{field} must be finite")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cabin_core::settings::{SearchSettingsPatch, SettingsPatch};

    const TS_ERROR_PREFIX: &str = "Invalid settings in settings key \"command-cabin\": ";

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        crate::migrations::run_migrations(&conn).expect("run migrations");
        conn
    }

    fn insert_settings_row(conn: &Connection, value: &str) {
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![SETTINGS_KEY, value, "2026-05-15T10:00:00.000Z"],
        )
        .expect("insert settings row");
    }

    fn stored_row(conn: &Connection) -> Option<(String, String)> {
        conn.query_row(
            "SELECT value, updated_at FROM settings WHERE key = ?1",
            params![SETTINGS_KEY],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .expect("query settings row")
    }

    fn expect_invalid_settings(err: StorageError, expected_reason: &str) {
        match &err {
            StorageError::InvalidSettings(reason) => {
                assert!(
                    err.to_string().starts_with(TS_ERROR_PREFIX),
                    "error must carry the TS prefix: {err}"
                );
                assert!(
                    reason.contains(expected_reason),
                    "reason {reason:?} must contain {expected_reason:?}"
                );
            }
            other => panic!("expected InvalidSettings, got {other:?}"),
        }
    }

    // ---- get -------------------------------------------------------------

    #[test]
    fn get_returns_defaults_and_persists_row_on_first_read() {
        let conn = open_db();
        assert!(stored_row(&conn).is_none());

        let mut repository = SettingsRepository::new(&conn);
        let settings = repository.get().expect("first read succeeds");

        assert_eq!(settings, Settings::default());

        // Brief-mandated 首读落库: the defaults row exists right after the first read.
        let (value, updated_at) = stored_row(&conn).expect("defaults row persisted");
        let parsed: serde_json::Value = serde_json::from_str(&value).expect("stored JSON parses");
        assert_eq!(
            parsed,
            serde_json::to_value(Settings::default()).expect("serialize defaults")
        );
        assert!(
            updated_at.ends_with('Z') && updated_at.contains('T'),
            "updated_at must be ISO 8601 UTC, got {updated_at:?}"
        );
    }

    #[test]
    fn get_returns_independent_clones_of_the_cache() {
        let conn = open_db();
        let mut repository = SettingsRepository::new(&conn);

        let mut first = repository.get().expect("get");
        let second = repository.get().expect("get");

        first.hotkey = "Mutated+Space".to_string();
        first.search.max_results = 99;

        assert_eq!(second, Settings::default());
        assert_eq!(repository.get().expect("get"), Settings::default());
    }

    #[test]
    fn get_serves_cache_when_row_is_tampered_after_first_read() {
        let conn = open_db();
        insert_settings_row(
            &conn,
            r#"{"hotkey":"Ctrl+Space","theme":"dark","search":{"maxResults":12}}"#,
        );
        let mut repository = SettingsRepository::new(&conn);
        assert_eq!(repository.get().expect("get").hotkey, "Ctrl+Space");

        conn.execute(
            "UPDATE settings SET value = '{\"hotkey\":\"Tampered+Space\",\"search\":{\"maxResults\":1}}' WHERE key = ?1",
            params![SETTINGS_KEY],
        )
        .expect("tamper row");

        let settings = repository.get().expect("cached get");
        assert_eq!(settings.hotkey, "Ctrl+Space");
        assert_eq!(settings.search.max_results, 12);
    }

    #[test]
    fn get_merges_partial_stored_row_over_defaults() {
        let conn = open_db();
        insert_settings_row(
            &conn,
            r#"{"hotkey":"Ctrl+Space","theme":"dark","search":{"maxResults":12}}"#,
        );

        let settings = SettingsRepository::new(&conn).get().expect("get");

        assert_eq!(settings.hotkey, "Ctrl+Space");
        assert_eq!(settings.screenshot_hotkey, "Ctrl+Alt+A");
        assert_eq!(settings.delayed_screenshot_hotkey, "Ctrl+Alt+D");
        assert_eq!(settings.theme, Theme::Dark);
        assert!(settings.hide_on_blur);
        assert_eq!(settings.language, Language::ZhCn);
        assert_eq!(settings.search.max_results, 12);
        assert_eq!(settings.search.history_boost, 1.4);
        assert_eq!(settings.search.plugin_boost, 1.0);
        assert_eq!(settings.search.app_boost, 1.2);
        assert_eq!(settings.search.file_boost, 0.9);
    }

    #[test]
    fn get_loads_full_row_written_by_the_electron_app() {
        let conn = open_db();
        insert_settings_row(
            &conn,
            r#"{
                "hotkey": "Alt+Space",
                "screenshotHotkey": "Ctrl+Alt+A",
                "delayedScreenshotHotkey": "Ctrl+Alt+D",
                "hideOnBlur": true,
                "theme": "system",
                "language": "zh-CN",
                "launchAtLogin": false,
                "preserveSearchQuery": false,
                "search": {
                    "maxResults": 20,
                    "historyBoost": 1.4,
                    "pluginBoost": 1,
                    "appBoost": 1.2,
                    "fileBoost": 0.9
                }
            }"#,
        );

        let settings = SettingsRepository::new(&conn).get().expect("get");

        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn get_rejects_malformed_stored_json() {
        let conn = open_db();
        insert_settings_row(&conn, "{bad-json");

        let err = SettingsRepository::new(&conn).get().expect_err("must fail");

        expect_invalid_settings(err, "invalid JSON");
    }

    #[test]
    fn get_rejects_non_object_stored_json() {
        let conn = open_db();
        insert_settings_row(&conn, "{}");
        for value in ["[1,2]", "\"text\"", "null", "42"] {
            conn.execute(
                "UPDATE settings SET value = ?1 WHERE key = ?2",
                params![value, SETTINGS_KEY],
            )
            .expect("update row");

            let err = SettingsRepository::new(&conn).get().expect_err("must fail");
            expect_invalid_settings(err, "settings must be an object");
        }
    }

    #[test]
    fn get_rejects_unknown_top_level_keys() {
        let conn = open_db();
        insert_settings_row(&conn, r#"{"hotkey":"Ctrl+Space","surprise":true}"#);

        let err = SettingsRepository::new(&conn).get().expect_err("must fail");

        expect_invalid_settings(err, "unknown setting \"surprise\"");
    }

    #[test]
    fn get_rejects_wrong_field_types_with_ts_messages() {
        let cases: &[(&str, &str)] = &[
            (r#"{"hotkey":42}"#, "hotkey must be a string"),
            (
                r#"{"screenshotHotkey":42}"#,
                "screenshotHotkey must be a string",
            ),
            (
                r#"{"delayedScreenshotHotkey":42}"#,
                "delayedScreenshotHotkey must be a string",
            ),
            (r#"{"hideOnBlur":"yes"}"#, "hideOnBlur must be a boolean"),
            (r#"{"launchAtLogin":1}"#, "launchAtLogin must be a boolean"),
            (
                r#"{"preserveSearchQuery":null}"#,
                "preserveSearchQuery must be a boolean",
            ),
            (
                r#"{"theme":"neon"}"#,
                "theme must be \"system\", \"light\", or \"dark\"",
            ),
            (
                r#"{"theme":7}"#,
                "theme must be \"system\", \"light\", or \"dark\"",
            ),
            (
                r#"{"language":"fr-FR"}"#,
                "language must be \"zh-CN\", \"zh-TW\", or \"en-US\"",
            ),
            (r#"{"search":"oops"}"#, "search must be an object"),
            (r#"{"search":[]}"#, "search must be an object"),
            (r#"{"search":null}"#, "search must be an object"),
            (
                r#"{"search":{"unexpectedBoost":2}}"#,
                "unknown search setting \"unexpectedBoost\"",
            ),
            (
                r#"{"search":{"maxResults":"many"}}"#,
                "search.maxResults must be a safe integer >= 0",
            ),
            (
                r#"{"search":{"maxResults":-1}}"#,
                "search.maxResults must be a safe integer >= 0",
            ),
            (
                r#"{"search":{"maxResults":1.5}}"#,
                "search.maxResults must be a safe integer >= 0",
            ),
            (
                r#"{"search":{"historyBoost":"high"}}"#,
                "search.historyBoost must be a number",
            ),
            (
                r#"{"search":{"pluginBoost":true}}"#,
                "search.pluginBoost must be a number",
            ),
            (
                r#"{"search":{"appBoost":null}}"#,
                "search.appBoost must be a number",
            ),
            (
                r#"{"search":{"fileBoost":"x"}}"#,
                "search.fileBoost must be a number",
            ),
        ];

        for (value, expected_reason) in cases {
            let conn = open_db();
            insert_settings_row(&conn, value);

            let err = SettingsRepository::new(&conn).get().expect_err("must fail");
            expect_invalid_settings(err, expected_reason);
        }
    }

    #[test]
    fn get_clamps_max_results_above_port_domain() {
        // M5 收口裁决（数据连续性优先）：超过 i32::MAX 的存量值 load 时钳制到
        // i32::MAX（stderr 侧注明），不再整份拒收。类型错误仍拒。
        let conn = open_db();
        insert_settings_row(&conn, r#"{"search":{"maxResults":5000000000}}"#);
        let settings = SettingsRepository::new(&conn)
            .get()
            .expect("oversized value clamps instead of rejecting the row");
        assert_eq!(settings.search.max_results, i32::MAX as u32);

        let conn = open_db();
        insert_settings_row(&conn, r#"{"search":{"maxResults":2147483647}}"#);
        let settings = SettingsRepository::new(&conn).get().expect("boundary fits");
        assert_eq!(settings.search.max_results, i32::MAX as u32);

        let conn = open_db();
        insert_settings_row(&conn, r#"{"search":{"maxResults":-1}}"#);
        let err = SettingsRepository::new(&conn).get().expect_err("must fail");
        expect_invalid_settings(err, "search.maxResults must be a safe integer >= 0");
    }

    // ---- update ----------------------------------------------------------

    #[test]
    fn update_merges_patch_and_survives_repository_recreation() {
        let conn = open_db();

        {
            let mut repository = SettingsRepository::new(&conn);
            let updated = repository
                .update(&SettingsPatch {
                    hotkey: Some("Ctrl+Space".to_string()),
                    theme: Some(Theme::Dark),
                    launch_at_login: Some(true),
                    search: Some(SearchSettingsPatch {
                        max_results: Some(12),
                        plugin_boost: Some(1.8),
                        ..SearchSettingsPatch::default()
                    }),
                    ..SettingsPatch::default()
                })
                .expect("update");

            assert_eq!(updated.hotkey, "Ctrl+Space");
            assert_eq!(updated.theme, Theme::Dark);
            assert!(updated.launch_at_login);
            assert_eq!(updated.search.max_results, 12);
            assert_eq!(updated.search.plugin_boost, 1.8);
            assert_eq!(updated.search.history_boost, 1.4);
            assert_eq!(updated.screenshot_hotkey, "Ctrl+Alt+A");
        }

        // Fresh repository (no cache) reads the persisted row back.
        let reloaded = SettingsRepository::new(&conn).get().expect("reload");
        assert_eq!(reloaded.hotkey, "Ctrl+Space");
        assert_eq!(reloaded.theme, Theme::Dark);
        assert!(reloaded.launch_at_login);
        assert_eq!(reloaded.search.max_results, 12);
        assert_eq!(reloaded.search.plugin_boost, 1.8);
    }

    #[test]
    fn update_stores_ts_shaped_camel_case_json_in_a_single_row() {
        let conn = open_db();
        let mut repository = SettingsRepository::new(&conn);
        repository
            .update(&SettingsPatch {
                language: Some(Language::ZhTw),
                ..SettingsPatch::default()
            })
            .expect("update");
        repository
            .update(&SettingsPatch {
                hide_on_blur: Some(false),
                ..SettingsPatch::default()
            })
            .expect("update");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
            .expect("count rows");
        assert_eq!(count, 1, "upsert must keep a single settings row");

        let (value, _) = stored_row(&conn).expect("row");
        let parsed: serde_json::Value = serde_json::from_str(&value).expect("stored JSON parses");
        assert_eq!(parsed["hotkey"], "Alt+Space");
        assert_eq!(parsed["screenshotHotkey"], "Ctrl+Alt+A");
        assert_eq!(parsed["delayedScreenshotHotkey"], "Ctrl+Alt+D");
        assert_eq!(parsed["hideOnBlur"], false);
        assert_eq!(parsed["launchAtLogin"], false);
        assert_eq!(parsed["preserveSearchQuery"], false);
        assert_eq!(parsed["theme"], "system");
        assert_eq!(parsed["language"], "zh-TW");
        assert_eq!(parsed["search"]["maxResults"], 20);
        assert_eq!(parsed["search"]["historyBoost"], 1.4);
    }

    #[test]
    fn update_rejects_invalid_patch_without_touching_stored_row() {
        let conn = open_db();
        let mut repository = SettingsRepository::new(&conn);
        repository
            .update(&SettingsPatch {
                hotkey: Some("Ctrl+Space".to_string()),
                ..SettingsPatch::default()
            })
            .expect("seed update");

        let err = repository
            .update(&SettingsPatch {
                hotkey: Some("   ".to_string()),
                ..SettingsPatch::default()
            })
            .expect_err("blank hotkey must be rejected");
        expect_invalid_settings(err, "hotkey must be a non-empty string");

        let err = repository
            .update(&SettingsPatch {
                search: Some(SearchSettingsPatch {
                    history_boost: Some(f64::NAN),
                    ..SearchSettingsPatch::default()
                }),
                ..SettingsPatch::default()
            })
            .expect_err("non-finite boost must be rejected");
        expect_invalid_settings(err, "search.historyBoost must be finite");

        let err = repository
            .update(&SettingsPatch {
                search: Some(SearchSettingsPatch {
                    max_results: Some(u32::MAX),
                    ..SearchSettingsPatch::default()
                }),
                ..SettingsPatch::default()
            })
            .expect_err("out-of-domain max_results must be rejected");
        expect_invalid_settings(err, "search.maxResults must be a safe integer >= 0");

        // Stored settings and cache are untouched by the rejected patches.
        let settings = repository.get().expect("get");
        assert_eq!(settings.hotkey, "Ctrl+Space");
        assert_eq!(settings.search.history_boost, 1.4);
        assert_eq!(settings.search.max_results, 20);
    }

    #[test]
    fn update_refreshes_cache_and_ignores_later_db_tampering() {
        let conn = open_db();
        let mut repository = SettingsRepository::new(&conn);
        repository
            .update(&SettingsPatch {
                hotkey: Some("Ctrl+Shift+Space".to_string()),
                ..SettingsPatch::default()
            })
            .expect("update");

        conn.execute(
            "UPDATE settings SET value = '{\"hotkey\":\"Tampered+Space\"}' WHERE key = ?1",
            params![SETTINGS_KEY],
        )
        .expect("tamper row");

        assert_eq!(
            repository.get().expect("cached get").hotkey,
            "Ctrl+Shift+Space"
        );
    }

    // ---- reset -----------------------------------------------------------

    #[test]
    fn reset_writes_defaults_and_refreshes_cache() {
        let conn = open_db();
        let mut repository = SettingsRepository::new(&conn);
        repository
            .update(&SettingsPatch {
                hotkey: Some("Ctrl+Alt+Space".to_string()),
                launch_at_login: Some(true),
                ..SettingsPatch::default()
            })
            .expect("update");

        let reset = repository.reset().expect("reset");
        assert_eq!(reset, Settings::default());
        assert_eq!(repository.get().expect("get"), Settings::default());

        // The defaults were persisted: a cache-less repository reads them back.
        drop(repository);
        assert_eq!(
            SettingsRepository::new(&conn).get().expect("reload"),
            Settings::default()
        );

        // The resetting repository's cache ignores later database tampering.
        let mut repository = SettingsRepository::new(&conn);
        repository.reset().expect("reset");
        conn.execute(
            "UPDATE settings SET value = '{\"hotkey\":\"Tampered+Space\"}' WHERE key = ?1",
            params![SETTINGS_KEY],
        )
        .expect("tamper row");
        assert_eq!(repository.get().expect("cached get"), Settings::default());
    }
}
