import {
  createCommandExecutor,
  createCommandRegistry,
  createSearchEngine,
  type Command,
  type CommandExecutionResult,
} from '@command-cabin/core';

import type { LauncherCommandSearchResult } from '../../shared/launcherApi.js';

export interface LauncherCommandService {
  executeCommand: (commandId: string) => Promise<CommandExecutionResult>;
  searchCommands: (query: string) => LauncherCommandSearchResult[];
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

export function createLauncherCommandService(
  commands: readonly Command[] = DEMO_COMMANDS,
): LauncherCommandService {
  const registry = createCommandRegistry();

  for (const command of commands) {
    registry.register(command);
  }

  const searchEngine = createSearchEngine(registry.list(), {
    includeAllOnEmptyQuery: true,
    limit: 10,
  });
  const executor = createCommandExecutor({
    handlers: {
      'copy-text': (command) => ({
        metadata: {
          copied: true,
          text: String(command.action.payload.text ?? ''),
        },
      }),
      'run-system': (command) => ({
        metadata: {
          handled: true,
          systemCommand: String(command.action.payload.command ?? command.id),
        },
      }),
    },
  });

  return {
    executeCommand: async (commandId) => {
      const command = registry.get(commandId);

      if (!command) {
        return createUnknownCommandFailure(commandId);
      }

      return executor.execute(command);
    },
    searchCommands: (query) =>
      searchEngine.search(query, { includeAllOnEmptyQuery: true, limit: 10 }).map(mapSearchResult),
  };
}
