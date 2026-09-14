//! Storage error types shared by the persistence layer.

use thiserror::Error;

/// Errors surfaced by cabin-storage.
#[derive(Debug, Error)]
pub enum StorageError {
    /// Static migration definitions failed validation.
    #[error("Invalid storage migrations: {0}")]
    InvalidMigrationDefinitions(String),
    /// Applied migration bookkeeping rows failed verification.
    #[error("Invalid applied storage migrations: {0}")]
    InvalidAppliedMigrations(String),
    /// Stored settings JSON failed parsing or load-time validation, or a
    /// settings patch failed validation before write. The message mirrors the
    /// TS `settingsRepository.ts` error prefix.
    #[error("Invalid settings in settings key \"command-cabin\": {0}")]
    InvalidSettings(String),
    /// Favorite input or stored favorite row failed validation. Carries the
    /// full TS `favoritesRepository.ts` error message verbatim (those messages
    /// have no common prefix, so the variant stores the complete text).
    #[error("{0}")]
    InvalidFavorite(String),
    /// Command history input or stored history row failed validation. Carries
    /// the full TS `historyRepository.ts` error message verbatim where a TS
    /// counterpart exists (same rationale as `InvalidFavorite`).
    #[error("{0}")]
    InvalidCommandHistory(String),
    /// Clipboard history input or stored row failed validation. Carries the
    /// full TS `clipboardRepository.ts` error message verbatim (same rationale
    /// as `InvalidFavorite`).
    #[error("{0}")]
    InvalidClipboardHistory(String),
    /// Underlying SQLite failure.
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}
