import { describe, expect, it } from 'vitest';

import { openInMemoryCommandCabinDatabase } from '../storage/database.js';
import { runMigrations } from '../storage/migrations.js';
import { createFavoritesRepository } from './favoritesRepository.js';

function createRepository() {
  const database = openInMemoryCommandCabinDatabase();
  runMigrations(database);

  return {
    database,
    repository: createFavoritesRepository(database),
  };
}

describe('SQLite favorites repository', () => {
  it('adds file, folder, and URL favorites and lists them by title', () => {
    const { database, repository } = createRepository();

    try {
      const folder = repository.addFavorite({
        kind: 'folder',
        title: 'Workspace',
        path: 'C:\\WorkingFolder\\command-cabin',
        keywords: ['project', 'repo'],
        metadata: { color: 'green' },
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      });
      const file = repository.addFavorite({
        kind: 'file',
        title: 'Architecture Notes',
        path: 'C:\\WorkingFolder\\command-cabin\\README.md',
        keywords: ['docs'],
        createdAt: '2026-05-15T10:01:00.000Z',
        updatedAt: '2026-05-15T10:01:00.000Z',
      });
      const url = repository.addFavorite({
        kind: 'url',
        title: 'Issue Tracker',
        url: 'https://example.com/issues',
        keywords: ['tickets', 'bugs'],
        createdAt: '2026-05-15T10:02:00.000Z',
        updatedAt: '2026-05-15T10:02:00.000Z',
      });

      expect(file).toMatchObject({
        id: expect.any(String) as string,
        kind: 'file',
        title: 'Architecture Notes',
        path: 'C:\\WorkingFolder\\command-cabin\\README.md',
        keywords: ['docs'],
        metadata: {},
      });
      expect(file.url).toBeUndefined();
      expect(folder).toMatchObject({
        kind: 'folder',
        path: 'C:\\WorkingFolder\\command-cabin',
        metadata: { color: 'green' },
      });
      expect(url).toMatchObject({
        kind: 'url',
        url: 'https://example.com/issues',
      });
      expect(url.path).toBeUndefined();

      expect(repository.listFavorites().map((favorite) => favorite.title)).toEqual([
        'Architecture Notes',
        'Issue Tracker',
        'Workspace',
      ]);
    } finally {
      database.close();
    }
  });

  it('edits favorite titles and keywords without changing stable ids or creation dates', () => {
    const { database, repository } = createRepository();

    try {
      const created = repository.addFavorite({
        kind: 'url',
        title: 'Docs',
        url: 'https://example.com/docs',
        keywords: ['docs'],
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      });

      const updated = repository.updateFavorite(created.id, {
        title: 'Product Docs',
        keywords: ['manual', 'reference'],
        updatedAt: '2026-05-15T11:00:00.000Z',
      });

      expect(updated).toMatchObject({
        id: created.id,
        createdAt: '2026-05-15T10:00:00.000Z',
        keywords: ['manual', 'reference'],
        title: 'Product Docs',
        updatedAt: '2026-05-15T11:00:00.000Z',
      });
      expect(repository.getFavorite(created.id)).toMatchObject({
        title: 'Product Docs',
      });
    } finally {
      database.close();
    }
  });

  it('deletes favorites by id', () => {
    const { database, repository } = createRepository();

    try {
      const created = repository.addFavorite({
        kind: 'file',
        title: 'Readme',
        path: 'C:\\WorkingFolder\\command-cabin\\README.md',
        keywords: [],
      });

      expect(repository.removeFavorite(created.id)).toBe(true);
      expect(repository.removeFavorite(created.id)).toBe(false);
      expect(repository.getFavorite(created.id)).toBeUndefined();
      expect(repository.listFavorites()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each([
    [
      'blank title',
      {
        kind: 'file',
        title: '  ',
        path: 'C:\\Docs\\notes.md',
        keywords: [],
      },
      /favorite title must be a non-empty string/i,
    ],
    [
      'file without a path',
      {
        kind: 'file',
        title: 'Notes',
        keywords: [],
      },
      /file favorite path must be a non-empty string/i,
    ],
    [
      'folder without a path',
      {
        kind: 'folder',
        title: 'Projects',
        keywords: [],
      },
      /folder favorite path must be a non-empty string/i,
    ],
    [
      'URL without a valid URL',
      {
        kind: 'url',
        title: 'Docs',
        url: 'javascript:alert(1)',
        keywords: [],
      },
      /url favorite url must be an http or https url/i,
    ],
    [
      'missing keywords',
      {
        kind: 'url',
        title: 'Docs',
        url: 'https://example.com/docs',
      },
      /favorite keywords must be an array/i,
    ],
    [
      'dirty metadata',
      {
        kind: 'url',
        title: 'Docs',
        url: 'https://example.com/docs',
        keywords: [],
        metadata: { score: Number.POSITIVE_INFINITY },
      },
      /Invalid JSON value in favorites metadata at metadata\.score: number must be finite/,
    ],
  ])('rejects %s before writing a favorite', (_name, input, expectedError) => {
    const { database, repository } = createRepository();

    try {
      expect(() => repository.addFavorite(input as never)).toThrow(expectedError);
      expect(repository.listFavorites()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('throws contextual errors for malformed favorite keywords JSON', () => {
    const { database } = createRepository();

    try {
      database
        .prepare(
          `
            INSERT INTO favorites (
              id,
              kind,
              title,
              path,
              url,
              keywords,
              metadata,
              created_at,
              updated_at
            )
            VALUES (
              'favorite-bad-json',
              'file',
              'Broken',
              'C:\\Docs\\broken.md',
              NULL,
              '{bad-json',
              '{}',
              '2026-05-15T10:00:00.000Z',
              '2026-05-15T10:00:00.000Z'
            )
          `,
        )
        .run();

      expect(() => createFavoritesRepository(database).getFavorite('favorite-bad-json')).toThrow(
        /Invalid JSON in favorites keywords key "favorite-bad-json"/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects stored URL favorites with unsafe protocols before mapping rows', () => {
    const { database } = createRepository();

    try {
      database
        .prepare(
          `
            INSERT INTO favorites (
              id,
              kind,
              title,
              path,
              url,
              keywords,
              metadata,
              created_at,
              updated_at
            )
            VALUES (
              'favorite-file-url',
              'url',
              'Local File',
              NULL,
              'file:///C:/secret.txt',
              '[]',
              '{}',
              '2026-05-15T10:00:00.000Z',
              '2026-05-15T10:00:00.000Z'
            )
          `,
        )
        .run();

      const repository = createFavoritesRepository(database);

      expect(() => repository.getFavorite('favorite-file-url')).toThrow(
        /URL favorite url must be an http or https URL/,
      );
      expect(() => repository.listFavorites()).toThrow(
        /URL favorite url must be an http or https URL/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects stored rows with blank titles or invalid dates before mapping rows', () => {
    const { database } = createRepository();

    try {
      database
        .prepare(
          `
            INSERT INTO favorites (
              id,
              kind,
              title,
              path,
              url,
              keywords,
              metadata,
              created_at,
              updated_at
            )
            VALUES
              (
                'favorite-blank-title',
                'file',
                '   ',
                'C:\\Docs\\blank.md',
                NULL,
                '[]',
                '{}',
                '2026-05-15T10:00:00.000Z',
                '2026-05-15T10:00:00.000Z'
              ),
              (
                'favorite-invalid-date',
                'file',
                'Invalid Date',
                'C:\\Docs\\date.md',
                NULL,
                '[]',
                '{}',
                'not-a-date',
                '2026-05-15T10:00:00.000Z'
              )
          `,
        )
        .run();

      const repository = createFavoritesRepository(database);

      expect(() => repository.getFavorite('favorite-blank-title')).toThrow(
        /favorite title must be a non-empty string/i,
      );
      expect(() => repository.getFavorite('favorite-invalid-date')).toThrow(
        /Invalid date for favorite createdAt/,
      );
    } finally {
      database.close();
    }
  });
});
