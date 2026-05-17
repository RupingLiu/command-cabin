import { describe, expect, it, vi } from 'vitest';

import { listDesktopShortcutCommands } from './desktopShortcutCommands.js';

describe('listDesktopShortcutCommands', () => {
  it('creates launchable app commands from top-level desktop shortcuts', () => {
    const commands = listDesktopShortcutCommands({
      directories: ['C:\\Users\\Ada\\Desktop'],
      readDirectory: vi.fn(() => [
        { isFile: () => true, name: 'Codex.lnk' },
        { isFile: () => true, name: 'notes.txt' },
        { isFile: () => false, name: 'Nested' },
      ]),
    });

    expect(commands).toMatchObject([
      {
        source: 'app',
        title: 'Codex',
        subtitle: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        action: {
          type: 'open-app',
          payload: {
            shortcutPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
          },
        },
      },
    ]);
  });

  it('continues when a desktop directory is unavailable', () => {
    const commands = listDesktopShortcutCommands({
      directories: ['C:\\Missing', 'C:\\Public\\Desktop'],
      readDirectory: vi.fn((directory) => {
        if (directory === 'C:\\Missing') {
          throw new Error('directory unavailable');
        }

        return [{ isFile: () => true, name: 'Claude - 快捷方式.lnk' }];
      }),
    });

    expect(commands).toMatchObject([
      {
        title: 'Claude',
        subtitle: 'C:\\Public\\Desktop\\Claude - 快捷方式.lnk',
      },
    ]);
  });
});
