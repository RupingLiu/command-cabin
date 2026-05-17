import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAppIndexer,
  createAppCommandsFromShortcuts,
  type AppIndexCache,
  type AppIndexerScanner,
} from './appIndexer.js';

function createCache(): AppIndexCache {
  let writtenCommands = 0;

  return {
    read: async () => undefined,
    write: async (commands) => {
      writtenCommands = commands.length;
      return {
        version: 1,
        scannedAt: '2026-05-16T01:00:00.000Z',
        commands: [...commands],
      };
    },
    isStale: () => false,
    getWrittenCommandCount: () => writtenCommands,
  } as AppIndexCache & { getWrittenCommandCount: () => number };
}

describe('app indexer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates stable app commands from resolved shortcuts', () => {
    const commands = createAppCommandsFromShortcuts([
      {
        name: 'Notepad',
        shortcutPath: 'C:\\StartMenu\\Accessories\\Notepad.lnk',
        targetPath: 'C:\\Windows\\System32\\notepad.exe',
        arguments: '',
        workingDirectory: 'C:\\Windows\\System32',
        iconPath: 'C:\\Windows\\System32\\notepad.exe,0',
      },
      {
        name: 'Docs',
        shortcutPath: 'C:\\StartMenu\\Docs.lnk',
        targetPath: 'C:\\Users\\Ada\\Documents',
      },
    ]);

    expect(commands).toEqual([
      {
        id: 'app.a3a2b1ca8a67',
        source: 'app',
        title: 'Notepad',
        subtitle: 'C:\\Windows\\System32\\notepad.exe',
        keywords: ['Notepad', 'notepad', 'Accessories', 'C:\\Windows\\System32\\notepad.exe'],
        icon: 'C:\\Windows\\System32\\notepad.exe,0',
        action: {
          type: 'open-app',
          payload: {
            executablePath: 'C:\\Windows\\System32\\notepad.exe',
            arguments: '',
            workingDirectory: 'C:\\Windows\\System32',
            shortcutPath: 'C:\\StartMenu\\Accessories\\Notepad.lnk',
          },
        },
      },
      {
        id: 'app.6ac4a1e3a037',
        source: 'app',
        title: 'Docs',
        subtitle: 'C:\\Users\\Ada\\Documents',
        keywords: ['Docs', 'docs', 'C:\\Users\\Ada\\Documents'],
        action: {
          type: 'open-path',
          payload: {
            path: 'C:\\Users\\Ada\\Documents',
            shortcutPath: 'C:\\StartMenu\\Docs.lnk',
          },
        },
      },
    ]);
  });

  it('de-duplicates generated app commands by stable shortcut id', () => {
    const commands = createAppCommandsFromShortcuts([
      {
        name: 'Notepad',
        shortcutPath: 'C:\\StartMenu\\Accessories\\Notepad.lnk',
        targetPath: 'C:\\Windows\\System32\\notepad.exe',
      },
      {
        name: 'Notepad Duplicate',
        shortcutPath: 'c:/startmenu/accessories/notepad.lnk',
        targetPath: 'C:\\Windows\\System32\\notepad.exe',
      },
    ]);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      id: 'app.a3a2b1ca8a67',
      title: 'Notepad',
    });
  });

  it('de-duplicates generated app commands that point to the same executable', () => {
    const commands = createAppCommandsFromShortcuts([
      {
        name: '腾讯会议',
        shortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\腾讯会议.lnk',
        targetPath: 'C:\\Program Files\\Tencent\\WeMeet\\wemeetapp.exe',
      },
      {
        name: '腾讯会议',
        shortcutPath:
          'C:\\Users\\Ada\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\腾讯会议.lnk',
        targetPath: 'C:\\Program Files\\Tencent\\WeMeet\\wemeetapp.exe',
      },
      {
        name: '卸载 腾讯会议',
        shortcutPath:
          'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\卸载 腾讯会议.lnk',
        targetPath: 'C:\\Program Files\\Tencent\\WeMeet\\3.43.3.406\\WeMeetUninstall.exe',
      },
    ]);

    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.title)).toEqual(['腾讯会议', '卸载 腾讯会议']);
  });

  it('creates launchable app commands for unresolved desktop shortcuts', () => {
    const commands = createAppCommandsFromShortcuts([
      {
        name: 'Codex',
        opensApplication: true,
        shortcutPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
      },
    ]);

    expect(commands).toEqual([
      {
        id: 'app.901f6fa8c20c',
        source: 'app',
        title: 'Codex',
        subtitle: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        keywords: ['Codex', 'codex', 'Desktop', 'C:\\Users\\Ada\\Desktop\\Codex.lnk'],
        action: {
          type: 'open-app',
          payload: {
            shortcutPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
          },
        },
      },
    ]);
  });

  it('manually refreshes by scanning, generating commands, caching, and updating memory', async () => {
    const scanner: AppIndexerScanner = {
      scan: async () => ({
        shortcuts: [
          {
            name: 'Calculator',
            shortcutPath: 'C:\\StartMenu\\Calculator.lnk',
            targetPath: 'C:\\Windows\\System32\\calc.exe',
          },
        ],
        failures: [],
      }),
    };
    const cache = createCache();
    const indexer = createAppIndexer({ scanner, cache });

    const snapshot = await indexer.refresh();

    expect(snapshot.commands).toMatchObject([
      {
        source: 'app',
        title: 'Calculator',
        action: {
          type: 'open-app',
          payload: {
            executablePath: 'C:\\Windows\\System32\\calc.exe',
          },
        },
      },
    ]);
    expect(snapshot.failures).toEqual([]);
    expect(indexer.getCommands()).toEqual(snapshot.commands);
    expect(
      (cache as AppIndexCache & { getWrittenCommandCount: () => number }).getWrittenCommandCount(),
    ).toBe(1);
  });

  it('loads fresh cached commands without scanning', async () => {
    const scanner: AppIndexerScanner = {
      scan: vi.fn(async () => ({ shortcuts: [], failures: [] })),
    };
    const indexer = createAppIndexer({
      scanner,
      cache: {
        read: async () => ({
          version: 1,
          scannedAt: '2026-05-16T01:00:00.000Z',
          commands: [
            {
              id: 'app.cached',
              source: 'app',
              title: 'Cached App',
              keywords: ['cached'],
              action: {
                type: 'open-app',
                payload: {
                  executablePath: 'C:\\cached.exe',
                },
              },
            },
          ],
        }),
        write: vi.fn(),
        isStale: () => false,
      },
    });

    const snapshot = await indexer.load();

    expect(snapshot?.commands).toMatchObject([{ id: 'app.cached' }]);
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(indexer.getCommands()).toEqual(snapshot?.commands);
  });

  it('de-duplicates matching app commands loaded from cache', async () => {
    const scanner: AppIndexerScanner = {
      scan: vi.fn(async () => ({ shortcuts: [], failures: [] })),
    };
    const indexer = createAppIndexer({
      scanner,
      cache: {
        read: async () => ({
          version: 1,
          scannedAt: '2026-05-16T01:00:00.000Z',
          commands: [
            {
              id: 'app.cached-one',
              source: 'app',
              title: '腾讯会议',
              keywords: ['腾讯会议'],
              action: {
                type: 'open-app',
                payload: {
                  executablePath: 'C:\\Program Files\\Tencent\\WeMeet\\wemeetapp.exe',
                  shortcutPath:
                    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\腾讯会议.lnk',
                },
              },
            },
            {
              id: 'app.cached-two',
              source: 'app',
              title: '腾讯会议',
              keywords: ['腾讯会议'],
              action: {
                type: 'open-app',
                payload: {
                  executablePath: 'C:\\Program Files\\Tencent\\WeMeet\\wemeetapp.exe',
                  shortcutPath:
                    'C:\\Users\\Ada\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\腾讯会议.lnk',
                },
              },
            },
          ],
        }),
        write: vi.fn(),
        isStale: () => false,
      },
    });

    const snapshot = await indexer.load();

    expect(snapshot?.commands).toHaveLength(1);
    expect(snapshot?.commands[0]).toMatchObject({
      id: 'app.cached-one',
      title: '腾讯会议',
    });
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(indexer.getCommands()).toEqual(snapshot?.commands);
  });

  it('refreshes instead of loading stale cached commands', async () => {
    const scanner: AppIndexerScanner = {
      scan: vi.fn(async () => ({
        shortcuts: [
          {
            name: 'Fresh',
            shortcutPath: 'C:\\StartMenu\\Fresh.lnk',
            targetPath: 'C:\\fresh.exe',
          },
        ],
        failures: [],
      })),
    };
    const indexer = createAppIndexer({
      scanner,
      cache: {
        read: async () => ({
          version: 1,
          scannedAt: '2026-05-16T00:00:00.000Z',
          commands: [],
        }),
        write: async (commands) => ({
          version: 1,
          scannedAt: '2026-05-16T01:00:00.000Z',
          commands: [...commands],
        }),
        isStale: () => true,
      },
    });

    const snapshot = await indexer.load();

    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(snapshot?.commands).toMatchObject([{ title: 'Fresh' }]);
  });

  it('falls back to refresh when cached commands are corrupted', async () => {
    const scanner: AppIndexerScanner = {
      scan: vi.fn(async () => ({
        shortcuts: [
          {
            name: 'Recovered',
            shortcutPath: 'C:\\StartMenu\\Recovered.lnk',
            targetPath: 'C:\\recovered.exe',
          },
        ],
        failures: [],
      })),
    };
    const indexer = createAppIndexer({
      scanner,
      cache: {
        read: async () => {
          throw new Error('Invalid app index cache at "apps.json": commands[0].source must be app');
        },
        write: async (commands) => ({
          version: 1,
          scannedAt: '2026-05-16T01:00:00.000Z',
          commands: [...commands],
        }),
        isStale: () => false,
      },
    });

    const snapshot = await indexer.load();

    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(snapshot?.source).toBe('scan');
    expect(snapshot?.commands).toMatchObject([{ title: 'Recovered' }]);
  });

  it('exposes start and stop APIs for timer-driven refresh', async () => {
    vi.useFakeTimers();
    const scanner: AppIndexerScanner = {
      scan: vi.fn(async () => ({ shortcuts: [], failures: [] })),
    };
    const indexer = createAppIndexer({
      scanner,
      cache: createCache(),
      refreshIntervalMs: 1_000,
    });

    indexer.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(2_500);
    indexer.stopAutoRefresh();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(scanner.scan).toHaveBeenCalledTimes(2);
  });

  it('skips overlapping auto-refresh ticks while a refresh is in flight', async () => {
    vi.useFakeTimers();
    let finishFirstScan: (() => void) | undefined;
    const scanner: AppIndexerScanner = {
      scan: vi.fn(
        () =>
          new Promise((resolve) => {
            finishFirstScan = () => resolve({ shortcuts: [], failures: [] });
          }),
      ),
    };
    const indexer = createAppIndexer({
      scanner,
      cache: createCache(),
      refreshIntervalMs: 1_000,
    });

    indexer.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(scanner.scan).toHaveBeenCalledTimes(1);

    finishFirstScan?.();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(scanner.scan).toHaveBeenCalledTimes(2);
    indexer.stopAutoRefresh();
  });

  it('handles rejected auto-refreshes through the injected error callback', async () => {
    vi.useFakeTimers();
    const refreshError = new Error('scan failed');
    const onRefreshError = vi.fn();
    const scanner: AppIndexerScanner = {
      scan: vi.fn(async () => {
        throw refreshError;
      }),
    };
    const indexer = createAppIndexer({
      scanner,
      cache: createCache(),
      refreshIntervalMs: 1_000,
      onRefreshError,
    });

    indexer.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onRefreshError).toHaveBeenCalledWith(refreshError);
    indexer.stopAutoRefresh();
  });
});
