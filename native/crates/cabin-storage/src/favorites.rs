//! Favorites repository. Ported from `packages/core/src/indexer/favoritesRepository.ts`.
//!
//! Validation error messages are verbatim TS (see the module tests). The record
//! type lives in `cabin_core::favorites` (aligned with the `IndexedShortcut`
//! precedent); this module owns the SQL and the write/read boundary validation.
//!
//! Known deviations from the TS original (documented per task instructions):
//!
//! - TS accepts `Date | string` for `createdAt`/`updatedAt` and canonicalizes
//!   through `new Date(value).toISOString()` (accepting extra JS date formats
//!   and converting offsets to UTC). The Rust port accepts ISO 8601-shaped
//!   strings with valid ranges (`YYYY-MM-DDTHH:MM:SS(.f+)?(Z|±HH:MM)`) and
//!   stores them unchanged; native producers emit canonical UTC ISO via
//!   `iso_now`. Invalid shapes are rejected with the TS message
//!   `Invalid date for favorite {field}: {value}`.
//! - TS type-level mutual exclusion (`url?: never` on file/folder inputs) has
//!   no runtime check: the TS code simply never reads the irrelevant field.
//!   The port mirrors that — `kind` decides which of `path`/`url` is read;
//!   the other field is ignored and stored as `NULL` (the migration-2 CHECK
//!   constraint enforces the stored shape).
//! - TS `validateStorageJsonValue` rejects non-finite numbers, circular
//!   references, symbols, functions, bigints, and non-plain objects inside
//!   `metadata`; all of these are unrepresentable in `serde_json::Value`, so
//!   the only remaining metadata check (must be a JSON object) is enforced at
//!   the type level on writes and validated on reads of stored rows.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use cabin_core::favorites::{FavoriteKind, FavoriteRecord};

use crate::error::StorageError;
use crate::migrations::iso_now;
use crate::timestamp::is_iso8601_timestamp;

/// TS `AddFavoriteInput`（三个判别联合变体的合并形态）。
#[derive(Debug, Clone, PartialEq)]
pub struct AddFavorite {
    /// 缺省时生成 UUID v4。
    pub id: Option<String>,
    pub kind: FavoriteKind,
    pub title: String,
    /// file/folder 必填非空；kind 为 url 时忽略。
    pub path: Option<String>,
    /// kind 为 url 时必填 http/https；file/folder 时忽略。
    pub url: Option<String>,
    pub keywords: Vec<String>,
    /// 缺省 `{}`。
    pub metadata: Option<Map<String, Value>>,
    /// ISO 8601；缺省当前时间。
    pub created_at: Option<String>,
    /// ISO 8601；缺省等于归一化后的 `created_at`。
    pub updated_at: Option<String>,
}

/// TS `UpdateFavoriteInput`。`kind`/`path`/`url` 不可变 —— 类型层无对应字段。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UpdateFavorite {
    pub title: Option<String>,
    pub keywords: Option<Vec<String>>,
    pub metadata: Option<Map<String, Value>>,
    /// ISO 8601；缺省当前时间。
    pub updated_at: Option<String>,
}

fn invalid_favorite(message: impl Into<String>) -> StorageError {
    StorageError::InvalidFavorite(message.into())
}

/// TS `validateFavoriteId`。
fn validate_favorite_id(id: Option<String>) -> Result<String, StorageError> {
    match id {
        None => Ok(uuid::Uuid::new_v4().to_string()),
        Some(id) => {
            let trimmed = id.trim();
            if trimmed.is_empty() {
                return Err(invalid_favorite("Favorite id must be a non-empty string"));
            }
            Ok(trimmed.to_string())
        }
    }
}

/// TS `validateNonEmptyString`；`None` 等价于 TS 的非字符串输入。
fn validate_non_empty_string(
    value: Option<&str>,
    message: &'static str,
) -> Result<String, StorageError> {
    let trimmed = value.unwrap_or("").trim();
    if trimmed.is_empty() {
        return Err(invalid_favorite(message));
    }
    Ok(trimmed.to_string())
}

/// TS `validateFavoriteTitle`。
fn validate_favorite_title(title: &str) -> Result<String, StorageError> {
    validate_non_empty_string(Some(title), "Favorite title must be a non-empty string")
}

/// TS `formatStorageValueContext({ table: 'favorites', field: 'keywords', key? })`。
fn favorites_field_context(field: &str, key: Option<&str>) -> String {
    match key {
        Some(key) => format!("favorites {field} key \"{key}\""),
        None => format!("favorites {field}"),
    }
}

/// TS `validateFavoriteKeywords` 的运行时部分：元素 trim 非空、去重保序。
/// （“必须是数组 / 元素必须是字符串”由 Rust 类型层保证；读路径另行检查。）
fn validate_favorite_keywords(
    keywords: &[String],
    key: Option<&str>,
) -> Result<Vec<String>, StorageError> {
    let context = favorites_field_context("keywords", key);
    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (index, keyword) in keywords.iter().enumerate() {
        let trimmed = keyword.trim();
        if trimmed.is_empty() {
            return Err(invalid_favorite(format!(
                "Invalid favorite keywords in {context}: favorite keywords[{index}] must be a non-empty string"
            )));
        }
        if seen.insert(trimmed.to_string()) {
            normalized.push(trimmed.to_string());
        }
    }
    Ok(normalized)
}

/// TS `validateFavoriteUrl`（trim 非空 + WHATWG URL 解析 + 仅 http/https，
/// 返回 trim 后的原字符串）。`url` crate 与 JS `new URL()` 同为 WHATWG 实现。
fn validate_favorite_url(url: Option<&str>) -> Result<String, StorageError> {
    const MESSAGE: &str = "URL favorite url must be an http or https URL";
    let trimmed = validate_non_empty_string(url, MESSAGE)?;
    let parsed = url::Url::parse(&trimmed).map_err(|_| invalid_favorite(MESSAGE))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(invalid_favorite(MESSAGE));
    }
    Ok(trimmed)
}

/// TS `validateFavoriteTarget`：kind 决定读取哪个字段，另一字段忽略并存 NULL。
fn validate_favorite_target(
    kind: FavoriteKind,
    path: Option<&str>,
    url: Option<&str>,
) -> Result<(Option<String>, Option<String>), StorageError> {
    if kind == FavoriteKind::Url {
        return Ok((None, Some(validate_favorite_url(url)?)));
    }
    let message = match kind {
        FavoriteKind::File => "File favorite path must be a non-empty string",
        FavoriteKind::Folder => "Folder favorite path must be a non-empty string",
        FavoriteKind::Url => unreachable!("url kind handled above"),
    };
    Ok((Some(validate_non_empty_string(path, message)?), None))
}

/// TS `normalizeFavoriteDate`：`None` → 当前时间；否则校验 ISO 8601 形态并原样保留。
/// （偏差见模块文档：TS 经 JS Date 归一化，本端口只做形态/范围校验。）
fn normalize_favorite_date(value: Option<&str>, field: &str) -> Result<String, StorageError> {
    match value {
        None => Ok(iso_now()),
        Some(raw) if is_iso8601_timestamp(raw) => Ok(raw.to_string()),
        Some(raw) => Err(invalid_favorite(format!(
            "Invalid date for favorite {field}: {raw}"
        ))),
    }
}

/// 数据库行形态（TS `FavoriteRow`）。
struct FavoriteRow {
    id: String,
    kind: String,
    title: String,
    path: Option<String>,
    url: Option<String>,
    keywords: String,
    metadata: String,
    created_at: String,
    updated_at: String,
}

fn read_favorite_row(row: &rusqlite::Row) -> rusqlite::Result<FavoriteRow> {
    Ok(FavoriteRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        path: row.get(3)?,
        url: row.get(4)?,
        keywords: row.get(5)?,
        metadata: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

/// 读路径：解析存储的 keywords JSON（TS `parseStorageJson` + `validateFavoriteKeywords`）。
fn parse_stored_keywords(raw: &str, id: &str) -> Result<Vec<String>, StorageError> {
    let context = favorites_field_context("keywords", Some(id));
    let value: Value = serde_json::from_str(raw)
        .map_err(|err| invalid_favorite(format!("Invalid JSON in {context}: {err}")))?;
    let array = value.as_array().ok_or_else(|| {
        invalid_favorite(format!(
            "Invalid favorite keywords in {context}: favorite keywords must be an array"
        ))
    })?;
    let mut keywords = Vec::with_capacity(array.len());
    for (index, item) in array.iter().enumerate() {
        match item.as_str() {
            Some(keyword) => keywords.push(keyword.to_string()),
            None => {
                return Err(invalid_favorite(format!(
                    "Invalid favorite keywords in {context}: favorite keywords[{index}] must be a string"
                )));
            }
        }
    }
    validate_favorite_keywords(&keywords, Some(id))
}

/// 读路径：解析存储的 metadata JSON（TS `parseStorageJson` + `validateFavoriteMetadata`）。
/// 写路径的 “metadata 必须是 JSON object” 由 `Map<String, Value>` 类型层保证。
fn parse_stored_metadata(raw: &str, id: &str) -> Result<Map<String, Value>, StorageError> {
    let context = favorites_field_context("metadata", Some(id));
    let value: Value = serde_json::from_str(raw)
        .map_err(|err| invalid_favorite(format!("Invalid JSON in {context}: {err}")))?;
    value.as_object().cloned().ok_or_else(|| {
        invalid_favorite(format!(
            "Invalid favorite metadata in {context}: metadata must be an object"
        ))
    })
}

/// TS `mapFavoriteRow`：读路径全量校验。迁移 2 的 CHECK 约束使“非法 kind /
/// 缺 path / 缺 url / 空白 path”分支成为防御性代码（与 TS 相同）。
fn map_favorite_row(row: &FavoriteRow) -> Result<FavoriteRecord, StorageError> {
    let kind = FavoriteKind::parse(&row.kind).ok_or_else(|| {
        invalid_favorite(format!(
            "Invalid favorite kind in favorites key \"{}\": unsupported kind",
            row.id
        ))
    })?;
    let title = validate_favorite_title(&row.title)?;
    let created_at = normalize_favorite_date(Some(&row.created_at), "createdAt")?;
    let updated_at = normalize_favorite_date(Some(&row.updated_at), "updatedAt")?;
    let keywords = parse_stored_keywords(&row.keywords, &row.id)?;
    let metadata = parse_stored_metadata(&row.metadata, &row.id)?;

    if kind == FavoriteKind::Url {
        let url = row.url.as_deref().ok_or_else(|| {
            invalid_favorite(format!(
                "Invalid favorite target in favorites key \"{}\": URL is missing",
                row.id
            ))
        })?;
        return Ok(FavoriteRecord {
            id: row.id.clone(),
            kind,
            title,
            path: None,
            url: Some(validate_favorite_url(Some(url))?),
            keywords,
            metadata,
            created_at,
            updated_at,
        });
    }

    let path = row.path.as_deref().ok_or_else(|| {
        invalid_favorite(format!(
            "Invalid favorite target in favorites key \"{}\": path is missing",
            row.id
        ))
    })?;
    Ok(FavoriteRecord {
        id: row.id.clone(),
        kind,
        title,
        path: Some(validate_non_empty_string(
            Some(path),
            "Stored favorite path must be a non-empty string",
        )?),
        url: None,
        keywords,
        metadata,
        created_at,
        updated_at,
    })
}

const FAVORITE_COLUMNS: &str =
    "id, kind, title, path, url, keywords, metadata, created_at, updated_at";

/// 收藏仓储（TS `createFavoritesRepository`）。无缓存；`favorites` 表由迁移 2 创建。
pub struct FavoritesRepository<'a> {
    conn: &'a Connection,
}

impl<'a> FavoritesRepository<'a> {
    pub fn new(conn: &'a Connection) -> FavoritesRepository<'a> {
        FavoritesRepository { conn }
    }

    /// TS `addFavorite`：校验后插入并回读。校验顺序与 TS 一致
    /// （kind → id → title → target → keywords → metadata → dates），
    /// 多重非法输入时首个报错的来源与 TS 相同。
    pub fn add(&self, input: AddFavorite) -> Result<FavoriteRecord, StorageError> {
        let AddFavorite {
            id,
            kind,
            title,
            path,
            url,
            keywords,
            metadata,
            created_at,
            updated_at,
        } = input;
        let id = validate_favorite_id(id)?;
        let title = validate_favorite_title(&title)?;
        let (path, url) = validate_favorite_target(kind, path.as_deref(), url.as_deref())?;
        let keywords = validate_favorite_keywords(&keywords, None)?;
        let metadata = metadata.unwrap_or_default();
        let created_at = normalize_favorite_date(created_at.as_deref(), "createdAt")?;
        let updated_at = match updated_at.as_deref() {
            Some(value) => normalize_favorite_date(Some(value), "updatedAt")?,
            None => created_at.clone(),
        };

        // 已校验的 keywords/metadata 序列化不会失败（TS `stringifyStorageJson`）。
        let keywords_json = serde_json::to_string(&keywords)
            .expect("serializing validated favorite keywords cannot fail");
        let metadata_json = serde_json::to_string(&metadata)
            .expect("serializing validated favorite metadata cannot fail");

        self.conn.execute(
            &format!(
                "INSERT INTO favorites ({FAVORITE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
            ),
            params![
                id,
                kind.as_str(),
                title,
                path,
                url,
                keywords_json,
                metadata_json,
                created_at,
                updated_at
            ],
        )?;

        // TS：插入后回读，缺失则报 `Favorite was not saved: {id}`（防御性）。
        self.get(&id)?
            .ok_or_else(|| invalid_favorite(format!("Favorite was not saved: {id}")))
    }

    /// TS `updateFavorite`：仅更新提供的字段；`kind`/`path`/`url` 不可变。
    pub fn update(
        &self,
        id: &str,
        input: UpdateFavorite,
    ) -> Result<Option<FavoriteRecord>, StorageError> {
        let Some(existing) = self.get(id)? else {
            return Ok(None);
        };

        let title = match &input.title {
            Some(title) => validate_favorite_title(title)?,
            None => existing.title,
        };
        let keywords = match &input.keywords {
            Some(keywords) => validate_favorite_keywords(keywords, None)?,
            None => existing.keywords,
        };
        let metadata = input.metadata.unwrap_or(existing.metadata);
        let updated_at = normalize_favorite_date(input.updated_at.as_deref(), "updatedAt")?;

        let keywords_json = serde_json::to_string(&keywords)
            .expect("serializing validated favorite keywords cannot fail");
        let metadata_json = serde_json::to_string(&metadata)
            .expect("serializing validated favorite metadata cannot fail");

        self.conn.execute(
            "UPDATE favorites SET title = ?1, keywords = ?2, metadata = ?3, updated_at = ?4 WHERE id = ?5",
            params![title, keywords_json, metadata_json, updated_at, id],
        )?;

        self.get(id)
    }

    /// TS `getFavorite`。
    pub fn get(&self, id: &str) -> Result<Option<FavoriteRecord>, StorageError> {
        let row = self
            .conn
            .query_row(
                &format!("SELECT {FAVORITE_COLUMNS} FROM favorites WHERE id = ?1"),
                params![id],
                read_favorite_row,
            )
            .optional()?;
        row.map(|row| map_favorite_row(&row)).transpose()
    }

    /// TS `listFavorites`：`ORDER BY title COLLATE NOCASE, id`。
    pub fn list(&self) -> Result<Vec<FavoriteRecord>, StorageError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {FAVORITE_COLUMNS} FROM favorites ORDER BY title COLLATE NOCASE, id"
        ))?;
        let rows = stmt
            .query_map([], read_favorite_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.iter().map(map_favorite_row).collect()
    }

    /// TS `removeFavorite`：返回是否有行被删除。
    pub fn remove(&self, id: &str) -> Result<bool, StorageError> {
        Ok(self
            .conn
            .execute("DELETE FROM favorites WHERE id = ?1", params![id])?
            > 0)
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

    fn file_input(title: &str, path: &str) -> AddFavorite {
        AddFavorite {
            id: None,
            kind: FavoriteKind::File,
            title: title.into(),
            path: Some(path.into()),
            url: None,
            keywords: vec![],
            metadata: None,
            created_at: None,
            updated_at: None,
        }
    }

    fn url_input(title: &str, url: Option<&str>) -> AddFavorite {
        AddFavorite {
            id: None,
            kind: FavoriteKind::Url,
            title: title.into(),
            path: None,
            url: url.map(str::to_string),
            keywords: vec![],
            metadata: None,
            created_at: None,
            updated_at: None,
        }
    }

    fn expect_invalid_favorite(err: &StorageError, expected_message: &str) {
        match err {
            StorageError::InvalidFavorite(message) => assert_eq!(message, expected_message),
            other => panic!("expected InvalidFavorite, got {other:?}"),
        }
    }

    fn expect_invalid_favorite_prefix(err: &StorageError, expected_prefix: &str) {
        match err {
            StorageError::InvalidFavorite(message) => assert!(
                message.starts_with(expected_prefix),
                "message {message:?} must start with {expected_prefix:?}"
            ),
            other => panic!("expected InvalidFavorite, got {other:?}"),
        }
    }

    fn assert_uuid_v4(id: &str) {
        assert_eq!(id.len(), 36, "uuid v4 is 36 chars: {id:?}");
        let bytes = id.as_bytes();
        for index in [8usize, 13, 18, 23] {
            assert_eq!(bytes[index], b'-', "hyphen at {index}: {id:?}");
        }
        assert_eq!(bytes[14], b'4', "version nibble: {id:?}");
        assert!(
            matches!(bytes[19], b'8' | b'9' | b'a' | b'b'),
            "variant nibble: {id:?}"
        );
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    fn assert_iso8601(value: &str) {
        assert!(
            value.ends_with('Z') && value.contains('T') && value.len() >= 20,
            "expected ISO 8601 UTC, got {value:?}"
        );
    }

    // ---- add / list ------------------------------------------------------

    #[test]
    fn adds_file_folder_and_url_favorites_and_lists_by_title() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let folder = repository
            .add(AddFavorite {
                kind: FavoriteKind::Folder,
                title: "Workspace".into(),
                path: Some(r"C:\WorkingFolder\command-cabin".into()),
                keywords: vec!["project".into(), "repo".into()],
                metadata: Some(Map::from_iter([("color".into(), "green".into())])),
                created_at: Some("2026-05-15T10:00:00.000Z".into()),
                updated_at: Some("2026-05-15T10:00:00.000Z".into()),
                ..file_input("", "")
            })
            .expect("add folder");
        let file = repository
            .add(AddFavorite {
                title: "Architecture Notes".into(),
                path: Some(r"C:\WorkingFolder\command-cabin\README.md".into()),
                keywords: vec!["docs".into()],
                created_at: Some("2026-05-15T10:01:00.000Z".into()),
                updated_at: Some("2026-05-15T10:01:00.000Z".into()),
                ..file_input("", "")
            })
            .expect("add file");
        let url = repository
            .add(AddFavorite {
                title: "Issue Tracker".into(),
                keywords: vec!["tickets".into(), "bugs".into()],
                created_at: Some("2026-05-15T10:02:00.000Z".into()),
                updated_at: Some("2026-05-15T10:02:00.000Z".into()),
                ..url_input("", Some("https://example.com/issues"))
            })
            .expect("add url");

        assert!(!file.id.is_empty());
        assert_eq!(file.kind, FavoriteKind::File);
        assert_eq!(file.title, "Architecture Notes");
        assert_eq!(
            file.path.as_deref(),
            Some(r"C:\WorkingFolder\command-cabin\README.md")
        );
        assert_eq!(file.url, None);
        assert_eq!(file.keywords, vec!["docs"]);
        assert_eq!(file.metadata, Map::new());
        assert_eq!(file.created_at, "2026-05-15T10:01:00.000Z");

        assert_eq!(folder.kind, FavoriteKind::Folder);
        assert_eq!(
            folder.path.as_deref(),
            Some(r"C:\WorkingFolder\command-cabin")
        );
        assert_eq!(
            folder.metadata.get("color").and_then(Value::as_str),
            Some("green")
        );

        assert_eq!(url.kind, FavoriteKind::Url);
        assert_eq!(url.url.as_deref(), Some("https://example.com/issues"));
        assert_eq!(url.path, None);

        let titles: Vec<String> = repository
            .list()
            .expect("list")
            .into_iter()
            .map(|favorite| favorite.title)
            .collect();
        assert_eq!(
            titles,
            vec!["Architecture Notes", "Issue Tracker", "Workspace"]
        );
    }

    #[test]
    fn list_orders_case_insensitive_then_by_id() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        for (id, title) in [
            ("fav-b", "banana"),
            ("fav-c", "Apple"),
            ("fav-a", "apple"),
            ("fav-d", "Cherry"),
        ] {
            repository
                .add(AddFavorite {
                    id: Some(id.into()),
                    title: title.into(),
                    ..file_input("", r"C:\x.md")
                })
                .expect("add");
        }

        // NOCASE: Apple/apple 并列时按 id 升序（fav-a 先于 fav-c）。
        let order: Vec<String> = repository
            .list()
            .expect("list")
            .into_iter()
            .map(|favorite| favorite.id)
            .collect();
        assert_eq!(order, vec!["fav-a", "fav-c", "fav-b", "fav-d"]);
    }

    #[test]
    fn add_generates_uuid_v4_and_defaults_dates() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let favorite = repository
            .add(file_input("Readme", r"C:\docs\readme.md"))
            .expect("add");

        assert_uuid_v4(&favorite.id);
        assert_iso8601(&favorite.created_at);
        assert_eq!(favorite.created_at, favorite.updated_at);
        assert_eq!(favorite.keywords, Vec::<String>::new());
        assert_eq!(favorite.metadata, Map::new());
    }

    #[test]
    fn add_trims_title_path_keywords_and_dedups_keywords_in_order() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let favorite = repository
            .add(AddFavorite {
                title: "  Notes  ".into(),
                path: Some("  C:\\docs\\notes.md  ".into()),
                keywords: vec![
                    "  docs ".into(),
                    "docs".into(),
                    "project".into(),
                    " project ".into(),
                ],
                ..file_input("", "")
            })
            .expect("add");

        assert_eq!(favorite.title, "Notes");
        assert_eq!(favorite.path.as_deref(), Some(r"C:\docs\notes.md"));
        assert_eq!(favorite.keywords, vec!["docs", "project"]);

        // 读回的内容同样是归一化后的形态。
        let reloaded = repository.get(&favorite.id).expect("get").expect("exists");
        assert_eq!(reloaded, favorite);
    }

    #[test]
    fn add_rejects_invalid_inputs_with_ts_messages() {
        let cases: Vec<(AddFavorite, &str)> = vec![
            (
                AddFavorite {
                    title: "  ".into(),
                    ..file_input("", r"C:\Docs\notes.md")
                },
                "Favorite title must be a non-empty string",
            ),
            (
                AddFavorite {
                    title: "Notes".into(),
                    path: None,
                    ..file_input("", "")
                },
                "File favorite path must be a non-empty string",
            ),
            (
                AddFavorite {
                    title: "Notes".into(),
                    path: Some("   ".into()),
                    ..file_input("", "")
                },
                "File favorite path must be a non-empty string",
            ),
            (
                AddFavorite {
                    kind: FavoriteKind::Folder,
                    title: "Projects".into(),
                    path: None,
                    ..file_input("", "")
                },
                "Folder favorite path must be a non-empty string",
            ),
            (
                AddFavorite {
                    id: Some("   ".into()),
                    ..file_input("Notes", r"C:\Docs\notes.md")
                },
                "Favorite id must be a non-empty string",
            ),
            (
                AddFavorite {
                    keywords: vec!["ok".into(), "   ".into()],
                    ..url_input("Docs", Some("https://example.com/docs"))
                },
                "Invalid favorite keywords in favorites keywords: favorite keywords[1] must be a non-empty string",
            ),
        ];

        for (input, expected_message) in cases {
            let conn = open_db();
            let repository = FavoritesRepository::new(&conn);

            let err = repository.add(input).expect_err("must be rejected");
            expect_invalid_favorite(&err, expected_message);
            assert!(
                repository.list().expect("list").is_empty(),
                "rejected input must not be written"
            );
        }
    }

    #[test]
    fn add_validates_urls_with_ts_message_verbatim() {
        const MESSAGE: &str = "URL favorite url must be an http or https URL";
        let rejected: Vec<Option<&str>> = vec![
            None,
            Some(""),
            Some("   "),
            Some("javascript:alert(1)"),
            Some("file:///C:/secret.txt"),
            Some("ftp://example.com/x"),
            Some("not-a-url"),
            Some("http://"),
        ];

        for url in rejected {
            let conn = open_db();
            let repository = FavoritesRepository::new(&conn);

            let err = repository
                .add(url_input("Docs", url))
                .expect_err("must be rejected");
            expect_invalid_favorite(&err, MESSAGE);
            assert!(repository.list().expect("list").is_empty());
        }

        for url in [
            "http://example.com",
            "https://example.com/docs",
            "HTTPS://EXAMPLE.COM/Path",
        ] {
            let conn = open_db();
            let repository = FavoritesRepository::new(&conn);

            let favorite = repository
                .add(url_input("Docs", Some(url)))
                .expect("http/https accepted");
            // TS 返回 trim 后的原字符串（不做大小写/格式归一）。
            assert_eq!(favorite.url.as_deref(), Some(url));
        }
    }

    #[test]
    fn add_validates_dates_with_ts_message_verbatim() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let err = repository
            .add(AddFavorite {
                created_at: Some("not-a-date".into()),
                ..file_input("Notes", r"C:\Docs\notes.md")
            })
            .expect_err("bad created_at rejected");
        expect_invalid_favorite(&err, "Invalid date for favorite createdAt: not-a-date");

        let err = repository
            .add(AddFavorite {
                updated_at: Some("2026-13-01T00:00:00Z".into()),
                ..file_input("Notes", r"C:\Docs\notes.md")
            })
            .expect_err("month 13 rejected");
        expect_invalid_favorite(
            &err,
            "Invalid date for favorite updatedAt: 2026-13-01T00:00:00Z",
        );

        let err = repository
            .add(AddFavorite {
                created_at: Some("2026-02-29T00:00:00Z".into()),
                ..file_input("Notes", r"C:\Docs\notes.md")
            })
            .expect_err("2026 is not a leap year");
        expect_invalid_favorite(
            &err,
            "Invalid date for favorite createdAt: 2026-02-29T00:00:00Z",
        );

        assert!(repository.list().expect("list").is_empty());

        // 合法形态：Z、毫秒、闰日、偏移（偏移原样保留，见模块文档的偏差说明）。
        let favorite = repository
            .add(AddFavorite {
                created_at: Some("2024-02-29T12:30:00+02:00".into()),
                ..file_input("Notes", r"C:\Docs\notes.md")
            })
            .expect("leap day with offset accepted");
        assert_eq!(favorite.created_at, "2024-02-29T12:30:00+02:00");
        // updated_at 缺省 = 归一化后的 created_at（对齐 TS）。
        assert_eq!(favorite.updated_at, "2024-02-29T12:30:00+02:00");
    }

    #[test]
    fn add_with_duplicate_id_surfaces_sqlite_error() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        repository
            .add(AddFavorite {
                id: Some("fav-dup".into()),
                ..file_input("First", r"C:\a.md")
            })
            .expect("first add");

        let err = repository
            .add(AddFavorite {
                id: Some("fav-dup".into()),
                ..file_input("Second", r"C:\b.md")
            })
            .expect_err("duplicate id must fail");
        assert!(
            matches!(err, StorageError::Sqlite(_)),
            "expected Sqlite error, got {err:?}"
        );
    }

    // ---- update ----------------------------------------------------------

    #[test]
    fn update_edits_title_and_keywords_without_changing_id_or_created_at() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let created = repository
            .add(AddFavorite {
                keywords: vec!["docs".into()],
                created_at: Some("2026-05-15T10:00:00.000Z".into()),
                updated_at: Some("2026-05-15T10:00:00.000Z".into()),
                ..url_input("Docs", Some("https://example.com/docs"))
            })
            .expect("add");

        let updated = repository
            .update(
                &created.id,
                UpdateFavorite {
                    title: Some("Product Docs".into()),
                    keywords: Some(vec!["manual".into(), "reference".into()]),
                    updated_at: Some("2026-05-15T11:00:00.000Z".into()),
                    ..UpdateFavorite::default()
                },
            )
            .expect("update")
            .expect("exists");

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.created_at, "2026-05-15T10:00:00.000Z");
        assert_eq!(updated.title, "Product Docs");
        assert_eq!(updated.keywords, vec!["manual", "reference"]);
        assert_eq!(updated.updated_at, "2026-05-15T11:00:00.000Z");
        // kind/url 不可变
        assert_eq!(updated.kind, FavoriteKind::Url);
        assert_eq!(updated.url.as_deref(), Some("https://example.com/docs"));

        let reloaded = repository.get(&created.id).expect("get").expect("exists");
        assert_eq!(reloaded.title, "Product Docs");
    }

    #[test]
    fn update_returns_none_for_missing_id() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let result = repository
            .update(
                "missing",
                UpdateFavorite {
                    title: Some("Nope".into()),
                    ..UpdateFavorite::default()
                },
            )
            .expect("update");
        assert_eq!(result, None);
    }

    #[test]
    fn update_preserves_immutable_kind_path_url_and_untouched_fields() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let created = repository
            .add(AddFavorite {
                keywords: vec!["docs".into()],
                metadata: Some(Map::from_iter([("color".into(), "blue".into())])),
                created_at: Some("2026-05-15T10:00:00.000Z".into()),
                updated_at: Some("2026-05-15T10:00:00.000Z".into()),
                ..file_input("Notes", r"C:\Docs\notes.md")
            })
            .expect("add");

        let updated = repository
            .update(
                &created.id,
                UpdateFavorite {
                    title: Some("Renamed".into()),
                    updated_at: Some("2026-05-15T12:00:00.000Z".into()),
                    ..UpdateFavorite::default()
                },
            )
            .expect("update")
            .expect("exists");

        assert_eq!(updated.title, "Renamed");
        assert_eq!(updated.kind, FavoriteKind::File);
        assert_eq!(updated.path.as_deref(), Some(r"C:\Docs\notes.md"));
        assert_eq!(updated.url, None);
        // 未提供的字段保持原值
        assert_eq!(updated.keywords, vec!["docs"]);
        assert_eq!(
            updated.metadata.get("color").and_then(Value::as_str),
            Some("blue")
        );
        assert_eq!(updated.created_at, "2026-05-15T10:00:00.000Z");
        assert_eq!(updated.updated_at, "2026-05-15T12:00:00.000Z");
    }

    #[test]
    fn update_defaults_updated_at_to_now() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let created = repository
            .add(AddFavorite {
                created_at: Some("2026-05-15T10:00:00.000Z".into()),
                updated_at: Some("2026-05-15T10:00:00.000Z".into()),
                ..file_input("Notes", r"C:\Docs\notes.md")
            })
            .expect("add");

        let updated = repository
            .update(&created.id, UpdateFavorite::default())
            .expect("update")
            .expect("exists");

        assert_eq!(updated.title, created.title);
        assert_eq!(updated.created_at, "2026-05-15T10:00:00.000Z");
        assert_iso8601(&updated.updated_at);
        assert_ne!(updated.updated_at, "2026-05-15T10:00:00.000Z");
    }

    #[test]
    fn update_replaces_metadata_when_provided() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let created = repository
            .add(AddFavorite {
                metadata: Some(Map::from_iter([("color".into(), "blue".into())])),
                ..file_input("Notes", r"C:\Docs\notes.md")
            })
            .expect("add");

        let updated = repository
            .update(
                &created.id,
                UpdateFavorite {
                    metadata: Some(Map::new()),
                    ..UpdateFavorite::default()
                },
            )
            .expect("update")
            .expect("exists");

        assert_eq!(updated.metadata, Map::new());
    }

    #[test]
    fn update_rejects_invalid_input_with_ts_messages_without_touching_row() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let created = repository
            .add(AddFavorite {
                keywords: vec!["docs".into()],
                created_at: Some("2026-05-15T10:00:00.000Z".into()),
                updated_at: Some("2026-05-15T10:00:00.000Z".into()),
                ..file_input("Notes", r"C:\Docs\notes.md")
            })
            .expect("add");

        let err = repository
            .update(
                &created.id,
                UpdateFavorite {
                    title: Some("   ".into()),
                    ..UpdateFavorite::default()
                },
            )
            .expect_err("blank title rejected");
        expect_invalid_favorite(&err, "Favorite title must be a non-empty string");

        let err = repository
            .update(
                &created.id,
                UpdateFavorite {
                    keywords: Some(vec!["".into()]),
                    ..UpdateFavorite::default()
                },
            )
            .expect_err("blank keyword rejected");
        expect_invalid_favorite(
            &err,
            "Invalid favorite keywords in favorites keywords: favorite keywords[0] must be a non-empty string",
        );

        let err = repository
            .update(
                &created.id,
                UpdateFavorite {
                    updated_at: Some("garbage".into()),
                    ..UpdateFavorite::default()
                },
            )
            .expect_err("bad updated_at rejected");
        expect_invalid_favorite(&err, "Invalid date for favorite updatedAt: garbage");

        // 被拒的更新不落库。
        let reloaded = repository.get(&created.id).expect("get").expect("exists");
        assert_eq!(reloaded, created);
    }

    // ---- get / remove ----------------------------------------------------

    #[test]
    fn get_returns_none_for_missing_id() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);
        assert_eq!(repository.get("missing").expect("get"), None);
    }

    #[test]
    fn remove_deletes_by_id_and_reports_whether_a_row_changed() {
        let conn = open_db();
        let repository = FavoritesRepository::new(&conn);

        let created = repository
            .add(file_input(
                "Readme",
                r"C:\WorkingFolder\command-cabin\README.md",
            ))
            .expect("add");

        assert!(repository.remove(&created.id).expect("remove"));
        assert!(!repository.remove(&created.id).expect("remove again"));
        assert_eq!(repository.get(&created.id).expect("get"), None);
        assert!(repository.list().expect("list").is_empty());
    }

    // ---- 存储行（读路径）校验 --------------------------------------------

    /// 手写 favorites 行（绕过仓储校验，模拟损坏/旧版数据）。
    struct RawRow<'a> {
        id: &'a str,
        kind: &'a str,
        title: &'a str,
        path: Option<&'a str>,
        url: Option<&'a str>,
        keywords: &'a str,
        metadata: &'a str,
        created_at: &'a str,
        updated_at: &'a str,
    }

    fn raw_row(id: &str) -> RawRow<'_> {
        RawRow {
            id,
            kind: "file",
            title: "Title",
            path: Some(r"C:\a.md"),
            url: None,
            keywords: "[]",
            metadata: "{}",
            created_at: "2026-05-15T10:00:00.000Z",
            updated_at: "2026-05-15T10:00:00.000Z",
        }
    }

    fn insert_row(conn: &Connection, row: RawRow<'_>) {
        conn.execute(
            "INSERT INTO favorites (id, kind, title, path, url, keywords, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                row.id,
                row.kind,
                row.title,
                row.path,
                row.url,
                row.keywords,
                row.metadata,
                row.created_at,
                row.updated_at
            ],
        )
        .expect("insert raw favorite row");
    }

    #[test]
    fn stored_row_with_malformed_keywords_json_errors_with_context() {
        let conn = open_db();
        insert_row(
            &conn,
            RawRow {
                id: "favorite-bad-json",
                title: "Broken",
                path: Some(r"C:\Docs\broken.md"),
                keywords: "{bad-json",
                ..raw_row("")
            },
        );

        let repository = FavoritesRepository::new(&conn);
        let err = repository.get("favorite-bad-json").expect_err("must fail");
        expect_invalid_favorite_prefix(
            &err,
            "Invalid JSON in favorites keywords key \"favorite-bad-json\": ",
        );
    }

    #[test]
    fn stored_url_favorite_with_unsafe_protocol_is_rejected_on_get_and_list() {
        let conn = open_db();
        insert_row(
            &conn,
            RawRow {
                id: "favorite-file-url",
                kind: "url",
                title: "Local File",
                path: None,
                url: Some("file:///C:/secret.txt"),
                ..raw_row("")
            },
        );

        let repository = FavoritesRepository::new(&conn);
        let err = repository
            .get("favorite-file-url")
            .expect_err("get must fail");
        expect_invalid_favorite(&err, "URL favorite url must be an http or https URL");
        let err = repository.list().expect_err("list must fail");
        expect_invalid_favorite(&err, "URL favorite url must be an http or https URL");
    }

    #[test]
    fn stored_rows_with_blank_title_or_invalid_date_are_rejected() {
        let conn = open_db();
        insert_row(
            &conn,
            RawRow {
                id: "favorite-blank-title",
                title: "   ",
                path: Some(r"C:\Docs\blank.md"),
                ..raw_row("")
            },
        );
        insert_row(
            &conn,
            RawRow {
                id: "favorite-invalid-date",
                title: "Invalid Date",
                path: Some(r"C:\Docs\date.md"),
                created_at: "not-a-date",
                ..raw_row("")
            },
        );

        let repository = FavoritesRepository::new(&conn);
        let err = repository
            .get("favorite-blank-title")
            .expect_err("must fail");
        expect_invalid_favorite(&err, "Favorite title must be a non-empty string");
        let err = repository
            .get("favorite-invalid-date")
            .expect_err("must fail");
        expect_invalid_favorite(&err, "Invalid date for favorite createdAt: not-a-date");
    }

    #[test]
    fn stored_row_shape_violations_are_rejected_with_ts_messages() {
        struct Case {
            id: &'static str,
            expected_message: &'static str,
            keywords: &'static str,
            metadata: &'static str,
        }

        // 注：迁移 2 的 CHECK 约束已挡住“空白 path / 缺 url / 非法 kind”入库，
        // map_favorite_row 的对应分支为防御性代码（TS 同），无法经真实 DB 覆盖。
        let cases = [
            Case {
                id: "favorite-keywords-object",
                expected_message: "Invalid favorite keywords in favorites keywords key \"favorite-keywords-object\": favorite keywords must be an array",
                keywords: "{}",
                metadata: "{}",
            },
            Case {
                id: "favorite-keywords-non-string",
                expected_message: "Invalid favorite keywords in favorites keywords key \"favorite-keywords-non-string\": favorite keywords[0] must be a string",
                keywords: "[1]",
                metadata: "{}",
            },
            Case {
                id: "favorite-keywords-blank",
                expected_message: "Invalid favorite keywords in favorites keywords key \"favorite-keywords-blank\": favorite keywords[0] must be a non-empty string",
                keywords: "[\"  \"]",
                metadata: "{}",
            },
            Case {
                id: "favorite-metadata-array",
                expected_message: "Invalid favorite metadata in favorites metadata key \"favorite-metadata-array\": metadata must be an object",
                keywords: "[]",
                metadata: "[1,2]",
            },
        ];

        for case in cases {
            let conn = open_db();
            insert_row(
                &conn,
                RawRow {
                    id: case.id,
                    keywords: case.keywords,
                    metadata: case.metadata,
                    ..raw_row("")
                },
            );

            let repository = FavoritesRepository::new(&conn);
            let err = repository.get(case.id).expect_err("must fail");
            expect_invalid_favorite(&err, case.expected_message);
        }
    }

    #[test]
    fn stored_keywords_are_trimmed_and_deduped_on_read() {
        let conn = open_db();
        insert_row(
            &conn,
            RawRow {
                id: "favorite-dedup",
                title: "Notes",
                keywords: "[\"  docs \", \"docs\", \"project\"]",
                ..raw_row("")
            },
        );

        let repository = FavoritesRepository::new(&conn);
        let favorite = repository
            .get("favorite-dedup")
            .expect("get")
            .expect("exists");
        assert_eq!(favorite.keywords, vec!["docs", "project"]);
    }
}
