import { describe, expect, it } from 'vitest';

import type { FavoriteRecord } from '../indexer/favoritesRepository.js';
import {
  LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY,
  LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY,
  LAUNCHER_PINNED_APP_METADATA_KEY,
  createFavoriteCommand,
  createFavoriteCommands,
} from './builtInFavorites.js';

function createFavorite(overrides: Partial<FavoriteRecord> = {}): FavoriteRecord {
  return {
    id: 'favorite-docs',
    kind: 'file',
    title: 'Project Docs',
    path: 'C:\\Docs\\Project.md',
    keywords: ['docs', 'project'],
    metadata: {},
    createdAt: '2026-05-15T10:00:00.000Z',
    updatedAt: '2026-05-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('built-in favorite commands', () => {
  it('converts file and folder favorites into open-path commands', () => {
    const fileCommand = createFavoriteCommand(createFavorite());
    const folderCommand = createFavoriteCommand(
      createFavorite({
        id: 'favorite-folder',
        kind: 'folder',
        title: 'Workspace',
        path: 'C:\\WorkingFolder\\command-cabin',
        keywords: ['repo'],
      }),
    );

    expect(fileCommand).toMatchObject({
      source: 'file',
      title: 'Project Docs',
      subtitle: 'C:\\Docs\\Project.md',
      action: {
        type: 'open-path',
        payload: {
          favoriteId: 'favorite-docs',
          favoriteKind: 'file',
          path: 'C:\\Docs\\Project.md',
        },
      },
    });
    expect(fileCommand.keywords).toEqual(['project docs', 'docs', 'project', 'file']);
    expect(folderCommand).toMatchObject({
      source: 'file',
      action: {
        type: 'open-path',
        payload: {
          favoriteId: 'favorite-folder',
          favoriteKind: 'folder',
          path: 'C:\\WorkingFolder\\command-cabin',
        },
      },
    });
  });

  it('converts URL favorites into open-url commands', () => {
    const command = createFavoriteCommand(
      createFavorite({
        id: 'favorite-url',
        kind: 'url',
        title: 'Issue Tracker',
        path: undefined,
        url: 'https://example.com/issues',
        keywords: ['bugs'],
      }),
    );

    expect(command).toMatchObject({
      source: 'url',
      title: 'Issue Tracker',
      subtitle: 'https://example.com/issues',
      action: {
        type: 'open-url',
        payload: {
          favoriteId: 'favorite-url',
          url: 'https://example.com/issues',
        },
      },
    });
    expect(command.keywords).toEqual(['issue tracker', 'bugs', 'url']);
  });

  it('converts launcher pinned app favorites into app commands', () => {
    const command = createFavoriteCommand(
      createFavorite({
        id: 'favorite-wps',
        title: 'WPS Office',
        path: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
        keywords: ['wps'],
        metadata: {
          [LAUNCHER_PINNED_APP_METADATA_KEY]: true,
        },
      }),
    );

    expect(command).toMatchObject({
      source: 'app',
      title: 'WPS Office',
      subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
      action: {
        type: 'open-app',
        payload: {
          executablePath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
          favoriteId: 'favorite-wps',
          shortcutPath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
        },
      },
    });
  });

  it('uses resolved executable and icon metadata for launcher pinned shortcuts', () => {
    const command = createFavoriteCommand(
      createFavorite({
        id: 'favorite-codex',
        title: 'Codex',
        path: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        keywords: ['codex'],
        metadata: {
          [LAUNCHER_PINNED_APP_METADATA_KEY]: true,
          [LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY]:
            'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
          [LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY]:
            'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
        },
      }),
    );

    expect(command).toMatchObject({
      source: 'app',
      title: 'Codex',
      subtitle: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
      icon: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
      action: {
        type: 'open-app',
        payload: {
          executablePath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
          favoriteId: 'favorite-codex',
          shortcutPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        },
      },
    });
  });

  it('keeps command ids stable across title and keyword edits', () => {
    const original = createFavoriteCommand(createFavorite());
    const edited = createFavoriteCommand(
      createFavorite({
        title: 'Renamed Docs',
        keywords: ['manual'],
        updatedAt: '2026-05-15T11:00:00.000Z',
      }),
    );

    expect(original.id).toMatch(/^favorite\.[a-f0-9]{12}$/);
    expect(edited.id).toBe(original.id);
  });

  it('drops duplicate favorite command ids when converting lists', () => {
    const commands = createFavoriteCommands([
      createFavorite(),
      createFavorite({
        title: 'Duplicate Docs',
        keywords: ['duplicate'],
      }),
      createFavorite({
        id: 'favorite-url',
        kind: 'url',
        title: 'Issue Tracker',
        path: undefined,
        url: 'https://example.com/issues',
        keywords: ['bugs'],
      }),
    ]);

    expect(commands.map((command) => command.title)).toEqual(['Project Docs', 'Issue Tracker']);
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
  });
});
