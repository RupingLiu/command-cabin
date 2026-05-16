import {
  CALCULATOR_PLUGIN_ID,
  CALCULATOR_RESULT_COMMAND_ID,
  createCalculatorResultCommand,
} from '@command-cabin/built-in-plugin-calculator';
import {
  createClipboardHistoryCommands,
  type ClipboardHistoryRepository,
} from '@command-cabin/built-in-plugin-clipboard-history';
import {
  createFavoriteCommands,
  createCommandExecutor,
  createCommandRegistry,
  createSearchEngine,
  type AddFavoriteInput,
  type Command,
  type CommandExecutionResult,
  type FavoriteRecord,
  type FavoritesRepository,
  type HistoryRepository,
  type SearchOptions,
  type SearchRankingContext,
  type UpdateFavoriteInput,
} from '@command-cabin/core';

import type { LauncherCommandSearchResult } from '../../shared/launcherApi.js';

export interface LauncherCommandService {
  addFavorite: (input: AddFavoriteInput) => FavoriteRecord;
  clearClipboardHistory: () => number;
  executeCommand: (commandId: string) => Promise<CommandExecutionResult>;
  listFavorites: () => FavoriteRecord[];
  removeFavorite: (id: string) => boolean;
  searchCommands: (query: string) => LauncherCommandSearchResult[];
  updateFavorite: (id: string, input: UpdateFavoriteInput) => FavoriteRecord | undefined;
}

export interface LauncherCommandServiceOptions {
  clipboardHistoryRepository?: ClipboardHistoryRepository;
  commands?: readonly Command[];
  favoritesRepository?: FavoritesRepository;
  historyRepository?: HistoryRepository;
  openPath?: (path: string) => Promise<void> | void;
  openUrl?: (url: string) => Promise<void> | void;
  writeClipboardText?: (text: string) => Promise<void> | void;
}

const DEMO_COMMANDS: readonly Command[] = [
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
        text: 'CommandCabin 0.1.0',
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

function assertNoReservedCalculatorCommandIds(commands: readonly Command[]): void {
  for (const command of commands) {
    if (command.id === CALCULATOR_RESULT_COMMAND_ID) {
      throw new Error(
        `Command id is reserved for the built-in calculator: ${CALCULATOR_RESULT_COMMAND_ID}`,
      );
    }
  }
}

export function createLauncherCommandService(
  optionsOrCommands: readonly Command[] | LauncherCommandServiceOptions = {},
): LauncherCommandService {
  const options: LauncherCommandServiceOptions = isCommandList(optionsOrCommands)
    ? { commands: optionsOrCommands }
    : optionsOrCommands;
  const commands = options.commands ?? DEMO_COMMANDS;
  const registry = createCommandRegistry();
  const clipboardHistoryCommandIds = new Set<string>();
  const favoriteCommandIds = new Set<string>();
  let calculatorCommandRegistered = false;

  assertNoReservedCalculatorCommandIds(commands);

  for (const command of commands) {
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
      'run-system': (command) => ({
        metadata: {
          handled: true,
          systemCommand: String(command.action.payload.command ?? command.id),
        },
      }),
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

  refreshFavoriteCommands();
  refreshClipboardHistoryCommands();

  return {
    addFavorite: (input) => {
      if (!options.favoritesRepository) {
        throw new Error('Favorites repository is not configured.');
      }

      const favorite = options.favoritesRepository.addFavorite(input);
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
        favoriteCommandIds.has(command.id) &&
        options.historyRepository
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
    searchCommands: (query) => {
      refreshCalculatorCommand(query);
      refreshClipboardHistoryCommands();

      const searchOptions: SearchOptions = {
        includeAllOnEmptyQuery: true,
        limit: 10,
      };
      const ranking = createHistoryRankingContext();

      if (ranking !== undefined) {
        searchOptions.ranking = ranking;
      }

      return searchEngine.search(query, searchOptions).map(mapSearchResult);
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
