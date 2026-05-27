import { describe, expect, it } from 'vitest';

import { createClipboardHistoryRepository } from '@command-cabin/built-in-plugin-clipboard-history';
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
  it('returns no system commands for an empty query before app history exists', async () => {
    const service = createLauncherCommandService();

    await expect(service.searchCommands('')).resolves.toEqual([]);
  });

  it('executes a selected command through the core command executor', async () => {
    const service = createLauncherCommandService();
    const [firstResult] = await service.searchCommands('settings');

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

  it('keeps system command results above matching clipboard history entries', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const clipboardHistoryRepository = createClipboardHistoryRepository(database);
      clipboardHistoryRepository.saveText('settings backup text');
      clipboardHistoryRepository.saveText('settings notes');
      const service = createLauncherCommandService({
        clipboardHistoryRepository,
      });

      const results = await service.searchCommands('settings');

      expect(results[0]).toMatchObject({
        id: 'system.open-settings',
        source: 'system',
      });
      expect(
        results.filter((result) => result.id.startsWith('clipboard-history.entry.')),
      ).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('searches screenshot commands by default', async () => {
    const service = createLauncherCommandService();

    await expect(service.searchCommands('截图')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'system.screenshot.capture',
          source: 'system',
        }),
      ]),
    );
  });

  it('dispatches screenshot system commands through the injected handler', async () => {
    const handledCommands: string[] = [];
    const service = createLauncherCommandService({
      runSystemCommand: (command) => {
        handledCommands.push(command);

        return {
          windowId: 7,
        };
      },
    });

    await expect(service.executeCommand('system.screenshot.capture')).resolves.toMatchObject({
      actionType: 'run-system',
      commandId: 'system.screenshot.capture',
      metadata: {
        handled: true,
        systemCommand: 'screenshot.capture',
        windowId: 7,
      },
      status: 'success',
    });
    expect(handledCommands).toEqual(['screenshot.capture']);
  });

  it('fails screenshot system commands clearly when no handler is configured', async () => {
    const service = createLauncherCommandService();

    await expect(service.executeCommand('system.screenshot.capture')).resolves.toMatchObject({
      actionType: 'run-system',
      commandId: 'system.screenshot.capture',
      error: {
        code: 'handler-error',
        message: 'No screenshot command handler configured.',
      },
      status: 'failure',
    });
  });

  it('copies the injected app version for diagnostics', async () => {
    const copiedText: string[] = [];
    const service = createLauncherCommandService({
      appVersion: '1.2.3',
      writeClipboardText: (text) => {
        copiedText.push(text);
      },
    });

    await expect(service.executeCommand('system.copy-version')).resolves.toMatchObject({
      actionType: 'copy-text',
      commandId: 'system.copy-version',
      metadata: {
        copied: true,
        text: 'CommandCabin 1.2.3',
      },
      status: 'success',
    });
    expect(copiedText).toEqual(['CommandCabin 1.2.3']);
  });

  it('returns a calculator result for math queries and copies it on execution', async () => {
    const copiedText: string[] = [];
    const service = createLauncherCommandService({
      commands: [],
      writeClipboardText: (text) => {
        copiedText.push(text);
      },
    });

    const [result] = await service.searchCommands('1 + 2');

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

    await expect(service.searchCommands('1 + 2')).resolves.toMatchObject([
      {
        id: 'calculator.result',
        title: '3',
      },
    ]);

    await expect(service.searchCommands('1 +')).resolves.toEqual([]);
    await expect(service.executeCommand('calculator.result')).resolves.toMatchObject({
      error: {
        code: 'invalid-command',
      },
      status: 'failure',
    });
  });

  it('returns quick converter results for static unit queries', async () => {
    const service = createLauncherCommandService({ commands: [] });

    await expect(service.searchCommands('1厘米')).resolves.toMatchObject([
      {
        id: 'quick-converter.result',
        source: 'plugin',
        title: '1 厘米 = 10 毫米 = 0.01 米 = 0.393701 英寸',
      },
    ]);
  });

  it('keeps quick converter results above matching clipboard history entries', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const clipboardHistoryRepository = createClipboardHistoryRepository(database);
      clipboardHistoryRepository.saveText('43cm');
      clipboardHistoryRepository.saveText('43cm*13cm*7cm');
      const service = createLauncherCommandService({
        clipboardHistoryRepository,
        commands: [],
      });

      const results = await service.searchCommands('43cm');

      expect(results.map((result) => result.id)).toEqual([
        'quick-converter.result',
        expect.stringMatching(/^clipboard-history\.entry\./),
        expect.stringMatching(/^clipboard-history\.entry\./),
      ]);
      expect(results[0]).toMatchObject({
        id: 'quick-converter.result',
        title: '43 厘米 = 430 毫米 = 0.43 米 = 16.9291 英寸',
      });
    } finally {
      database.close();
    }
  });

  it('keeps calculator results while adding quick converter results', async () => {
    const service = createLauncherCommandService({ commands: [] });

    await expect(service.searchCommands('1 + 2')).resolves.toMatchObject([
      {
        id: 'calculator.result',
        title: '3',
      },
    ]);
  });

  it('returns USD conversion results from the injected exchange rate provider', async () => {
    const service = createLauncherCommandService({
      commands: [],
      exchangeRateProvider: {
        getUsdToCnyRate: async () => ({
          fetchedAt: '2026-05-18T00:00:00.000Z',
          provider: 'Frankfurter',
          rate: 7.1234,
          source: 'live',
          updatedAt: '2026-05-18',
        }),
      },
    });

    await expect(service.searchCommands('1美元')).resolves.toMatchObject([
      {
        id: 'quick-converter.result',
        title: '1 美元 ≈ 7.12 人民币',
      },
    ]);
  });

  it('returns quick converter results for volume queries', async () => {
    const service = createLauncherCommandService({ commands: [] });

    await expect(service.searchCommands('1升')).resolves.toMatchObject([
      {
        id: 'quick-converter.result',
        source: 'plugin',
        title: '1 升 = 1000 毫升 = 0.001 立方米 = 1000 立方厘米',
      },
    ]);
  });

  it('returns quick converter results for volume expressions', async () => {
    const service = createLauncherCommandService({ commands: [] });

    await expect(service.searchCommands('1cm * 1cm *1 cm')).resolves.toMatchObject([
      {
        id: 'quick-converter.result',
        source: 'plugin',
        title: '1 厘米 × 1 厘米 × 1 厘米 = 1 立方厘米 = 1 毫升 = 0.001 升 = 0.000001 立方米',
      },
    ]);
  });

  it('removes stale quick converter result commands after unsupported queries', async () => {
    const service = createLauncherCommandService({
      commands: [],
      writeClipboardText: () => undefined,
    });

    await expect(service.searchCommands('1厘米')).resolves.toMatchObject([
      {
        id: 'quick-converter.result',
        title: '1 厘米 = 10 毫米 = 0.01 米 = 0.393701 英寸',
      },
    ]);

    await expect(service.searchCommands('一厘米')).resolves.toEqual([]);
    await expect(service.executeCommand('quick-converter.result')).resolves.toMatchObject({
      error: {
        code: 'invalid-command',
      },
      status: 'failure',
    });
  });

  it('caps clipboard history results during normal searches', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const clipboardHistoryRepository = createClipboardHistoryRepository(database);
      clipboardHistoryRepository.saveText('alpha one');
      clipboardHistoryRepository.saveText('alpha two');
      clipboardHistoryRepository.saveText('alpha three');
      const service = createLauncherCommandService({
        clipboardHistoryRepository,
        commands: [],
      });

      const results = await service.searchCommands('alpha');

      expect(results).toHaveLength(2);
      expect(results.every((result) => result.id.startsWith('clipboard-history.entry.'))).toBe(
        true,
      );
    } finally {
      database.close();
    }
  });

  it('does not cap clipboard history results for explicit clipboard searches', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const clipboardHistoryRepository = createClipboardHistoryRepository(database);
      clipboardHistoryRepository.saveText('clip alpha one');
      clipboardHistoryRepository.saveText('clip alpha two');
      clipboardHistoryRepository.saveText('clip alpha three');
      const service = createLauncherCommandService({
        clipboardHistoryRepository,
        commands: [],
      });

      const results = await service.searchCommands('clip alpha');

      expect(results).toHaveLength(3);
      expect(results.every((result) => result.id.startsWith('clipboard-history.entry.'))).toBe(
        true,
      );
    } finally {
      database.close();
    }
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

  it('does not throw or expose a calculator command for extreme math input', async () => {
    const service = createLauncherCommandService({ commands: [] });
    const excessiveUnaryExpression = `${'+'.repeat(200)}1`;

    await expect(service.searchCommands(excessiveUnaryExpression)).resolves.toEqual([]);
    await expect(service.searchCommands('1 + 2')).resolves.toMatchObject([
      {
        id: 'calculator.result',
        title: '3',
      },
    ]);

    const excessiveNestedExpression = `${'('.repeat(200)}1${')'.repeat(200)}`;

    await expect(service.searchCommands(excessiveNestedExpression)).resolves.toEqual([]);
    await expect(service.searchCommands('1 +')).resolves.toEqual([]);
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

      const [favoriteResult] = await service.searchCommands('cabin');

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

  it('keeps favorite results above matching clipboard history entries', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const clipboardHistoryRepository = createClipboardHistoryRepository(database);
      const favoritesRepository = createFavoritesRepository(database);
      clipboardHistoryRepository.saveText('manual draft');
      clipboardHistoryRepository.saveText('manual notes');
      favoritesRepository.addFavorite({
        kind: 'url',
        title: 'Manual Portal',
        url: 'https://example.com/manual',
        keywords: ['manual'],
      });
      const service = createLauncherCommandService({
        clipboardHistoryRepository,
        commands: [],
        favoritesRepository,
      });

      const results = await service.searchCommands('manual');

      expect(results[0]).toMatchObject({
        source: 'url',
        title: 'Manual Portal',
      });
      expect(
        results.filter((result) => result.id.startsWith('clipboard-history.entry.')),
      ).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('keeps favorite search results in sync after add, edit, and delete operations', async () => {
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

      await expect(service.searchCommands('docs')).resolves.toMatchObject([
        {
          id: expect.any(String) as string,
          source: 'url',
          title: 'Docs Portal',
        },
      ]);

      service.updateFavorite(created.id, {
        title: 'Manual Portal',
        keywords: ['manual'],
      });

      await expect(service.searchCommands('docs')).resolves.toEqual([]);
      await expect(service.searchCommands('manual')).resolves.toMatchObject([
        {
          title: 'Manual Portal',
        },
      ]);

      expect(service.removeFavorite(created.id)).toBe(true);
      await expect(service.searchCommands('manual')).resolves.toEqual([]);
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
      const [favoriteResult] = await service.searchCommands('readme');

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
      const [favoriteResult] = await service.searchCommands('docs');

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

    const [appResult] = await service.searchCommands('notepad');

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

  it('keeps app search results above matching clipboard history entries', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const clipboardHistoryRepository = createClipboardHistoryRepository(database);
      clipboardHistoryRepository.saveText('wps document draft');
      clipboardHistoryRepository.saveText('wps office notes');
      const service = createLauncherCommandService({
        appCommands: () => [
          {
            id: 'app.wps',
            source: 'app',
            title: 'WPS Office',
            subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
            keywords: ['wps office'],
            action: {
              type: 'open-app',
              payload: {
                executablePath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
                shortcutPath: 'C:\\Users\\Ada\\Start Menu\\Programs\\WPS Office.lnk',
              },
            },
          },
        ],
        clipboardHistoryRepository,
        commands: [],
      });

      const results = await service.searchCommands('wps');

      expect(results[0]).toMatchObject({
        id: 'app.wps',
        source: 'app',
        title: 'WPS Office',
      });
      expect(
        results.slice(1).every((result) => result.id.startsWith('clipboard-history.entry.')),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it('adds icon, executable, and shortcut paths as app icon candidates', async () => {
    const service = createLauncherCommandService({
      appCommands: () => [
        {
          id: 'app.wechat',
          source: 'app',
          title: '微信',
          subtitle: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
          icon: ',0',
          keywords: ['微信'],
          action: {
            type: 'open-app',
            payload: {
              executablePath: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
              shortcutPath:
                'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\微信\\微信.lnk',
            },
          },
        },
      ],
      commands: [],
    });

    await expect(service.searchCommands('微信')).resolves.toMatchObject([
      {
        iconCandidates: [
          ',0',
          'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
          'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\微信\\微信.lnk',
        ],
      },
    ]);
  });

  it('records successful app launches in history', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const historyRepository = createHistoryRepository(database);
      const service = createLauncherCommandService({
        appCommands: () => [
          {
            id: 'app.wps',
            source: 'app',
            title: 'WPS Office',
            subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
            keywords: ['wps office'],
            action: {
              type: 'open-app',
              payload: {
                executablePath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
                shortcutPath: 'C:\\Users\\Ada\\Start Menu\\Programs\\WPS Office.lnk',
              },
            },
          },
        ],
        commands: [],
        historyRepository,
        openApp: () => undefined,
      });

      await expect(service.executeCommand('app.wps')).resolves.toMatchObject({
        commandId: 'app.wps',
        status: 'success',
      });

      expect(historyRepository.getByCommandId('app.wps')).toMatchObject({
        commandId: 'app.wps',
        source: 'app',
        title: 'WPS Office',
        subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
      });
    } finally {
      database.close();
    }
  });

  it('returns only recent app commands for an empty query', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const historyRepository = createHistoryRepository(database);
      const service = createLauncherCommandService({
        appCommands: () => [
          {
            id: 'app.wps',
            source: 'app',
            title: 'WPS Office',
            subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
            keywords: ['wps office'],
            action: {
              type: 'open-app',
              payload: {
                executablePath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
                shortcutPath: 'C:\\Users\\Ada\\Start Menu\\Programs\\WPS Office.lnk',
              },
            },
          },
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
        historyRepository,
        openApp: () => undefined,
      });

      await service.executeCommand('app.wps');
      await service.executeCommand('app.notepad');
      const homeResults = await service.searchCommands('');

      expect(homeResults.map((result) => result.title)).toEqual(['Notepad', 'WPS Office']);
      expect(homeResults.every((result) => result.source === 'app')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('returns recently used app commands before unused pinned app favorites for an empty query', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const favoritesRepository = createFavoritesRepository(database);
      const historyRepository = createHistoryRepository(database);
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
        favoritesRepository,
        historyRepository,
        openApp: () => undefined,
      });

      const pinnedApp = service.addPinnedApp('C:\\Program Files\\WPS Office\\ksolaunch.exe');
      await service.executeCommand('app.notepad');
      const homeResults = await service.searchCommands('');

      expect(pinnedApp.title).toBe('ksolaunch');
      expect(homeResults.map((result) => result.title)).toEqual(['Notepad', 'ksolaunch']);
      expect(homeResults.every((result) => result.source === 'app')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('returns resolved pinned shortcut metadata for icons and management', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const service = createLauncherCommandService({
        commands: [],
        favoritesRepository: createFavoritesRepository(database),
      });

      const pinnedApp = service.addPinnedApp({
        appPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        executablePath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
        iconPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
      });

      await expect(service.searchCommands('')).resolves.toMatchObject([
        {
          favoriteId: pinnedApp.id,
          iconCandidates: [
            'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
            'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
            'C:\\Users\\Ada\\Desktop\\Codex.lnk',
          ],
          source: 'app',
          subtitle: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
          title: 'Codex',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('updates an existing pinned app without leaving the old app on the home screen', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const service = createLauncherCommandService({
        commands: [],
        favoritesRepository: createFavoritesRepository(database),
      });

      const pinnedApp = service.addPinnedApp('C:\\Program Files\\WPS Office\\ksolaunch.exe');
      const updatedApp = service.updatePinnedApp(pinnedApp.id, {
        appPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        executablePath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
        iconPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
      });

      expect(updatedApp).toMatchObject({
        id: pinnedApp.id,
        title: 'Codex',
      });
      await expect(service.searchCommands('')).resolves.toMatchObject([
        {
          title: 'Codex',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('skips stale app history entries for an empty query', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const historyRepository = createHistoryRepository(database);
      let includeWps = true;
      const service = createLauncherCommandService({
        appCommands: () => [
          ...(includeWps
            ? [
                {
                  id: 'app.wps',
                  source: 'app' as const,
                  title: 'WPS Office',
                  subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
                  keywords: ['wps office'],
                  action: {
                    type: 'open-app' as const,
                    payload: {
                      executablePath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
                      shortcutPath: 'C:\\Users\\Ada\\Start Menu\\Programs\\WPS Office.lnk',
                    },
                  },
                },
              ]
            : []),
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
        historyRepository,
        openApp: () => undefined,
      });

      await service.executeCommand('app.wps');
      await service.executeCommand('app.notepad');
      includeWps = false;

      await expect(service.searchCommands('')).resolves.toMatchObject([
        {
          id: 'app.notepad',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('removes a recent app entry from the home screen without touching other history', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const historyRepository = createHistoryRepository(database);
      const service = createLauncherCommandService({
        appCommands: () => [
          {
            id: 'app.wps',
            source: 'app',
            title: 'WPS Office',
            subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
            keywords: ['wps office'],
            action: {
              type: 'open-app',
              payload: {
                executablePath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
                shortcutPath: 'C:\\Users\\Ada\\Start Menu\\Programs\\WPS Office.lnk',
              },
            },
          },
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
        historyRepository,
        openApp: () => undefined,
      });

      await service.executeCommand('app.wps');
      await service.executeCommand('app.notepad');

      expect(service.removeRecentApp('app.wps')).toBe(true);
      expect(service.removeRecentApp('app.missing')).toBe(false);
      await expect(service.searchCommands('')).resolves.toMatchObject([
        {
          id: 'app.notepad',
        },
      ]);
    } finally {
      database.close();
    }
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

    const [pluginResult] = await service.searchCommands('ping');

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
