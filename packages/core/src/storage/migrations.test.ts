import { describe, expect, it } from 'vitest';

import { openInMemoryCommandCabinDatabase } from './database.js';
import { runMigrations, validateStorageMigrationDefinitions } from './migrations.js';

describe('storage migrations', () => {
  it('creates the local storage schema idempotently', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      const firstRun = runMigrations(database);
      const secondRun = runMigrations(database);

      expect(firstRun.appliedMigrationIds).toEqual([1, 2, 3]);
      expect(secondRun.appliedMigrationIds).toEqual([]);

      const tableRows = database
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name IN (
                'migrations',
                'settings',
                'command_history',
                'plugins',
                'plugin_data',
                'favorites',
                'clipboard_history'
              )
            ORDER BY name
          `,
        )
        .all() as Array<{ name: string }>;

      expect(tableRows.map((row) => row.name)).toEqual([
        'clipboard_history',
        'command_history',
        'favorites',
        'migrations',
        'plugin_data',
        'plugins',
        'settings',
      ]);

      const migrationRows = database
        .prepare('SELECT id, name FROM migrations ORDER BY id')
        .all() as Array<{ id: number; name: string }>;

      expect(migrationRows).toEqual([
        { id: 1, name: '001_initial_storage' },
        { id: 2, name: '002_favorites' },
        { id: 3, name: '003_clipboard_history' },
      ]);
    } finally {
      database.close();
    }
  });

  it('rejects duplicate migration IDs before applying migrations', () => {
    expect(() =>
      validateStorageMigrationDefinitions([
        { id: 1, name: '001_initial_storage', sql: 'SELECT 1;' },
        { id: 1, name: '001_duplicate', sql: 'SELECT 1;' },
      ]),
    ).toThrow(/duplicate migration id 1/i);
  });

  it('rejects out-of-order migration IDs before applying migrations', () => {
    expect(() =>
      validateStorageMigrationDefinitions([
        { id: 2, name: '002_second', sql: 'SELECT 1;' },
        { id: 1, name: '001_first', sql: 'SELECT 1;' },
      ]),
    ).toThrow(/strictly increasing/i);
  });

  it('rejects an existing known migration ID with a different name', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      database.exec(`
        CREATE TABLE migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL
        );

        INSERT INTO migrations (id, name, applied_at)
        VALUES (1, '001_wrong_name', '2026-05-15T10:00:00.000Z');
      `);

      expect(() => runMigrations(database)).toThrow(
        /migration id 1 was applied as "001_wrong_name" but current definition is "001_initial_storage"/i,
      );
    } finally {
      database.close();
    }
  });

  it('rejects an existing known migration name with a different ID before running SQL', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      database.exec(`
        CREATE TABLE migrations (
          id INTEGER,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        INSERT INTO migrations (id, name, applied_at)
        VALUES (99, '001_initial_storage', '2026-05-15T10:00:00.000Z');
      `);

      expect(() => runMigrations(database)).toThrow(
        /migration name "001_initial_storage" was applied with id 99 but current definition uses id 1/i,
      );
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects duplicate applied migration IDs', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      database.exec(`
        CREATE TABLE migrations (
          id INTEGER,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        INSERT INTO migrations (id, name, applied_at)
        VALUES
          (1, '001_initial_storage', '2026-05-15T10:00:00.000Z'),
          (1, '001_duplicate', '2026-05-15T10:01:00.000Z');
      `);

      expect(() => runMigrations(database)).toThrow(/duplicate applied migration id 1/i);
    } finally {
      database.close();
    }
  });

  it('rejects duplicate applied migration names', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      database.exec(`
        CREATE TABLE migrations (
          id INTEGER,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        INSERT INTO migrations (id, name, applied_at)
        VALUES
          (1, '001_initial_storage', '2026-05-15T10:00:00.000Z'),
          (2, '001_initial_storage', '2026-05-15T10:01:00.000Z');
      `);

      expect(() => runMigrations(database)).toThrow(
        /duplicate applied migration name "001_initial_storage"/i,
      );
    } finally {
      database.close();
    }
  });

  it('rejects non-increasing applied migration IDs', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      database.exec(`
        CREATE TABLE migrations (
          id INTEGER,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        INSERT INTO migrations (id, name, applied_at)
        VALUES
          (99, '099_future', '2026-05-15T10:00:00.000Z'),
          (1, '001_initial_storage', '2026-05-15T10:01:00.000Z');
      `);

      expect(() => runMigrations(database)).toThrow(
        /applied migration IDs must be strictly increasing/i,
      );
    } finally {
      database.close();
    }
  });

  it('rejects unknown applied migration IDs and names', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      database.exec(`
        CREATE TABLE migrations (
          id INTEGER,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        INSERT INTO migrations (id, name, applied_at)
        VALUES (99, '099_future', '2026-05-15T10:00:00.000Z');
      `);

      expect(() => runMigrations(database)).toThrow(
        /unknown applied migration id 99 with name "099_future"/i,
      );
    } finally {
      database.close();
    }
  });
});
