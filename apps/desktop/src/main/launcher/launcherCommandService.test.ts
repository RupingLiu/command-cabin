import { describe, expect, it } from 'vitest';

import {
  createCommandRegistry,
  createFavoritesRepository,
  createHistoryRepository,
  createPluginRuntime,
  openInMemoryCommandCabinDatabase,
  runMigrations,
  type CommandPayload,
} from '@command-cabin/core';

import { createLauncherCommandService } from './launcherCommandService.js';

describe('launcher command service', () => {
  it('returns demo command results for an empty query', () => {
    const service = createLauncherCommandService();

    const results = service.searchCommands('');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      id: expect.any(String) as string,
      source: 'system',
      title: expect.any(String) as string,
    });
  });

  it('executes a selected command through the core command executor', async () => {
    const service = createLauncherCommandService();
    const [firstResult] = service.searchCommands('');

    expect(firstResult).toBeDefined();

    const executionResult = await service.executeCommand(firstResult!.id);

    expect(executionResult).toMatchObject({
      commandId: firstResult!.id,
      status: 'success',
    });
  });

  it('marks the open settings command for renderer-side routing', async () => {
    const service = createLauncherCommandService();

    await expect(service.executeCommand('system.open-settings')).resolves.toMatchObject({
      actionType: 'run-system',
      commandId: 'system.open-settings',
      metadata: {
        systemCommand: 'open-settings',
      },
      status: 'success',
    });
  });

  it('returns a calculator result for math queries and copies it on execution', async () => {
    const copiedText: string[] = [];
    const service = createLauncherCommandService({
      commands: [],
      writeClipboardText: (text) => {
        copiedText.push(text);
      },
    });

    const [result] = service.searchCommands('1 + 2');

    expect(result).toMatchObject({
      id: 'calculator.result',
      source: 'plugin',
      title: '3',
    });

    await expect(service.executeCommand(result!.id)).resolves.toMatchObject({
      commandId: 'calculator.result',
      metadata: {
        copied: true,
        text: '3',
      },
      status: 'success',
    });
    expect(copiedText).toEqual(['3']);
  });

  it('removes stale calculator result commands after invalid math queries', async () => {
    const service = createLauncherCommandService({
      commands: [],
      writeClipboardText: () => undefined,
    });

    expect(service.searchCommands('1 + 2')[0]).toMatchObject({
      id: 'calculator.result',
      title: '3',
    });

    expect(service.searchCommands('1 +')).toEqual([]);
    await expect(service.executeCommand('calculator.result')).resolves.toMatchObject({
      error: {
        code: 'invalid-command',
      },
      status: 'failure',
    });
  });

  it('rejects configured commands that collide with the calculator result command id', () => {
    expect(() =>
      createLauncherCommandService({
        commands: [
          {
            id: 'calculator.result',
            source: 'system',
            title: 'Reserved Collision',
            keywords: ['reserved'],
            action: {
              type: 'run-system',
              payload: {
                command: 'reserved-collision',
              },
            },
          },
        ],
      }),
    ).toThrow('Command id is reserved for the built-in calculator: calculator.result');
  });

  it('does not throw or expose a calculator command for extreme math input', () => {
    const service = createLauncherCommandService({ commands: [] });
    const excessiveUnaryExpression = `${'+'.repeat(200)}1`;

    expect(() => service.searchCommands(excessiveUnaryExpression)).not.toThrow();
    expect(service.searchCommands(excessiveUnaryExpression)).toEqual([]);
    expect(service.searchCommands('1 + 2')[0]).toMatchObject({
      id: 'calculator.result',
      title: '3',
    });

    const excessiveNestedExpression = `${'('.repeat(200)}1${')'.repeat(200)}`;

    expect(() => service.searchCommands(excessiveNestedExpression)).not.toThrow();
    expect(service.searchCommands(excessiveNestedExpression)).toEqual([]);
    expect(service.searchCommands('1 +')).toEqual([]);
  });

  it('returns a structured failure for unknown command ids', async () => {
    const service = createLauncherCommandService();

    await expect(service.executeCommand('missing.command')).resolves.toMatchObject({
      commandId: 'missing.command',
      error: {
        code: 'invalid-command',
      },
      status: 'failure',
    });
  });

  it('searches favorite commands from the repository and records history after opening one', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const favoritesRepository = createFavoritesRepository(database);
      const historyRepository = createHistoryRepository(database);
      favoritesRepository.addFavorite({
        kind: 'folder',
        title: 'Project Workspace',
        path: 'C:\\WorkingFolder\\command-cabin',
        keywords: ['repo', 'cabin'],
      });
      const openedPaths: string[] = [];
      const service = createLauncherCommandService({
        commands: [],
        favoritesRepository,
        historyRepository,
        openPath: (path) => {
          openedPaths.push(path);
        },
      });

      const [favoriteResult] = service.searchCommands('cabin');

      expect(favoriteResult).toMatchObject({
        source: 'file',
        title: 'Project Workspace',
      });

      const executionResult = await service.executeCommand(favoriteResult!.id);

      expect(executionResult).toMatchObject({
        commandId: favoriteResult!.id,
        status: 'success',
      });
      expect(openedPaths).toEqual(['C:\\WorkingFolder\\command-cabin']);
      expect(historyRepository.getByCommandId(favoriteResult!.id)).toMatchObject({
        commandId: favoriteResult!.id,
        executionCount: 1,
        source: 'file',
        title: 'Project Workspace',
        metadata: {
          openedPath: 'C:\\WorkingFolder\\command-cabin',
        },
      });
    } finally {
      database.close();
    }
  });

  it('keeps favorite search results in sync after add, edit, and delete operations', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const service = createLauncherCommandService({
        commands: [],
        favoritesRepository: createFavoritesRepository(database),
      });

      const created = service.addFavorite({
        kind: 'url',
        title: 'Docs Portal',
        url: 'https://example.com/start',
        keywords: ['docs'],
      });

      expect(service.searchCommands('docs')[0]).toMatchObject({
        id: expect.any(String) as string,
        source: 'url',
        title: 'Docs Portal',
      });

      service.updateFavorite(created.id, {
        title: 'Manual Portal',
        keywords: ['manual'],
      });

      expect(service.searchCommands('docs')).toEqual([]);
      expect(service.searchCommands('manual')[0]).toMatchObject({
        title: 'Manual Portal',
      });

      expect(service.removeFavorite(created.id)).toBe(true);
      expect(service.searchCommands('manual')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('fails favorite path execution without recording history when no opener is configured', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const favoritesRepository = createFavoritesRepository(database);
      const historyRepository = createHistoryRepository(database);
      favoritesRepository.addFavorite({
        kind: 'file',
        title: 'Readme',
        path: 'C:\\WorkingFolder\\command-cabin\\README.md',
        keywords: ['readme'],
      });
      const service = createLauncherCommandService({
        commands: [],
        favoritesRepository,
        historyRepository,
      });
      const [favoriteResult] = service.searchCommands('readme');

      const executionResult = await service.executeCommand(favoriteResult!.id);

      expect(executionResult).toMatchObject({
        commandId: favoriteResult!.id,
        error: {
          code: 'handler-error',
          message: 'No opener configured for favorite paths.',
        },
        status: 'failure',
      });
      expect(historyRepository.getByCommandId(favoriteResult!.id)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('fails favorite URL execution without recording history when the opener throws', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const favoritesRepository = createFavoritesRepository(database);
      const historyRepository = createHistoryRepository(database);
      favoritesRepository.addFavorite({
        kind: 'url',
        title: 'Docs',
        url: 'https://example.com/docs',
        keywords: ['docs'],
      });
      const service = createLauncherCommandService({
        commands: [],
        favoritesRepository,
        historyRepository,
        openUrl: () => {
          throw new Error('Browser launch failed.');
        },
      });
      const [favoriteResult] = service.searchCommands('docs');

      const executionResult = await service.executeCommand(favoriteResult!.id);

      expect(executionResult).toMatchObject({
        commandId: favoriteResult!.id,
        error: {
          code: 'handler-error',
          message: 'Browser launch failed.',
        },
        status: 'failure',
      });
      expect(historyRepository.getByCommandId(favoriteResult!.id)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('searches indexed app commands and opens app shortcuts', async () => {
    const openedApps: CommandPayload[] = [];
    const service = createLauncherCommandService({
      appCommands: () => [
        {
          id: 'app.notepad',
          source: 'app',
          title: 'Notepad',
          subtitle: 'C:\\Windows\\System32\\notepad.exe',
          keywords: ['notepad'],
          action: {
            type: 'open-app',
            payload: {
              executablePath: 'C:\\Windows\\System32\\notepad.exe',
              shortcutPath:
                'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Notepad.lnk',
            },
          },
        },
      ],
      commands: [],
      openApp: (payload) => {
        openedApps.push(payload);
      },
    });

    const [appResult] = service.searchCommands('notepad');

    expect(appResult).toMatchObject({
      id: 'app.notepad',
      source: 'app',
      title: 'Notepad',
    });
    await expect(service.executeCommand('app.notepad')).resolves.toMatchObject({
      actionType: 'open-app',
      commandId: 'app.notepad',
      metadata: {
        openedApp: {
          executablePath: 'C:\\Windows\\System32\\notepad.exe',
          shortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Notepad.lnk',
        },
      },
      status: 'success',
    });
    expect(openedApps).toEqual([
      {
        executablePath: 'C:\\Windows\\System32\\notepad.exe',
        shortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Notepad.lnk',
      },
    ]);
  });

  it('executes plugin commands through the shared command registry and runtime handler', async () => {
    const registry = createCommandRegistry();
    const runtime = createPluginRuntime({
      commandRegistry: registry,
      readManifest: () => ({
        id: 'com.example.echo',
        name: 'Echo Plugin',
        version: '0.1.0',
        description: 'Echo test plugin',
        main: 'dist/main.js',
        permissions: [],
        commands: [
          {
            id: 'ping',
            title: 'Ping Plugin',
            keywords: ['ping'],
          },
        ],
      }),
      resolveMainPath: () => ({
        ok: true,
        path: 'C:\\Plugins\\Echo\\dist\\main.js',
      }),
      moduleLoader: () => ({
        activate: () => undefined,
        commands: {
          ping: () => ({
            metadata: {
              pong: true,
            },
          }),
        },
      }),
    });
    const service = createLauncherCommandService({
      actionHandlers: {
        'run-plugin': runtime.createRunPluginCommandHandler(),
      },
      commandRegistry: registry,
      commands: [],
    });

    await runtime.enablePlugin('C:\\Plugins\\Echo');

    const [pluginResult] = service.searchCommands('ping');

    expect(pluginResult).toMatchObject({
      id: 'com.example.echo.ping',
      source: 'plugin',
      title: 'Ping Plugin',
    });
    await expect(service.executeCommand('com.example.echo.ping')).resolves.toMatchObject({
      actionType: 'run-plugin',
      commandId: 'com.example.echo.ping',
      metadata: {
        commandId: 'ping',
        pluginId: 'com.example.echo',
        pluginMetadata: {
          pong: true,
        },
        status: 'success',
      },
      status: 'success',
    });
  });
});
