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
export {
  PLUGIN_COMMAND_ID_PATTERN,
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FILE_NAME,
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_PERMISSIONS,
  PLUGIN_VERSION_PATTERN,
} from './plugin/pluginManifest.js';
export type {
  PluginManifest,
  PluginManifestCommand,
  PluginManifestValidationError,
  PluginPermission,
} from './plugin/pluginManifest.js';
export {
  getPluginManifestFilePath,
  resolvePluginManifestRealPath,
  resolvePluginManifestPath,
  validatePluginManifestPath,
} from './plugin/pluginPaths.js';
export type {
  PluginPathRealpath,
  ResolvePluginManifestRealPathOptions,
  ResolvePluginManifestPathFailure,
  ResolvePluginManifestPathResult,
  ResolvePluginManifestPathSuccess,
} from './plugin/pluginPaths.js';
export {
  formatPluginManifestValidationErrors,
  validatePluginManifest,
} from './plugin/validateManifest.js';
export type {
  ValidatePluginManifestFailure,
  ValidatePluginManifestResult,
  ValidatePluginManifestSuccess,
} from './plugin/validateManifest.js';
export {
  createPluginCommand,
  createPluginCommandId,
  readPluginCommandPayload,
  PluginCommandAdapterError,
} from './plugin/pluginCommandAdapter.js';
export type { PluginCommandPayload } from './plugin/pluginCommandAdapter.js';
export {
  createPluginContext,
  createPluginLogger,
  createPluginLogStore,
  formatPluginThrownValue,
  logPluginError,
  runPluginLifecycleHook,
} from './plugin/pluginLifecycle.js';
export type {
  CreatePluginContextOptions,
  CreatePluginLogStoreOptions,
  PluginLifecycleClock,
  PluginLifecycleHookFailure,
  PluginLifecycleHookResult,
  PluginLifecycleHookSuccess,
  PluginLogEntry,
  PluginLogSink,
  PluginLogStore,
} from './plugin/pluginLifecycle.js';
export { createPluginRuntime } from './plugin/pluginRuntime.js';
export type {
  DisablePluginSuccess,
  PluginCommandExecutionFailure,
  PluginCommandExecutionResult,
  PluginCommandExecutionSuccess,
  PluginMainPathResolver,
  PluginManifestReader,
  PluginModuleLoader,
  PluginModuleLoadInput,
  PluginRuntime,
  PluginRuntimeError,
  PluginRuntimeErrorCode,
  PluginRuntimeFailure,
  PluginRuntimeOptions,
  PluginRuntimePlugin,
  PluginRuntimeResult,
  PluginRuntimeStatus,
  PluginRuntimeSuccess,
} from './plugin/pluginRuntime.js';
export { DuplicateCommandIdError, createCommandRegistry } from './command/commandRegistry.js';
export type { CommandRegistry } from './command/commandRegistry.js';
export { createCommandExecutor } from './command/commandExecutor.js';
export type { CommandExecutor, CommandExecutorOptions } from './command/commandExecutor.js';
export {
  LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY,
  LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY,
  LAUNCHER_PINNED_APP_METADATA_KEY,
  createFavoriteCommand,
  createFavoriteCommandId,
  createFavoriteCommands,
  isLauncherPinnedAppFavorite,
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
  createWindowsAppsFolderScanner,
  createWindowsShortcutResolver,
  createWindowsStartMenuScanner,
  getDefaultWindowsDesktopDirectories,
  getDefaultWindowsStartMenuDirectories,
} from './indexer/windows/startMenuScanner.js';
export type {
  AppsFolderApp,
  AppsFolderScanResult,
  ResolvedShortcut,
  ShortcutResolver,
  StartMenuDirectoryEntry,
  StartMenuDirectoryEntryKind,
  StartMenuFileSystem,
  StartMenuScanFailure,
  StartMenuScanResult,
  StartMenuShortcut,
  WindowsAppsFolderScanner,
  WindowsStartMenuScanner,
  WindowsStartMenuScannerOptions,
  WindowsShortcutResolverExecFile,
  WindowsShortcutResolverExecFileOptions,
  WindowsShortcutResolverExecFileResult,
  WindowsShortcutResolverOptions,
} from './indexer/windows/startMenuScanner.js';
