import type { Command, FavoriteRecord } from '@command-cabin/core';
import { describe, expect, it, vi } from 'vitest';

import { createAppCandidateService, type InternalAppCandidate } from './appCandidateService.js';

function createAppCommand({
  executablePath,
  icon,
  id = 'app.wps',
  shortcutPath,
  title = 'WPS Office',
}: {
  executablePath: string;
  icon?: string | undefined;
  id?: string | undefined;
  shortcutPath: string;
  title?: string | undefined;
}): Command {
  return {
    id,
    source: 'app',
    title,
    subtitle: executablePath,
    keywords: [title, executablePath],
    ...(icon ? { icon } : {}),
    action: {
      type: 'open-app',
      payload: {
        executablePath,
        shortcutPath,
      },
    },
  };
}

function createPinnedFavorite({
  executablePath,
  id = 'favorite-wps',
  path,
  title = 'WPS Office',
}: {
  executablePath?: string | undefined;
  id?: string | undefined;
  path: string;
  title?: string | undefined;
}): FavoriteRecord {
  return {
    createdAt: '2026-05-17T00:00:00.000Z',
    id,
    kind: 'file',
    keywords: [title],
    metadata: {
      launcherPinnedApp: true,
      ...(executablePath ? { launcherPinnedAppExecutablePath: executablePath } : {}),
    },
    path,
    title,
    updatedAt: '2026-05-17T00:00:00.000Z',
  };
}

describe('createAppCandidateService', () => {
  it('merges desktop shortcuts and start menu app commands with icon candidates', async () => {
    const resolveShortcut = vi.fn(async () => ({
      iconPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
      targetPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
    }));
    const service = createAppCandidateService({
      appCommands: () => [
        createAppCommand({
          executablePath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
          icon: 'C:\\Program Files\\WPS Office\\ksolaunch.exe,0',
          shortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\WPS Office.lnk',
        }),
      ],
      favorites: () => [],
      listDesktopShortcuts: async () => ['C:\\Users\\Ada\\Desktop\\Codex.lnk'],
      resolveShortcut,
    });

    await expect(service.listCandidates('')).resolves.toMatchObject([
      {
        iconCandidates: [],
        resolutionStatus: 'unresolved-shortcut',
        shortcutPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        source: 'desktop',
        title: 'Codex',
      },
      {
        executablePath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
        resolutionStatus: 'resolved',
        source: 'start-menu',
        title: 'WPS Office',
      },
    ]);
    expect(resolveShortcut).not.toHaveBeenCalled();
  });

  it('resolves matching desktop shortcuts after the user searches', async () => {
    const service = createAppCandidateService({
      appCommands: () => [],
      favorites: () => [],
      listDesktopShortcuts: async () => ['C:\\Users\\Ada\\Desktop\\Codex.lnk'],
      resolveShortcut: vi.fn(async () => ({
        iconPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
        targetPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
      })),
    });

    await expect(service.listCandidates('codex')).resolves.toMatchObject([
      {
        executablePath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
        iconCandidates: [
          'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
          'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
        ],
        iconPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
        resolutionStatus: 'resolved',
        shortcutPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        source: 'desktop',
        title: 'Codex',
      },
    ]);
  });

  it('keeps unresolved desktop shortcuts visible with fallback metadata', async () => {
    const service = createAppCandidateService({
      appCommands: () => [],
      favorites: () => [],
      listDesktopShortcuts: async () => ['C:\\Users\\Ada\\Desktop\\Claude.lnk'],
      resolveShortcut: vi.fn(async () => ({})),
    });

    await expect(service.listCandidates('claude')).resolves.toMatchObject([
      {
        iconCandidates: [],
        resolutionStatus: 'unresolved-shortcut',
        shortcutPath: 'C:\\Users\\Ada\\Desktop\\Claude.lnk',
        source: 'desktop',
        subtitle: 'C:\\Users\\Ada\\Desktop\\Claude.lnk',
        title: 'Claude',
      },
    ]);
  });

  it('marks candidates that are already pinned by executable identity', async () => {
    const executablePath = 'C:\\Program Files\\WPS Office\\ksolaunch.exe';
    const service = createAppCandidateService({
      appCommands: () => [
        createAppCommand({
          executablePath,
          shortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\WPS Office.lnk',
        }),
      ],
      favorites: () => [
        createPinnedFavorite({
          executablePath,
          path: 'C:\\Users\\Ada\\Desktop\\WPS Office.lnk',
        }),
      ],
      listDesktopShortcuts: async () => [],
      resolveShortcut: vi.fn(),
    });

    await expect(service.listCandidates('wps')).resolves.toMatchObject([
      {
        alreadyPinned: true,
        title: 'WPS Office',
      },
    ]);
  });

  it('creates a pinned app input from a selected candidate', () => {
    const service = createAppCandidateService({
      appCommands: () => [],
      favorites: () => [],
      listDesktopShortcuts: async () => [],
      resolveShortcut: vi.fn(),
    });
    const candidate: InternalAppCandidate = {
      alreadyPinned: false,
      executablePath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
      iconCandidates: [],
      iconPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
      id: 'desktop.codex',
      resolutionStatus: 'resolved',
      shortcutPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
      source: 'desktop',
      subtitle: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
      title: 'Codex',
    };

    expect(service.createPinnedAppInput(candidate)).toEqual({
      appPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
      executablePath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
      iconPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
      title: 'Codex',
    });
  });
});
