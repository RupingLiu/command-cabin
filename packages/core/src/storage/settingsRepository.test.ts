import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openCommandCabinDatabase, openInMemoryCommandCabinDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createSettingsRepository } from './settingsRepository.js';

describe('SQLite settings repository', () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns Task 3 defaults when no settings row exists', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createSettingsRepository(database);

      expect(repository.getSettings()).toEqual({
        hotkey: 'Alt+Space',
        hideOnBlur: true,
        theme: 'system',
        language: 'zh-CN',
        launchAtLogin: false,
        preserveSearchQuery: false,
        search: {
          maxResults: 20,
          historyBoost: 1.4,
          pluginBoost: 1,
          appBoost: 1.2,
          fileBoost: 0.9,
        },
      });
    } finally {
      database.close();
    }
  });

  it('keeps returned settings isolated from caller mutations', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createSettingsRepository(database);

      const settings = repository.updateSettings({
        hotkey: 'Ctrl+Space',
        search: {
          maxResults: 12,
        },
      });

      settings.search.maxResults = 99;

      expect(repository.getSettings()).toMatchObject({
        hotkey: 'Ctrl+Space',
        search: {
          maxResults: 12,
          historyBoost: 1.4,
        },
      });
    } finally {
      database.close();
    }
  });

  it('persists partial updates across database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'command-cabin-settings-'));
    tempDirectories.push(directory);
    const databasePath = join(directory, 'settings.sqlite');

    const firstDatabase = openCommandCabinDatabase({ path: databasePath });
    runMigrations(firstDatabase);
    createSettingsRepository(firstDatabase).updateSettings({
      hideOnBlur: false,
      preserveSearchQuery: true,
      theme: 'dark',
      search: {
        pluginBoost: 1.8,
      },
    });
    firstDatabase.close();

    const secondDatabase = openCommandCabinDatabase({ path: databasePath });

    try {
      runMigrations(secondDatabase);
      expect(createSettingsRepository(secondDatabase).getSettings()).toMatchObject({
        hotkey: 'Alt+Space',
        hideOnBlur: false,
        preserveSearchQuery: true,
        theme: 'dark',
        search: {
          maxResults: 20,
          pluginBoost: 1.8,
        },
      });
    } finally {
      secondDatabase.close();
    }
  });

  it('persists Traditional Chinese as a supported display language', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createSettingsRepository(database);

      expect(repository.updateSettings({ language: 'zh-TW' }).language).toBe('zh-TW');
      expect(repository.getSettings().language).toBe('zh-TW');
    } finally {
      database.close();
    }
  });

  it('persists reset settings as canonical defaults', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createSettingsRepository(database);

      repository.updateSettings({ hotkey: 'Ctrl+Alt+Space', launchAtLogin: true });

      expect(repository.resetSettings()).toMatchObject({
        hotkey: 'Alt+Space',
        launchAtLogin: false,
      });
      expect(repository.getSettings()).toMatchObject({
        hotkey: 'Alt+Space',
        launchAtLogin: false,
      });
    } finally {
      database.close();
    }
  });

  it('throws contextual errors for malformed persisted settings JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      database
        .prepare(
          `
            INSERT INTO settings (key, value, updated_at)
            VALUES ('command-cabin', '{bad-json', '2026-05-15T10:00:00.000Z')
          `,
        )
        .run();

      expect(() => createSettingsRepository(database).getSettings()).toThrow(
        /Invalid JSON in settings key "command-cabin"/,
      );
    } finally {
      database.close();
    }
  });

  it('throws contextual errors for wrong-shape persisted settings JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      database
        .prepare(
          `
            INSERT INTO settings (key, value, updated_at)
            VALUES (
              'command-cabin',
              '{"hotkey":42,"search":{"maxResults":"many"}}',
              '2026-05-15T10:00:00.000Z'
            )
          `,
        )
        .run();

      expect(() => createSettingsRepository(database).getSettings()).toThrow(
        /Invalid settings in settings key "command-cabin": hotkey must be a string/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects dirty settings values before writing JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createSettingsRepository(database);

      expect(() =>
        repository.updateSettings({
          search: {
            historyBoost: Number.NaN,
          },
        }),
      ).toThrow(
        /Invalid settings in settings key "command-cabin": search\.historyBoost must be finite/,
      );
      expect(repository.getSettings().search.historyBoost).toBe(1.4);
    } finally {
      database.close();
    }
  });

  it('rejects invalid merged setting shapes without corrupting stored settings', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createSettingsRepository(database);

      repository.updateSettings({ theme: 'dark' });

      expect(() =>
        repository.updateSettings({
          theme: 'neon' as never,
        }),
      ).toThrow(
        /Invalid settings in settings key "command-cabin": theme must be "system", "light", or "dark"/,
      );
      expect(repository.getSettings().theme).toBe('dark');
    } finally {
      database.close();
    }
  });

  it.each([
    ['string', 'oops'],
    ['array', []],
    ['null', null],
  ])('rejects search as %s before merging and preserves stored settings', (_name, search) => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createSettingsRepository(database);

      repository.updateSettings({
        hotkey: 'Ctrl+Space',
        search: {
          maxResults: 12,
        },
      });

      expect(() =>
        repository.updateSettings({
          search: search as never,
        }),
      ).toThrow(/Invalid settings in settings key "command-cabin": search must be an object/);
      expect(repository.getSettings()).toMatchObject({
        hotkey: 'Ctrl+Space',
        search: {
          maxResults: 12,
          historyBoost: 1.4,
        },
      });
    } finally {
      database.close();
    }
  });

  it('rejects unknown search keys before persistence', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createSettingsRepository(database);

      expect(() =>
        repository.updateSettings({
          search: {
            unexpectedBoost: 2,
          } as never,
        }),
      ).toThrow(
        /Invalid settings in settings key "command-cabin": unknown search setting "unexpectedBoost"/,
      );
    } finally {
      database.close();
    }
  });
});
