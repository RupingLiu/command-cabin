import { win32 as path } from 'node:path';

import {
  CALCULATOR_PLUGIN_ID,
  CALCULATOR_RESULT_COMMAND_ID,
  createCalculatorResultCommand,
} from '@command-cabin/built-in-plugin-calculator';
import {
  QUICK_CONVERTER_PLUGIN_ID,
  QUICK_CONVERTER_RESULT_COMMAND_ID,
  createQuickConverterCommand,
  type ExchangeRateProvider,
} from '@command-cabin/built-in-plugin-quick-converter';
import {
  createClipboardHistoryCommands,
  isClipboardHistoryCommandId,
  type ClipboardHistoryRepository,
} from '@command-cabin/built-in-plugin-clipboard-history';
import {
  TEXT_TOOLS_PLUGIN_ID,
  applyTextTransform,
  createTextToolCommands,
  getTextToolTransformKind,
  isTextToolCommandId,
} from '@command-cabin/built-in-plugin-text-tools';
import {
  LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY,
  LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY,
  LAUNCHER_PINNED_APP_METADATA_KEY,
  createFavoriteCommands,
  createCommandExecutor,
  createCommandRegistry,
  createSearchEngine,
  isLauncherPinnedAppFavorite,
  type AddFavoriteInput,
  type Command,
  type CommandExecutionMetadata,
  type CommandActionHandlers,
  type CommandExecutionResult,
  type CommandPayload,
  type CommandRegistry,
  type FavoriteRecord,
  type FavoritesRepository,
  type HistoryRepository,
  type SearchOptions,
  type SearchRankingContext,
  type StorageJsonObject,
  type UpdateFavoriteInput,
} from '@command-cabin/core';

import type { LauncherCommandSearchResult } from '../../shared/launcherApi.js';
import { createScreenshotCommands } from '../screenshot/screenshotCommands.js';

export interface LauncherCommandService {
  addFavorite: (input: AddFavoriteInput) => FavoriteRecord;
  addPinnedApp: (input: LauncherPinnedAppInput | string) => FavoriteRecord;
  clearClipboardHistory: () => number;
  executeCommand: (commandId: string) => Promise<CommandExecutionResult>;
  listFavorites: () => FavoriteRecord[];
  removeFavorite: (id: string) => boolean;
  removeRecentApp: (commandId: string) => boolean;
  searchCommands: (query: string) => Promise<LauncherCommandSearchResult[]>;
  updatePinnedApp: (
    id: string,
    input: LauncherPinnedAppInput | string,
  ) => FavoriteRecord | undefined;
  updateFavorite: (id: string, input: UpdateFavoriteInput) => FavoriteRecord | undefined;
}

export interface LauncherPinnedAppInput {
  appPath: string;
  executablePath?: string | undefined;
  iconPath?: string | undefined;
  title?: string | undefined;
}

export interface LauncherCommandServiceOptions {
  actionHandlers?: CommandActionHandlers;
  appVersion?: string | undefined;
  appCommands?: () => readonly Command[];
  clipboardHistoryRepository?: ClipboardHistoryRepository;
  commandRegistry?: CommandRegistry;
  commands?: readonly Command[];
  exchangeRateProvider?: ExchangeRateProvider;
  favoritesRepository?: FavoritesRepository;
  historyRepository?: HistoryRepository;
  openApp?: (payload: CommandPayload) => Promise<void> | void;
  openPath?: (path: string) => Promise<void> | void;
  openUrl?: (url: string) => Promise<void> | void;
  readClipboardText?: () => Promise<string> | string;
  runSystemCommand?: (
    command: string,
  ) => Promise<CommandExecutionMetadata | void> | CommandExecutionMetadata | void;
  writeClipboardText?: (text: string) => Promise<void> | void;
}

function createSystemCommands(appVersion: string | undefined): readonly Command[] {
  const versionText =
    appVersion !== undefined && appVersion.trim().length > 0
      ? `CommandCabin ${appVersion.trim()}`
      : 'CommandCabin version unavailable';

  return [
    {
      id: 'system.open-settings',
      source: 'system',
      title: 'Open Settings',
      subtitle: 'CommandCabin preferences',
      keywords: ['settings', 'preferences', 'configuration'],
      action: {
        type: 'run-system',
        payload: {
          command: 'open-settings',
        },
      },
    },
    {
      id: 'system.reload-launcher',
      source: 'system',
      title: 'Reload Launcher',
      subtitle: 'Refresh the desktop shell',
      keywords: ['reload', 'refresh', 'restart'],
      action: {
        type: 'run-system',
        payload: {
          command: 'reload-launcher',
        },
      },
    },
    {
      id: 'system.copy-version',
      source: 'system',
      title: 'Copy Version Info',
      subtitle: 'Copy runtime details for diagnostics',
      keywords: ['copy', 'version', 'diagnostics'],
      action: {
        type: 'copy-text',
        payload: {
          text: versionText,
        },
      },
    },
    {
      id: 'system.open-diagnostics',
      source: 'system',
      title: 'Open Diagnostics',
      subtitle: 'Runtime and startup details',
      keywords: ['diagnostics', 'logs', 'status'],
      action: {
        type: 'run-system',
        payload: {
          command: 'open-diagnostics',
        },
      },
    },
  ];
}

function getStringPayloadValue(payload: CommandPayload, key: string): string | undefined {
  const value = payload[key];

  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function addIconCandidate(candidates: string[], candidate: string | undefined): void {
  if (candidate === undefined || candidates.includes(candidate)) {
    return;
  }

  candidates.push(candidate);
}

function getAppIconCandidates(command: Command): string[] {
  if (!isAppCommand(command)) {
    return [];
  }

  const candidates: string[] = [];

  addIconCandidate(candidates, command.icon);
  addIconCandidate(candidates, getStringPayloadValue(command.action.payload, 'appUserModelId'));
  addIconCandidate(candidates, getStringPayloadValue(command.action.payload, 'executablePath'));
  addIconCandidate(candidates, command.subtitle);
  addIconCandidate(candidates, getStringPayloadValue(command.action.payload, 'shortcutPath'));

  return candidates;
}

function mapSearchResult(result: { command: Command; score: number }): LauncherCommandSearchResult {
  const commandResult: LauncherCommandSearchResult = {
    id: result.command.id,
    score: result.score,
    source: result.command.source,
    title: result.command.title,
  };

  if (result.command.subtitle !== undefined) {
    commandResult.subtitle = result.command.subtitle;
  }

  if (result.command.icon !== undefined) {
    commandResult.icon = result.command.icon;
  }

  const favoriteId = getStringPayloadValue(result.command.action.payload, 'favoriteId');

  if (favoriteId !== undefined) {
    commandResult.favoriteId = favoriteId;
  }

  const iconCandidates = getAppIconCandidates(result.command);

  if (iconCandidates.length > 0) {
    commandResult.iconCandidates = iconCandidates;
  }

  return commandResult;
}

function createUnknownCommandFailure(commandId: string): CommandExecutionResult {
  return {
    status: 'failure',
    commandId,
    actionType: 'run-system',
    error: {
      code: 'invalid-command',
      message: `Command not found: ${commandId}`,
    },
  };
}

function isCommandList(
  value: readonly Command[] | LauncherCommandServiceOptions,
): value is readonly Command[] {
  return Array.isArray(value);
}

function isBlankQuery(query: string): boolean {
  return query.trim().length === 0;
}

function isAppCommand(command: Command): boolean {
  return command.source === 'app' && command.action.type === 'open-app';
}

function isScreenshotSystemCommand(command: string): boolean {
  return command.startsWith('screenshot.');
}

const PINNED_APP_EXTENSIONS = new Set(['.exe', '.lnk']);
const MAX_GENERAL_SEARCH_CLIPBOARD_HISTORY_RESULTS = 2;
const EXPLICIT_CLIPBOARD_HISTORY_QUERY_TOKENS = [
  'clip',
  'clipboard',
  'history',
  '剪贴板',
  '粘贴板',
  '剪切板',
] as const;

interface NormalizedPinnedAppInput {
  appPath: string;
  executablePath: string;
  iconPath: string;
  title: string;
}

function normalizeAppPath(appPath: string): string {
  return appPath.trim().replaceAll('/', '\\').toLowerCase();
}

function validatePinnedAppPath(appPath: string): string {
  const trimmedPath = appPath.trim();

  if (
    trimmedPath.length === 0 ||
    !PINNED_APP_EXTENSIONS.has(path.extname(trimmedPath).toLowerCase())
  ) {
    throw new Error('Pinned app path must be an .exe or .lnk file.');
  }

  return trimmedPath;
}

function createPinnedAppTitle(appPath: string): string {
  const extension = path.extname(appPath);
  const title = path.basename(appPath, extension).trim();

  return title.length > 0 ? title : appPath;
}

function normalizeOptionalPinnedAppValue(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim();

  return trimmedValue && trimmedValue.length > 0 ? trimmedValue : undefined;
}

function normalizePinnedAppInput(input: LauncherPinnedAppInput | string): NormalizedPinnedAppInput {
  const appPath = validatePinnedAppPath(typeof input === 'string' ? input : input.appPath);
  const executablePath = normalizeOptionalPinnedAppValue(
    typeof input === 'string' ? undefined : input.executablePath,
  );
  const iconPath = normalizeOptionalPinnedAppValue(
    typeof input === 'string' ? undefined : input.iconPath,
  );
  const title = normalizeOptionalPinnedAppValue(
    typeof input === 'string' ? undefined : input.title,
  );

  return {
    appPath,
    executablePath: executablePath ?? appPath,
    iconPath: iconPath ?? executablePath ?? appPath,
    title: title ?? createPinnedAppTitle(appPath),
  };
}

function createPinnedAppMetadata(input: NormalizedPinnedAppInput): StorageJsonObject {
  return {
    [LAUNCHER_PINNED_APP_METADATA_KEY]: true,
    [LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY]: input.executablePath,
    [LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY]: input.iconPath,
  };
}

function createAppResultIdentityKey(result: LauncherCommandSearchResult): string {
  return (result.subtitle ?? result.title).trim().replaceAll('/', '\\').toLowerCase();
}

function assertNoReservedCalculatorCommandIds(commands: readonly Command[]): void {
  for (const command of commands) {
    if (command.id === CALCULATOR_RESULT_COMMAND_ID) {
      throw new Error(
        `Command id is reserved for the built-in calculator: ${CALCULATOR_RESULT_COMMAND_ID}`,
      );
    }
  }
}

function assertNoReservedQuickConverterCommandIds(commands: readonly Command[]): void {
  for (const command of commands) {
    if (command.id === QUICK_CONVERTER_RESULT_COMMAND_ID) {
      throw new Error(
        `Command id is reserved for the built-in quick converter: ${QUICK_CONVERTER_RESULT_COMMAND_ID}`,
      );
    }
  }
}

function assertNoReservedTextToolCommandIds(commands: readonly Command[]): void {
  for (const command of commands) {
    if (isTextToolCommandId(command.id)) {
      throw new Error(`Command id is reserved for the built-in text tools: ${command.id}`);
    }
  }
}

function isClipboardHistorySearchResult(result: LauncherCommandSearchResult): boolean {
  return isClipboardHistoryCommandId(result.id);
}

function isExplicitClipboardHistoryQuery(query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery.length === 0) {
    return false;
  }

  return EXPLICIT_CLIPBOARD_HISTORY_QUERY_TOKENS.some((token) => normalizedQuery.includes(token));
}

function demoteClipboardHistorySearchResults(
  query: string,
  results: readonly LauncherCommandSearchResult[],
  limit: number,
): LauncherCommandSearchResult[] {
  if (isExplicitClipboardHistoryQuery(query)) {
    return results.slice(0, limit);
  }

  const primaryResults: LauncherCommandSearchResult[] = [];
  const clipboardHistoryResults: LauncherCommandSearchResult[] = [];

  for (const result of results) {
    if (isClipboardHistorySearchResult(result)) {
      if (clipboardHistoryResults.length < MAX_GENERAL_SEARCH_CLIPBOARD_HISTORY_RESULTS) {
        clipboardHistoryResults.push(result);
      }
      continue;
    }

    primaryResults.push(result);
  }

  return [...primaryResults, ...clipboardHistoryResults].slice(0, limit);
}

export function createLauncherCommandService(
  optionsOrCommands: readonly Command[] | LauncherCommandServiceOptions = {},
): LauncherCommandService {
  const options: LauncherCommandServiceOptions = isCommandList(optionsOrCommands)
    ? { commands: optionsOrCommands }
    : optionsOrCommands;
  const commands = options.commands ?? [
    ...createSystemCommands(options.appVersion),
    ...createScreenshotCommands(),
  ];
  const registry = options.commandRegistry ?? createCommandRegistry();
  const appCommandIds = new Set<string>();
  const clipboardHistoryCommandIds = new Set<string>();
  const favoriteCommandIds = new Set<string>();
  let calculatorCommandRegistered = false;
  let quickConverterCommandRegistered = false;

  assertNoReservedCalculatorCommandIds(commands);
  assertNoReservedQuickConverterCommandIds(commands);
  assertNoReservedTextToolCommandIds(commands);

  for (const command of commands) {
    registry.register(command);
  }

  for (const command of createTextToolCommands()) {
    registry.register(command);
  }

  const searchEngine = createSearchEngine([], {
    includeAllOnEmptyQuery: true,
    limit: 10,
  });
  const executor = createCommandExecutor({
    handlers: {
      'copy-text': async (command) => {
        const text = String(command.action.payload.text ?? '');

        await options.writeClipboardText?.(text);

        return {
          metadata: {
            copied: true,
            text,
          },
        };
      },
      'open-path': async (command) => {
        const path = String(command.action.payload.path ?? '');

        if (path.trim().length === 0) {
          throw new Error('Favorite path is missing.');
        }

        if (!options.openPath) {
          throw new Error('No opener configured for favorite paths.');
        }

        await options.openPath(path);

        return {
          metadata: {
            openedPath: path,
          },
        };
      },
      'open-url': async (command) => {
        const url = String(command.action.payload.url ?? '');

        if (url.trim().length === 0) {
          throw new Error('Favorite URL is missing.');
        }

        if (!options.openUrl) {
          throw new Error('No opener configured for favorite URLs.');
        }

        await options.openUrl(url);

        return {
          metadata: {
            openedUrl: url,
          },
        };
      },
      'open-app': async (command) => {
        const shortcutPath = command.action.payload.shortcutPath;

        if (typeof shortcutPath !== 'string' || shortcutPath.trim().length === 0) {
          throw new Error('App shortcut path is missing.');
        }

        if (!options.openApp) {
          throw new Error('No opener configured for app commands.');
        }

        const openedApp = JSON.parse(JSON.stringify(command.action.payload)) as CommandPayload;

        await options.openApp(openedApp);

        return {
          metadata: {
            openedApp,
          },
        };
      },
      'run-system': async (command) => {
        const textTransformKind = getTextToolTransformKind(command.id);

        if (textTransformKind !== undefined) {
          if (command.pluginId !== TEXT_TOOLS_PLUGIN_ID) {
            throw new Error('Invalid text tools command registration.');
          }

          if (!options.readClipboardText) {
            throw new Error('No clipboard reader configured for text tools.');
          }

          if (!options.writeClipboardText) {
            throw new Error('No clipboard writer configured for text tools.');
          }

          const inputText = await options.readClipboardText();
          const outputText = applyTextTransform(textTransformKind, inputText);

          await options.writeClipboardText(outputText);

          return {
            metadata: {
              textTransform: textTransformKind,
            },
          };
        }

        const systemCommand = String(command.action.payload.command ?? command.id);

        if (isScreenshotSystemCommand(systemCommand)) {
          if (!options.runSystemCommand) {
            throw new Error('No screenshot command handler configured.');
          }

          const handlerMetadata = await options.runSystemCommand(systemCommand);

          return {
            metadata: {
              ...(handlerMetadata ?? {}),
              handled: true,
              systemCommand,
            },
          };
        }

        return {
          metadata: {
            handled: true,
            systemCommand,
          },
        };
      },
      ...options.actionHandlers,
    },
  });

  function refreshSearchIndex(): void {
    searchEngine.update(registry.list());
  }

  function refreshFavoriteCommands(): void {
    for (const commandId of favoriteCommandIds) {
      registry.unregister(commandId);
    }

    favoriteCommandIds.clear();

    if (!options.favoritesRepository) {
      refreshSearchIndex();
      return;
    }

    for (const command of createFavoriteCommands(options.favoritesRepository.listFavorites())) {
      registry.register(command);
      favoriteCommandIds.add(command.id);
    }

    refreshSearchIndex();
  }

  function refreshAppCommands(): void {
    for (const commandId of appCommandIds) {
      registry.unregister(commandId);
    }

    appCommandIds.clear();

    if (!options.appCommands) {
      refreshSearchIndex();
      return;
    }

    for (const command of options.appCommands()) {
      registry.register(command);
      appCommandIds.add(command.id);
    }

    refreshSearchIndex();
  }

  function refreshClipboardHistoryCommands(): void {
    for (const commandId of clipboardHistoryCommandIds) {
      registry.unregister(commandId);
    }

    clipboardHistoryCommandIds.clear();

    if (!options.clipboardHistoryRepository) {
      refreshSearchIndex();
      return;
    }

    for (const command of createClipboardHistoryCommands(
      options.clipboardHistoryRepository.listRecent(200),
    )) {
      registry.register(command);
      clipboardHistoryCommandIds.add(command.id);
    }

    refreshSearchIndex();
  }

  function refreshCalculatorCommand(query: string): void {
    if (calculatorCommandRegistered) {
      registry.unregister(CALCULATOR_RESULT_COMMAND_ID);
      calculatorCommandRegistered = false;
    }

    const calculatorCommand = createCalculatorResultCommand(query);

    if (calculatorCommand) {
      if (
        calculatorCommand.id !== CALCULATOR_RESULT_COMMAND_ID ||
        calculatorCommand.pluginId !== CALCULATOR_PLUGIN_ID
      ) {
        throw new Error('Invalid calculator command registration.');
      }

      registry.register(calculatorCommand);
      calculatorCommandRegistered = true;
    }

    refreshSearchIndex();
  }

  async function refreshQuickConverterCommand(query: string): Promise<void> {
    if (quickConverterCommandRegistered) {
      registry.unregister(QUICK_CONVERTER_RESULT_COMMAND_ID);
      quickConverterCommandRegistered = false;
    }

    const quickConverterCommand = await createQuickConverterCommand(query, {
      exchangeRateProvider: options.exchangeRateProvider,
    });

    if (quickConverterCommand) {
      if (
        quickConverterCommand.id !== QUICK_CONVERTER_RESULT_COMMAND_ID ||
        quickConverterCommand.pluginId !== QUICK_CONVERTER_PLUGIN_ID
      ) {
        throw new Error('Invalid quick converter command registration.');
      }

      registry.register(quickConverterCommand);
      quickConverterCommandRegistered = true;
    }

    refreshSearchIndex();
  }

  function createHistoryRankingContext(): SearchRankingContext | undefined {
    if (!options.historyRepository) {
      return undefined;
    }

    return {
      history: new Map(
        options.historyRepository.listRecent(100).map((entry) => [
          entry.commandId,
          {
            executionCount: entry.executionCount,
            executedAt: entry.executedAt,
          },
        ]),
      ),
      now: new Date(),
    };
  }

  function listRecentAppSearchResults(limit = 10): LauncherCommandSearchResult[] {
    if (!options.historyRepository) {
      return [];
    }

    const results: LauncherCommandSearchResult[] = [];

    for (const entry of options.historyRepository.listRecent(100)) {
      if (entry.source !== 'app') {
        continue;
      }

      const command = registry.get(entry.commandId);

      if (!command || !isAppCommand(command)) {
        continue;
      }

      results.push(
        mapSearchResult({
          command,
          score: entry.executionCount,
        }),
      );

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  function listPinnedAppSearchResults(limit = 10): LauncherCommandSearchResult[] {
    const results: LauncherCommandSearchResult[] = [];

    for (const commandId of favoriteCommandIds) {
      const command = registry.get(commandId);

      if (!command || !isAppCommand(command)) {
        continue;
      }

      results.push(
        mapSearchResult({
          command,
          score: 1,
        }),
      );

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  function listHomeAppSearchResults(limit = 10): LauncherCommandSearchResult[] {
    const results: LauncherCommandSearchResult[] = [];
    const seenAppKeys = new Set<string>();

    for (const result of [
      ...listRecentAppSearchResults(limit),
      ...listPinnedAppSearchResults(limit),
    ]) {
      const appKey = createAppResultIdentityKey(result);

      if (seenAppKeys.has(appKey)) {
        continue;
      }

      seenAppKeys.add(appKey);
      results.push(result);

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  refreshFavoriteCommands();
  refreshClipboardHistoryCommands();
  refreshAppCommands();

  return {
    addFavorite: (input) => {
      if (!options.favoritesRepository) {
        throw new Error('Favorites repository is not configured.');
      }

      const favorite = options.favoritesRepository.addFavorite(input);
      refreshFavoriteCommands();
      return favorite;
    },
    addPinnedApp: (input) => {
      if (!options.favoritesRepository) {
        throw new Error('Favorites repository is not configured.');
      }

      const pinnedApp = normalizePinnedAppInput(input);
      const normalizedPinnedAppPath = normalizeAppPath(pinnedApp.appPath);
      const existingFavorite = options.favoritesRepository
        .listFavorites()
        .find(
          (favorite) =>
            isLauncherPinnedAppFavorite(favorite) &&
            favorite.kind === 'file' &&
            normalizeAppPath(favorite.path) === normalizedPinnedAppPath,
        );

      if (existingFavorite) {
        return existingFavorite;
      }

      const favorite = options.favoritesRepository.addFavorite({
        kind: 'file',
        title: pinnedApp.title,
        path: pinnedApp.appPath,
        keywords: [pinnedApp.title],
        metadata: createPinnedAppMetadata(pinnedApp),
      });

      refreshFavoriteCommands();
      return favorite;
    },
    clearClipboardHistory: () => {
      if (!options.clipboardHistoryRepository) {
        return 0;
      }

      const removed = options.clipboardHistoryRepository.clear();
      refreshClipboardHistoryCommands();
      return removed;
    },
    executeCommand: async (commandId) => {
      const command = registry.get(commandId);

      if (!command) {
        return createUnknownCommandFailure(commandId);
      }

      const result = await executor.execute(command);

      if (
        result.status === 'success' &&
        options.historyRepository &&
        (favoriteCommandIds.has(command.id) || isAppCommand(command))
      ) {
        const historyInput = {
          commandId: command.id,
          title: command.title,
          source: command.source,
          metadata: result.metadata,
        };

        options.historyRepository.recordExecution(
          command.subtitle === undefined
            ? historyInput
            : {
                ...historyInput,
                subtitle: command.subtitle,
              },
        );
      }

      return result;
    },
    listFavorites: () => options.favoritesRepository?.listFavorites() ?? [],
    removeFavorite: (id) => {
      if (!options.favoritesRepository) {
        throw new Error('Favorites repository is not configured.');
      }

      const removed = options.favoritesRepository.removeFavorite(id);

      if (removed) {
        refreshFavoriteCommands();
      }

      return removed;
    },
    removeRecentApp: (commandId) => {
      if (!options.historyRepository) {
        return false;
      }

      return options.historyRepository.removeByCommandId(commandId);
    },
    searchCommands: async (query) => {
      refreshAppCommands();

      if (isBlankQuery(query)) {
        return listHomeAppSearchResults(10);
      }

      refreshCalculatorCommand(query);
      await refreshQuickConverterCommand(query);
      refreshClipboardHistoryCommands();

      const limit = 10;
      const searchOptions: SearchOptions = {
        includeAllOnEmptyQuery: false,
        limit,
      };
      const ranking = createHistoryRankingContext();

      if (ranking !== undefined) {
        searchOptions.ranking = ranking;
      }

      const results = searchEngine.search(query, searchOptions).map(mapSearchResult);

      return demoteClipboardHistorySearchResults(query, results, limit);
    },
    updatePinnedApp: (id, input) => {
      if (!options.favoritesRepository) {
        throw new Error('Favorites repository is not configured.');
      }

      const existingFavorite = options.favoritesRepository.getFavorite(id);

      if (!existingFavorite || !isLauncherPinnedAppFavorite(existingFavorite)) {
        return undefined;
      }

      const pinnedApp = normalizePinnedAppInput(input);
      const normalizedPinnedAppPath = normalizeAppPath(pinnedApp.appPath);
      const duplicateFavorite = options.favoritesRepository
        .listFavorites()
        .find(
          (favorite) =>
            favorite.id !== id &&
            isLauncherPinnedAppFavorite(favorite) &&
            favorite.kind === 'file' &&
            normalizeAppPath(favorite.path) === normalizedPinnedAppPath,
        );

      if (duplicateFavorite) {
        options.favoritesRepository.removeFavorite(id);
        refreshFavoriteCommands();
        return duplicateFavorite;
      }

      options.favoritesRepository.removeFavorite(id);
      const updatedFavorite = options.favoritesRepository.addFavorite({
        id,
        kind: 'file',
        title: pinnedApp.title,
        path: pinnedApp.appPath,
        keywords: [pinnedApp.title],
        metadata: createPinnedAppMetadata(pinnedApp),
      });

      refreshFavoriteCommands();
      return updatedFavorite;
    },
    updateFavorite: (id, input) => {
      if (!options.favoritesRepository) {
        throw new Error('Favorites repository is not configured.');
      }

      const favorite = options.favoritesRepository.updateFavorite(id, input);

      if (favorite) {
        refreshFavoriteCommands();
      }

      return favorite;
    },
  };
}
