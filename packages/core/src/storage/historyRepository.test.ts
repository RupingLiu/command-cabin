import { describe, expect, it } from 'vitest';

import { openInMemoryCommandCabinDatabase } from './database.js';
import { createHistoryRepository } from './historyRepository.js';
import { runMigrations } from './migrations.js';

describe('SQLite command history repository', () => {
  it('records command execution counts and returns recent history first', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createHistoryRepository(database);

      repository.recordExecution({
        commandId: 'system.lock-screen',
        title: 'Lock Screen',
        source: 'system',
        executedAt: new Date('2026-05-15T10:00:00.000Z'),
        metadata: { matchedBy: 'title' },
      });
      const updatedEntry = repository.recordExecution({
        commandId: 'system.lock-screen',
        title: 'Lock Screen',
        source: 'system',
        executedAt: new Date('2026-05-15T10:01:00.000Z'),
        metadata: { matchedBy: 'hotkey' },
      });
      repository.recordExecution({
        commandId: 'plugin.text.uppercase',
        title: 'Uppercase',
        subtitle: 'Text Tools',
        source: 'plugin',
        executedAt: new Date('2026-05-15T10:02:00.000Z'),
      });

      expect(updatedEntry).toMatchObject({
        commandId: 'system.lock-screen',
        title: 'Lock Screen',
        source: 'system',
        executionCount: 2,
        executedAt: '2026-05-15T10:01:00.000Z',
        metadata: { matchedBy: 'hotkey' },
      });
      expect(repository.getByCommandId('system.lock-screen')).toMatchObject({
        executionCount: 2,
      });
      expect(repository.listRecent(2).map((entry) => entry.commandId)).toEqual([
        'plugin.text.uppercase',
        'system.lock-screen',
      ]);
    } finally {
      database.close();
    }
  });

  it('clears command history', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createHistoryRepository(database);

      repository.recordExecution({
        commandId: 'app.notepad',
        title: 'Notepad',
        source: 'app',
        executedAt: new Date('2026-05-15T10:00:00.000Z'),
      });
      repository.clear();

      expect(repository.listRecent()).toEqual([]);
      expect(repository.getByCommandId('app.notepad')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('removes one command history entry by command id', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createHistoryRepository(database);

      repository.recordExecution({
        commandId: 'app.wps',
        title: 'WPS Office',
        source: 'app',
        executedAt: new Date('2026-05-15T10:00:00.000Z'),
      });
      repository.recordExecution({
        commandId: 'app.notepad',
        title: 'Notepad',
        source: 'app',
        executedAt: new Date('2026-05-15T10:01:00.000Z'),
      });

      expect(repository.removeByCommandId('app.wps')).toBe(true);
      expect(repository.getByCommandId('app.wps')).toBeUndefined();
      expect(repository.listRecent().map((entry) => entry.commandId)).toEqual(['app.notepad']);
      expect(repository.removeByCommandId('app.missing')).toBe(false);
    } finally {
      database.close();
    }
  });

  it('returns no rows for a zero recent-history limit', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createHistoryRepository(database);

      repository.recordExecution({
        commandId: 'app.notepad',
        title: 'Notepad',
        source: 'app',
        executedAt: new Date('2026-05-15T10:00:00.000Z'),
      });

      expect(repository.listRecent(0)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('rejects a %s recent-history limit before querying SQLite', (_name, limit) => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createHistoryRepository(database);

      expect(() => repository.listRecent(limit)).toThrow(
        /command history listRecent limit must be a safe integer >= 0/i,
      );
    } finally {
      database.close();
    }
  });

  it('caps very large recent-history limits', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createHistoryRepository(database);

      for (let index = 0; index < 105; index += 1) {
        repository.recordExecution({
          commandId: `command.${index}`,
          title: `Command ${index}`,
          source: 'system',
          executedAt: new Date(Date.UTC(2026, 4, 15, 10, index, 0)),
        });
      }

      expect(repository.listRecent(10_000)).toHaveLength(100);
    } finally {
      database.close();
    }
  });

  it('throws contextual errors for invalid execution dates', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createHistoryRepository(database);

      expect(() =>
        repository.recordExecution({
          commandId: 'app.notepad',
          title: 'Notepad',
          source: 'app',
          executedAt: 'not-a-date',
        }),
      ).toThrow(/Invalid date for command history recordExecution executedAt/);
    } finally {
      database.close();
    }
  });

  it('throws contextual errors for malformed history metadata JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      database
        .prepare(
          `
            INSERT INTO command_history (
              command_id,
              title,
              source,
              execution_count,
              executed_at,
              metadata
            )
            VALUES (
              'app.notepad',
              'Notepad',
              'app',
              1,
              '2026-05-15T10:00:00.000Z',
              '{bad-json'
            )
          `,
        )
        .run();

      expect(() => createHistoryRepository(database).getByCommandId('app.notepad')).toThrow(
        /Invalid JSON in command_history metadata for command "app.notepad"/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects dirty metadata values before writing history JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createHistoryRepository(database);

      expect(() =>
        repository.recordExecution({
          commandId: 'app.notepad',
          title: 'Notepad',
          source: 'app',
          metadata: {
            score: Number.POSITIVE_INFINITY,
          },
        }),
      ).toThrow(
        /Invalid JSON value in command_history metadata for command "app.notepad" at metadata\.score: number must be finite/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects array metadata before writing history rows', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createHistoryRepository(database);

      expect(() =>
        repository.recordExecution({
          commandId: 'app.notepad',
          title: 'Notepad',
          source: 'app',
          metadata: [] as never,
        }),
      ).toThrow(
        /Invalid command history metadata in command_history metadata for command "app.notepad": metadata must be an object/,
      );
      expect(repository.getByCommandId('app.notepad')).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
