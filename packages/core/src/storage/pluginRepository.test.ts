import { describe, expect, it } from 'vitest';

import { openInMemoryCommandCabinDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createPluginRepository } from './pluginRepository.js';

describe('SQLite plugin repository', () => {
  it('stores plugin metadata and enabled state', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);

      const plugin = repository.upsertPlugin({
        id: 'com.example.text-tools',
        name: 'Text Tools',
        version: '0.1.0',
        description: 'Common text transformations',
        main: 'dist/main.js',
        pluginRoot: 'C:\\CommandCabin\\plugins\\text-tools',
        ui: 'dist/index.html',
        permissions: ['clipboard.read', 'clipboard.write'],
      });

      expect(plugin).toMatchObject({
        id: 'com.example.text-tools',
        name: 'Text Tools',
        version: '0.1.0',
        description: 'Common text transformations',
        main: 'dist/main.js',
        pluginRoot: 'C:\\CommandCabin\\plugins\\text-tools',
        ui: 'dist/index.html',
        enabled: true,
        permissions: ['clipboard.read', 'clipboard.write'],
      });

      expect(repository.setPluginEnabled('com.example.text-tools', false)).toMatchObject({
        id: 'com.example.text-tools',
        enabled: false,
      });
      expect(repository.listPlugins()).toMatchObject([
        {
          id: 'com.example.text-tools',
          enabled: false,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('stores plugin data as JSON values and removes data with the plugin', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);

      repository.upsertPlugin({
        id: 'com.example.text-tools',
        name: 'Text Tools',
        version: '0.1.0',
        main: 'dist/main.js',
      });

      repository.setPluginData('com.example.text-tools', 'settings', {
        defaultCase: 'upper',
        maxItems: 5,
      });
      repository.setPluginData('com.example.text-tools', 'lastCommand', 'uppercase');

      expect(repository.getPluginData('com.example.text-tools', 'settings')).toEqual({
        defaultCase: 'upper',
        maxItems: 5,
      });
      expect(repository.listPluginData('com.example.text-tools')).toEqual({
        lastCommand: 'uppercase',
        settings: {
          defaultCase: 'upper',
          maxItems: 5,
        },
      });

      expect(repository.deletePluginData('com.example.text-tools', 'lastCommand')).toBe(true);
      expect(repository.getPluginData('com.example.text-tools', 'lastCommand')).toBeUndefined();

      expect(repository.removePlugin('com.example.text-tools')).toBe(true);
      expect(repository.getPluginData('com.example.text-tools', 'settings')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('throws contextual errors for malformed plugin permissions JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      database
        .prepare(
          `
            INSERT INTO plugins (
              id,
              name,
              version,
              main,
              permissions,
              installed_at,
              updated_at
            )
            VALUES (
              'com.example.text-tools',
              'Text Tools',
              '0.1.0',
              'dist/main.js',
              '{bad-json',
              '2026-05-15T10:00:00.000Z',
              '2026-05-15T10:00:00.000Z'
            )
          `,
        )
        .run();

      expect(() => createPluginRepository(database).getPlugin('com.example.text-tools')).toThrow(
        /Invalid JSON in plugins permissions for plugin "com.example.text-tools"/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects invalid input permissions before reading existing plugin permissions', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      database
        .prepare(
          `
            INSERT INTO plugins (
              id,
              name,
              version,
              main,
              permissions,
              installed_at,
              updated_at
            )
            VALUES (
              'com.example.text-tools',
              'Text Tools',
              '0.1.0',
              'dist/main.js',
              '{bad-json',
              '2026-05-15T10:00:00.000Z',
              '2026-05-15T10:00:00.000Z'
            )
          `,
        )
        .run();
      const repository = createPluginRepository(database);
      const permissions = [] as unknown[];
      permissions[1] = 'clipboard.read';

      expect(() =>
        repository.upsertPlugin({
          id: 'com.example.text-tools',
          name: 'Text Tools',
          version: '0.1.1',
          main: 'dist/main.js',
          permissions: permissions as never,
        }),
      ).toThrow(
        /Invalid plugin permissions in plugins permissions for plugin "com.example.text-tools": permissions\[0\] is missing/,
      );
      expect(
        database
          .prepare<
            [string],
            { permissions: string }
          >('SELECT permissions FROM plugins WHERE id = ?')
          .get('com.example.text-tools'),
      ).toEqual({ permissions: '{bad-json' });
    } finally {
      database.close();
    }
  });

  it('throws contextual errors for wrong-shape plugin permissions JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      database
        .prepare(
          `
            INSERT INTO plugins (
              id,
              name,
              version,
              main,
              permissions,
              installed_at,
              updated_at
            )
            VALUES (
              'com.example.text-tools',
              'Text Tools',
              '0.1.0',
              'dist/main.js',
              '["clipboard.read", 7]',
              '2026-05-15T10:00:00.000Z',
              '2026-05-15T10:00:00.000Z'
            )
          `,
        )
        .run();

      expect(() => createPluginRepository(database).getPlugin('com.example.text-tools')).toThrow(
        /Invalid plugin permissions in plugins permissions for plugin "com.example.text-tools": permissions\[1\] must be a string/,
      );
    } finally {
      database.close();
    }
  });

  it('throws contextual errors for invalid plugin dates', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);

      expect(() =>
        repository.upsertPlugin({
          id: 'com.example.text-tools',
          name: 'Text Tools',
          version: '0.1.0',
          main: 'dist/main.js',
          installedAt: 'not-a-date',
        }),
      ).toThrow(/Invalid date for plugin upsertPlugin installedAt/);
    } finally {
      database.close();
    }
  });

  it('throws contextual errors for malformed plugin data JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);

      repository.upsertPlugin({
        id: 'com.example.text-tools',
        name: 'Text Tools',
        version: '0.1.0',
        main: 'dist/main.js',
      });
      database
        .prepare(
          `
            INSERT INTO plugin_data (plugin_id, key, value, updated_at)
            VALUES (
              'com.example.text-tools',
              'settings',
              '{bad-json',
              '2026-05-15T10:00:00.000Z'
            )
            ON CONFLICT(plugin_id, key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at
          `,
        )
        .run();

      expect(() => repository.getPluginData('com.example.text-tools', 'settings')).toThrow(
        /Invalid JSON in plugin_data key "settings" for plugin "com.example.text-tools"/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects non-finite plugin data values before writing JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);

      repository.upsertPlugin({
        id: 'com.example.text-tools',
        name: 'Text Tools',
        version: '0.1.0',
        main: 'dist/main.js',
      });

      expect(() =>
        repository.setPluginData('com.example.text-tools', 'settings', {
          score: Number.NaN,
        }),
      ).toThrow(
        /Invalid JSON value in plugin_data key "settings" for plugin "com.example.text-tools" at settings\.score: number must be finite/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects cyclic plugin data values before writing JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);
      const cyclicValue: Record<string, unknown> = {};
      cyclicValue.self = cyclicValue;

      repository.upsertPlugin({
        id: 'com.example.text-tools',
        name: 'Text Tools',
        version: '0.1.0',
        main: 'dist/main.js',
      });

      expect(() =>
        repository.setPluginData('com.example.text-tools', 'settings', cyclicValue as never),
      ).toThrow(
        /Invalid JSON value in plugin_data key "settings" for plugin "com.example.text-tools" at settings\.self: circular reference/,
      );
    } finally {
      database.close();
    }
  });

  it('rejects symbol keys on plugin data arrays before writing JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);
      const data = ['ok'] as Array<string> & { [key: symbol]: string };
      data[Symbol('hidden')] = 'dirty';

      repository.upsertPlugin({
        id: 'com.example.text-tools',
        name: 'Text Tools',
        version: '0.1.0',
        main: 'dist/main.js',
      });

      expect(() => repository.setPluginData('com.example.text-tools', 'settings', data)).toThrow(
        /Invalid JSON value in plugin_data key "settings" for plugin "com.example.text-tools" at settings\[Symbol\(hidden\)\]: symbol keys are not JSON-serializable/,
      );
      expect(repository.getPluginData('com.example.text-tools', 'settings')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects sparse plugin data arrays before writing JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);
      const data = [] as unknown[];
      data[1] = 'clipboard.read';

      repository.upsertPlugin({
        id: 'com.example.text-tools',
        name: 'Text Tools',
        version: '0.1.0',
        main: 'dist/main.js',
      });

      expect(() => repository.setPluginData('com.example.text-tools', 'settings', data)).toThrow(
        /Invalid JSON value in plugin_data key "settings" for plugin "com.example.text-tools" at settings\[0\]: arrays cannot contain holes/,
      );
      expect(repository.getPluginData('com.example.text-tools', 'settings')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects plugin data arrays with extra string keys before writing JSON', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);
      const data = ['ok'] as Array<string> & { extra: string };
      data.extra = 'dirty';

      repository.upsertPlugin({
        id: 'com.example.text-tools',
        name: 'Text Tools',
        version: '0.1.0',
        main: 'dist/main.js',
      });

      expect(() => repository.setPluginData('com.example.text-tools', 'settings', data)).toThrow(
        /Invalid JSON value in plugin_data key "settings" for plugin "com.example.text-tools" at settings\.extra: arrays cannot contain non-index properties/,
      );
      expect(repository.getPluginData('com.example.text-tools', 'settings')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects sparse plugin permissions before writing plugin rows', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);
      const permissions = [] as unknown[];
      permissions[1] = 'clipboard.read';

      expect(() =>
        repository.upsertPlugin({
          id: 'com.example.text-tools',
          name: 'Text Tools',
          version: '0.1.0',
          main: 'dist/main.js',
          permissions: permissions as never,
        }),
      ).toThrow(
        /Invalid plugin permissions in plugins permissions for plugin "com.example.text-tools": permissions\[0\] is missing/,
      );
      expect(repository.getPlugin('com.example.text-tools')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects non-array plugin permissions before writing plugin rows', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);

      expect(() =>
        repository.upsertPlugin({
          id: 'com.example.text-tools',
          name: 'Text Tools',
          version: '0.1.0',
          main: 'dist/main.js',
          permissions: new Set(['clipboard.read']) as never,
        }),
      ).toThrow(
        /Invalid plugin permissions in plugins permissions for plugin "com.example.text-tools": permissions must be an array/,
      );
      expect(repository.getPlugin('com.example.text-tools')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects string plugin permissions before writing plugin rows', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);

      expect(() =>
        repository.upsertPlugin({
          id: 'com.example.text-tools',
          name: 'Text Tools',
          version: '0.1.0',
          main: 'dist/main.js',
          permissions: 'clipboard.read' as never,
        }),
      ).toThrow(
        /Invalid plugin permissions in plugins permissions for plugin "com.example.text-tools": permissions must be an array/,
      );
      expect(repository.getPlugin('com.example.text-tools')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects non-string plugin permission items before writing plugin rows', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);

      expect(() =>
        repository.upsertPlugin({
          id: 'com.example.text-tools',
          name: 'Text Tools',
          version: '0.1.0',
          main: 'dist/main.js',
          permissions: ['ok', 7] as never,
        }),
      ).toThrow(
        /Invalid plugin permissions in plugins permissions for plugin "com.example.text-tools": permissions\[1\] must be a string/,
      );
      expect(repository.getPlugin('com.example.text-tools')).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
