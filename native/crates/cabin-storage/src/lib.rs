//! cabin-storage: SQLite persistence for CommandCabin.
//!
//! Owns the migration framework ported verbatim from
//! `packages/core/src/storage/migrations.ts` so the native build can reuse the
//! existing `command-cabin.sqlite` database.

pub mod clipboard;
pub mod error;
pub mod favorites;
pub mod history;
pub mod migrations;
pub mod settings;
mod timestamp;

pub use clipboard::{
    ClipboardHistoryEntry, ClipboardHistoryRepository, CLIPBOARD_HISTORY_MAX_TEXT_LENGTH,
    DEFAULT_CLIPBOARD_HISTORY_LIMIT, MAX_CLIPBOARD_HISTORY_LIMIT,
};
pub use error::StorageError;
pub use favorites::{AddFavorite, FavoritesRepository, UpdateFavorite};
pub use history::{
    CommandHistoryEntry, HistoryRepository, RecordExecution, DEFAULT_RECENT_HISTORY_LIMIT,
    MAX_RECENT_HISTORY_LIMIT,
};
pub use migrations::{
    run_migrations, validate_migration_definitions, Migration, MigrationResult, MIGRATIONS,
};
pub use settings::{SettingsRepository, SETTINGS_KEY};
