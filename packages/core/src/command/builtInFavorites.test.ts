import { describe, expect, it } from 'vitest';

import type { FavoriteRecord } from '../indexer/favoritesRepository.js';
import { createFavoriteCommand, createFavoriteCommands } from './builtInFavorites.js';

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
