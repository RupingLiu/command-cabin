export { createDefaultSettings } from './defaultSettings.js';
export type { CommandCabinDefaults } from './defaultSettings.js';
export {
  DEFAULT_COMMAND_CABIN_SETTINGS,
  createDefaultCommandCabinSettings,
  createInMemorySettingsStore,
} from './storage/settings.js';
export type {
  CommandCabinLanguage,
  CommandCabinSearchSettings,
  CommandCabinSettings,
  CommandCabinSettingsPatch,
  CommandCabinSettingsStore,
  CommandCabinTheme,
} from './storage/settings.js';
export {
  openInMemoryCommandCabinDatabase,
  openCommandCabinDatabase,
  parseStorageJson,
  stringifyStorageJson,
} from './storage/database.js';
export type {
  CommandCabinDatabase,
  CommandCabinDatabaseOptions,
  StorageJsonObject,
  StorageJsonPrimitive,
  StorageJsonValue,
} from './storage/database.js';
export { runMigrations } from './storage/migrations.js';
export type { MigrationResult, StorageMigration } from './storage/migrations.js';
export { createSettingsRepository } from './storage/settingsRepository.js';
export { createHistoryRepository } from './storage/historyRepository.js';
export type {
  CommandHistoryEntry,
  HistoryRepository,
  RecordCommandExecutionInput,
} from './storage/historyRepository.js';
export { createFavoritesRepository } from './indexer/favoritesRepository.js';
export type {
  AddFavoriteInput,
  FavoriteKind,
  FavoriteRecord,
  FavoritesRepository,
  UpdateFavoriteInput,
} from './indexer/favoritesRepository.js';
export { createPluginRepository } from './storage/pluginRepository.js';
export type {
  PluginRecord,
  PluginRepository,
  UpsertPluginInput,
} from './storage/pluginRepository.js';
export { DuplicateCommandIdError, createCommandRegistry } from './command/commandRegistry.js';
export type { CommandRegistry } from './command/commandRegistry.js';
export { createCommandExecutor } from './command/commandExecutor.js';
export type { CommandExecutor, CommandExecutorOptions } from './command/commandExecutor.js';
export {
  createFavoriteCommand,
  createFavoriteCommandId,
  createFavoriteCommands,
} from './command/builtInFavorites.js';
export type {
  Command,
  CommandAction,
  CommandActionHandler,
  CommandActionHandlers,
  CommandActionType,
  CommandExecutionFailure,
  CommandExecutionMetadata,
  CommandExecutionResult,
  CommandExecutionSuccess,
  CommandHandlerResult,
  CommandJsonObject,
  CommandJsonPrimitive,
  CommandJsonValue,
  CommandPayload,
  CommandSource,
  ReadonlyCommand,
  ReadonlyCommandAction,
  ReadonlyCommandJsonObject,
  ReadonlyCommandJsonValue,
} from './command/types.js';
export { createSearchEngine, SearchEngine } from './search/searchEngine.js';
export type { SearchEngineOptions, SearchOptions, SearchResult } from './search/searchEngine.js';
export {
  SEARCH_FIELD_SCORE_WEIGHTS,
  SEARCH_RANKING_BOOSTS,
  SEARCH_SOURCE_SCORE_WEIGHTS,
  rankSearchCandidate,
} from './search/ranking.js';
export type {
  SearchMatchedBy,
  SearchMatchField,
  SearchRankingComponents,
  SearchRankingContext,
  SearchRankingExplanation,
  SearchRankingHistoryEntry,
  SearchRankingInput,
  SearchRankingResult,
} from './search/ranking.js';
export {
  normalizeSearchKeywords,
  normalizeSearchText,
  tokenizeSearchText,
} from './search/tokenize.js';
export { createAppCommandsFromShortcuts, createAppIndexer } from './indexer/appIndexer.js';
export type {
  AppIndexSnapshot,
  AppIndexer,
  AppIndexerOptions,
  AppIndexerScanner,
} from './indexer/appIndexer.js';
export { createIndexCache } from './indexer/indexCache.js';
export type {
  AppIndexCache,
  AppIndexCacheSnapshot,
  IndexCacheFileSystem,
  IndexCacheOptions,
} from './indexer/indexCache.js';
export {
  createWindowsShortcutResolver,
  createWindowsStartMenuScanner,
  getDefaultWindowsStartMenuDirectories,
} from './indexer/windows/startMenuScanner.js';
export type {
  ResolvedShortcut,
  ShortcutResolver,
  StartMenuDirectoryEntry,
  StartMenuDirectoryEntryKind,
  StartMenuFileSystem,
  StartMenuScanFailure,
  StartMenuScanResult,
  StartMenuShortcut,
  WindowsStartMenuScanner,
  WindowsStartMenuScannerOptions,
  WindowsShortcutResolverExecFile,
  WindowsShortcutResolverExecFileOptions,
  WindowsShortcutResolverExecFileResult,
  WindowsShortcutResolverOptions,
} from './indexer/windows/startMenuScanner.js';
