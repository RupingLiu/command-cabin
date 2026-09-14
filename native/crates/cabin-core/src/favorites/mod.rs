//! 收藏数据模型与收藏命令映射。
//!
//! `FavoriteRecord`/`FavoriteKind` 移植自
//! `packages/core/src/indexer/favoritesRepository.ts` 的类型定义；
//! 命令映射移植自 `packages/core/src/command/builtInFavorites.ts`。
//!
//! 类型放在 cabin-core（对齐 `IndexedShortcut` 先例），cabin-storage 的
//! 收藏仓储复用之，保持“storage 依赖 core、core 不依赖 storage”的分层。
//!
//! 记录不变量（由 cabin-storage 仓储在写入/读取边界校验）：
//! `kind` 为 file/folder 时 `path` 必填非空且 `url` 为 `None`；
//! `kind` 为 url 时 `url` 必填 http/https 且 `path` 为 `None`。

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::command::types::{
    Command, CommandAction, CommandActionType, CommandPayload, CommandSource,
};
use crate::search::tokenize::normalize_search_keywords;

/// 收藏类别（TS `FavoriteKind`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FavoriteKind {
    File,
    Folder,
    Url,
}

impl FavoriteKind {
    /// TS 字面量形式：`"file" | "folder" | "url"`。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Folder => "folder",
            Self::Url => "url",
        }
    }

    /// 从 TS 字面量解析；未知值返回 `None`。
    pub fn parse(kind: &str) -> Option<FavoriteKind> {
        match kind {
            "file" => Some(Self::File),
            "folder" => Some(Self::Folder),
            "url" => Some(Self::Url),
            _ => None,
        }
    }
}

/// 一条收藏记录（TS `FavoriteRecord` 三变体的合并形态）。
#[derive(Debug, Clone, PartialEq)]
pub struct FavoriteRecord {
    pub id: String,
    pub kind: FavoriteKind,
    pub title: String,
    /// file/folder 必填非空；url 必须为 `None`。
    pub path: Option<String>,
    /// url 必填 http/https；file/folder 必须为 `None`。
    pub url: Option<String>,
    /// trim 后非空、去重保序。
    pub keywords: Vec<String>,
    /// 严格 JSON object。
    pub metadata: Map<String, Value>,
    /// ISO 8601 时间戳。
    pub created_at: String,
    pub updated_at: String,
}

/// 启动器固定应用元数据键（TS `LAUNCHER_PINNED_APP_METADATA_KEY`）。
pub const LAUNCHER_PINNED_APP_METADATA_KEY: &str = "launcherPinnedApp";
/// TS `LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY`。
pub const LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY: &str =
    "launcherPinnedAppExecutablePath";
/// TS `LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY`。
pub const LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY: &str = "launcherPinnedAppIconPath";
/// 可固定为启动器应用的收藏扩展名（不含点）。
pub const PINNED_APP_EXTENSIONS: [&str; 2] = ["exe", "lnk"];

/// 收藏命令 id：`favorite.<sha256(favorite_id) 前 12 hex>`
/// （TS `createFavoriteCommandId`）。
pub fn favorite_command_id(favorite_id: &str) -> String {
    let digest = Sha256::digest(favorite_id.as_bytes());
    let hex = digest
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!("favorite.{hex}")
}

/// 启动器固定应用判定（TS `isLauncherPinnedAppFavorite`）：
/// kind == file 且 metadata.launcherPinnedApp === true。
pub fn is_launcher_pinned_app(favorite: &FavoriteRecord) -> bool {
    favorite.kind == FavoriteKind::File
        && favorite.metadata.get(LAUNCHER_PINNED_APP_METADATA_KEY) == Some(&Value::Bool(true))
}

/// TS `getFavoriteMetadataString`：仅接受 trim 后非空的字符串值（返回原值不去空白）。
fn metadata_string(favorite: &FavoriteRecord, key: &str) -> Option<String> {
    favorite
        .metadata
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

/// 收藏 → Command（TS `createFavoriteCommand`）。
///
/// - pinned app → source=app, action=open-app, payload
///   `{ executablePath, favoriteId, shortcutPath }`；subtitle=executablePath，
///   icon=iconPath（缺省回退 executablePath，再缺省回退 path）。
/// - url → source=url, action=open-url, payload `{ favoriteId, url }`。
/// - file/folder → source=file, action=open-path, payload
///   `{ favoriteId, favoriteKind, path }`。
///
/// 期望传入满足记录不变量的 `FavoriteRecord`（来自仓储的记录均满足）。
///
/// # Panics
///
/// pinned app 收藏缺 `path` 时 panic，对齐 TS 抛错
/// `Pinned app favorite path is missing.`。
pub fn command_from_favorite(favorite: &FavoriteRecord) -> Command {
    let mut keyword_input = Vec::with_capacity(favorite.keywords.len() + 2);
    keyword_input.push(favorite.title.clone());
    keyword_input.extend(favorite.keywords.iter().cloned());
    keyword_input.push(favorite.kind.as_str().to_string());
    let keywords = normalize_search_keywords(&keyword_input);

    let subtitle = match favorite.kind {
        FavoriteKind::Url => favorite.url.clone(),
        FavoriteKind::File | FavoriteKind::Folder => favorite.path.clone(),
    };

    if is_launcher_pinned_app(favorite) {
        let app_path = favorite
            .path
            .clone()
            .expect("Pinned app favorite path is missing.");
        let executable_path =
            metadata_string(favorite, LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY)
                .unwrap_or_else(|| app_path.clone());
        let icon_path = metadata_string(favorite, LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY)
            .unwrap_or_else(|| executable_path.clone());

        let mut payload = CommandPayload::new();
        payload.insert("executablePath".into(), executable_path.clone().into());
        payload.insert("favoriteId".into(), favorite.id.clone().into());
        payload.insert("shortcutPath".into(), app_path.into());

        return Command {
            id: favorite_command_id(&favorite.id),
            source: CommandSource::App,
            title: favorite.title.clone(),
            subtitle: Some(executable_path),
            keywords,
            icon: Some(icon_path),
            plugin_id: None,
            action: CommandAction {
                action_type: CommandActionType::OpenApp,
                payload,
            },
        };
    }

    if favorite.kind == FavoriteKind::Url {
        let mut payload = CommandPayload::new();
        payload.insert("favoriteId".into(), favorite.id.clone().into());
        // 不变量保证 url 存在；手造记录缺 url 时对齐 TS JSON 序列化丢弃 undefined 键的行为。
        if let Some(url) = &favorite.url {
            payload.insert("url".into(), url.clone().into());
        }

        return Command {
            id: favorite_command_id(&favorite.id),
            source: CommandSource::Url,
            title: favorite.title.clone(),
            subtitle,
            keywords,
            icon: None,
            plugin_id: None,
            action: CommandAction {
                action_type: CommandActionType::OpenUrl,
                payload,
            },
        };
    }

    let mut payload = CommandPayload::new();
    payload.insert("favoriteId".into(), favorite.id.clone().into());
    payload.insert("favoriteKind".into(), favorite.kind.as_str().into());
    if let Some(path) = &favorite.path {
        payload.insert("path".into(), path.clone().into());
    }

    Command {
        id: favorite_command_id(&favorite.id),
        source: CommandSource::File,
        title: favorite.title.clone(),
        subtitle,
        keywords,
        icon: None,
        plugin_id: None,
        action: CommandAction {
            action_type: CommandActionType::OpenPath,
            payload,
        },
    }
}

/// 批量转换（TS `createFavoriteCommands`）：按命令 id 去重，先发先留。
pub fn commands_from_favorites(favorites: &[FavoriteRecord]) -> Vec<Command> {
    let mut seen = std::collections::HashSet::new();
    favorites
        .iter()
        .map(command_from_favorite)
        .filter(|command| seen.insert(command.id.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_favorite() -> FavoriteRecord {
        FavoriteRecord {
            id: "favorite-docs".into(),
            kind: FavoriteKind::File,
            title: "Project Docs".into(),
            path: Some(r"C:\Docs\Project.md".into()),
            url: None,
            keywords: vec!["docs".into(), "project".into()],
            metadata: Map::new(),
            created_at: "2026-05-15T10:00:00.000Z".into(),
            updated_at: "2026-05-15T10:00:00.000Z".into(),
        }
    }

    #[test]
    fn favorite_command_id_is_sha256_prefix() {
        // sha256("favorite-docs") = a9d14c6e3ea7a52f...
        assert_eq!(
            favorite_command_id("favorite-docs"),
            "favorite.a9d14c6e3ea7"
        );
        // sha256("abc") = ba7816bf8f01cfea...
        assert_eq!(favorite_command_id("abc"), "favorite.ba7816bf8f01");
        // sha256("favorite-wps") = ac3e69955c9addcf...
        assert_eq!(favorite_command_id("favorite-wps"), "favorite.ac3e69955c9a");
    }

    #[test]
    fn favorite_kind_round_trips_ts_literals() {
        for (kind, literal) in [
            (FavoriteKind::File, "file"),
            (FavoriteKind::Folder, "folder"),
            (FavoriteKind::Url, "url"),
        ] {
            assert_eq!(kind.as_str(), literal);
            assert_eq!(FavoriteKind::parse(literal), Some(kind));
        }
        assert_eq!(FavoriteKind::parse("app"), None);
        assert_eq!(FavoriteKind::parse("FILE"), None);
    }

    #[test]
    fn file_and_folder_favorites_become_open_path_commands() {
        let file_command = command_from_favorite(&sample_favorite());
        let folder = FavoriteRecord {
            id: "favorite-folder".into(),
            kind: FavoriteKind::Folder,
            title: "Workspace".into(),
            path: Some(r"C:\WorkingFolder\command-cabin".into()),
            url: None,
            keywords: vec!["repo".into()],
            metadata: Map::new(),
            created_at: "2026-05-15T10:00:00.000Z".into(),
            updated_at: "2026-05-15T10:00:00.000Z".into(),
        };
        let folder_command = command_from_favorite(&folder);

        assert_eq!(file_command.source, CommandSource::File);
        assert_eq!(file_command.title, "Project Docs");
        assert_eq!(
            file_command.subtitle.as_deref(),
            Some(r"C:\Docs\Project.md")
        );
        assert_eq!(file_command.action.action_type, CommandActionType::OpenPath);
        assert_eq!(
            file_command
                .action
                .payload
                .get("favoriteId")
                .and_then(Value::as_str),
            Some("favorite-docs")
        );
        assert_eq!(
            file_command
                .action
                .payload
                .get("favoriteKind")
                .and_then(Value::as_str),
            Some("file")
        );
        assert_eq!(
            file_command
                .action
                .payload
                .get("path")
                .and_then(Value::as_str),
            Some(r"C:\Docs\Project.md")
        );
        assert_eq!(
            file_command.keywords,
            vec!["project docs", "docs", "project", "file"]
        );

        assert_eq!(folder_command.source, CommandSource::File);
        assert_eq!(
            folder_command.action.action_type,
            CommandActionType::OpenPath
        );
        assert_eq!(
            folder_command
                .action
                .payload
                .get("favoriteId")
                .and_then(Value::as_str),
            Some("favorite-folder")
        );
        assert_eq!(
            folder_command
                .action
                .payload
                .get("favoriteKind")
                .and_then(Value::as_str),
            Some("folder")
        );
        assert_eq!(
            folder_command
                .action
                .payload
                .get("path")
                .and_then(Value::as_str),
            Some(r"C:\WorkingFolder\command-cabin")
        );
    }

    #[test]
    fn url_favorites_become_open_url_commands() {
        let favorite = FavoriteRecord {
            id: "favorite-url".into(),
            kind: FavoriteKind::Url,
            title: "Issue Tracker".into(),
            path: None,
            url: Some("https://example.com/issues".into()),
            keywords: vec!["bugs".into()],
            metadata: Map::new(),
            created_at: "2026-05-15T10:00:00.000Z".into(),
            updated_at: "2026-05-15T10:00:00.000Z".into(),
        };

        let command = command_from_favorite(&favorite);

        assert_eq!(command.source, CommandSource::Url);
        assert_eq!(command.title, "Issue Tracker");
        assert_eq!(
            command.subtitle.as_deref(),
            Some("https://example.com/issues")
        );
        assert_eq!(command.action.action_type, CommandActionType::OpenUrl);
        assert_eq!(
            command
                .action
                .payload
                .get("favoriteId")
                .and_then(Value::as_str),
            Some("favorite-url")
        );
        assert_eq!(
            command.action.payload.get("url").and_then(Value::as_str),
            Some("https://example.com/issues")
        );
        assert_eq!(command.keywords, vec!["issue tracker", "bugs", "url"]);
    }

    #[test]
    fn pinned_app_favorites_become_app_commands() {
        let mut favorite = FavoriteRecord {
            id: "favorite-wps".into(),
            title: "WPS Office".into(),
            path: Some(r"C:\Program Files\WPS Office\ksolaunch.exe".into()),
            keywords: vec!["wps".into()],
            ..sample_favorite()
        };
        favorite
            .metadata
            .insert(LAUNCHER_PINNED_APP_METADATA_KEY.into(), Value::Bool(true));

        let command = command_from_favorite(&favorite);

        assert_eq!(command.source, CommandSource::App);
        assert_eq!(command.title, "WPS Office");
        assert_eq!(
            command.subtitle.as_deref(),
            Some(r"C:\Program Files\WPS Office\ksolaunch.exe")
        );
        assert_eq!(
            command.icon.as_deref(),
            Some(r"C:\Program Files\WPS Office\ksolaunch.exe")
        );
        assert_eq!(command.action.action_type, CommandActionType::OpenApp);
        assert_eq!(
            command
                .action
                .payload
                .get("executablePath")
                .and_then(Value::as_str),
            Some(r"C:\Program Files\WPS Office\ksolaunch.exe")
        );
        assert_eq!(
            command
                .action
                .payload
                .get("favoriteId")
                .and_then(Value::as_str),
            Some("favorite-wps")
        );
        assert_eq!(
            command
                .action
                .payload
                .get("shortcutPath")
                .and_then(Value::as_str),
            Some(r"C:\Program Files\WPS Office\ksolaunch.exe")
        );
    }

    #[test]
    fn pinned_app_uses_resolved_executable_and_icon_metadata() {
        let mut favorite = FavoriteRecord {
            id: "favorite-codex".into(),
            title: "Codex".into(),
            path: Some(r"C:\Users\Ada\Desktop\Codex.lnk".into()),
            keywords: vec!["codex".into()],
            ..sample_favorite()
        };
        favorite
            .metadata
            .insert(LAUNCHER_PINNED_APP_METADATA_KEY.into(), Value::Bool(true));
        favorite.metadata.insert(
            LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY.into(),
            r"C:\Users\Ada\AppData\Local\Programs\Codex\Codex.exe".into(),
        );
        favorite.metadata.insert(
            LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY.into(),
            r"C:\Users\Ada\AppData\Local\Programs\Codex\Codex.exe,0".into(),
        );

        let command = command_from_favorite(&favorite);

        assert_eq!(command.source, CommandSource::App);
        assert_eq!(
            command.subtitle.as_deref(),
            Some(r"C:\Users\Ada\AppData\Local\Programs\Codex\Codex.exe")
        );
        assert_eq!(
            command.icon.as_deref(),
            Some(r"C:\Users\Ada\AppData\Local\Programs\Codex\Codex.exe,0")
        );
        assert_eq!(
            command
                .action
                .payload
                .get("executablePath")
                .and_then(Value::as_str),
            Some(r"C:\Users\Ada\AppData\Local\Programs\Codex\Codex.exe")
        );
        assert_eq!(
            command
                .action
                .payload
                .get("shortcutPath")
                .and_then(Value::as_str),
            Some(r"C:\Users\Ada\Desktop\Codex.lnk")
        );
    }

    #[test]
    fn pinned_app_metadata_falls_back_when_blank_or_non_string() {
        let mut favorite = FavoriteRecord {
            path: Some(r"C:\Apps\Tool.exe".into()),
            ..sample_favorite()
        };
        favorite
            .metadata
            .insert(LAUNCHER_PINNED_APP_METADATA_KEY.into(), Value::Bool(true));
        favorite.metadata.insert(
            LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY.into(),
            Value::Number(42.into()),
        );
        favorite.metadata.insert(
            LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY.into(),
            "   ".into(),
        );

        let command = command_from_favorite(&favorite);

        assert_eq!(command.subtitle.as_deref(), Some(r"C:\Apps\Tool.exe"));
        assert_eq!(command.icon.as_deref(), Some(r"C:\Apps\Tool.exe"));
    }

    #[test]
    fn pinned_app_detection_requires_file_kind_and_true_flag() {
        let mut favorite = sample_favorite();
        assert!(!is_launcher_pinned_app(&favorite));

        favorite
            .metadata
            .insert(LAUNCHER_PINNED_APP_METADATA_KEY.into(), Value::Bool(true));
        assert!(is_launcher_pinned_app(&favorite));

        // folder + flag 不算 pinned
        let mut folder = favorite.clone();
        folder.kind = FavoriteKind::Folder;
        assert!(!is_launcher_pinned_app(&folder));

        // 非 true 真值不算 pinned
        let mut string_flag = favorite.clone();
        string_flag
            .metadata
            .insert(LAUNCHER_PINNED_APP_METADATA_KEY.into(), "true".into());
        assert!(!is_launcher_pinned_app(&string_flag));
    }

    #[test]
    #[should_panic(expected = "Pinned app favorite path is missing.")]
    fn pinned_app_without_path_panics_like_ts_throws() {
        let mut favorite = FavoriteRecord {
            path: None,
            ..sample_favorite()
        };
        favorite
            .metadata
            .insert(LAUNCHER_PINNED_APP_METADATA_KEY.into(), Value::Bool(true));

        let _ = command_from_favorite(&favorite);
    }

    #[test]
    fn command_ids_stay_stable_across_title_and_keyword_edits() {
        let original = command_from_favorite(&sample_favorite());
        let edited = command_from_favorite(&FavoriteRecord {
            title: "Renamed Docs".into(),
            keywords: vec!["manual".into()],
            updated_at: "2026-05-15T11:00:00.000Z".into(),
            ..sample_favorite()
        });

        assert!(original.id.starts_with("favorite."));
        assert_eq!(original.id.len(), "favorite.".len() + 12);
        assert!(original.id["favorite.".len()..]
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
        assert_eq!(edited.id, original.id);
    }

    #[test]
    fn commands_from_favorites_drops_duplicate_command_ids_first_wins() {
        let duplicate = FavoriteRecord {
            title: "Duplicate Docs".into(),
            keywords: vec!["duplicate".into()],
            ..sample_favorite()
        };
        let url = FavoriteRecord {
            id: "favorite-url".into(),
            kind: FavoriteKind::Url,
            title: "Issue Tracker".into(),
            path: None,
            url: Some("https://example.com/issues".into()),
            keywords: vec!["bugs".into()],
            metadata: Map::new(),
            created_at: "2026-05-15T10:00:00.000Z".into(),
            updated_at: "2026-05-15T10:00:00.000Z".into(),
        };

        let commands = commands_from_favorites(&[sample_favorite(), duplicate, url]);

        let titles: Vec<&str> = commands.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["Project Docs", "Issue Tracker"]);
        let ids: std::collections::HashSet<&str> = commands.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids.len(), commands.len());
    }
}
