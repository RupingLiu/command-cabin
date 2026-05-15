import {
  type CommandCabinDatabase,
  type StorageValueContext,
  type StorageJsonValue,
  formatStorageValueContext,
  normalizeStorageDate,
  parseStorageJson,
  stringifyStorageJson,
} from './database.js';

export interface UpsertPluginInput {
  id: string;
  name: string;
  version: string;
  main: string;
  description?: string;
  ui?: string;
  enabled?: boolean;
  permissions?: readonly string[];
  installedAt?: Date | string;
  updatedAt?: Date | string;
}

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  main: string;
  enabled: boolean;
  permissions: string[];
  installedAt: string;
  updatedAt: string;
  description?: string;
  ui?: string;
}

interface PluginRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  main: string;
  ui: string | null;
  enabled: 0 | 1;
  permissions: string;
  installed_at: string;
  updated_at: string;
}

interface PluginDataRow {
  key: string;
  value: string;
}

function isCanonicalArrayIndexProperty(propertyName: string, arrayLength: number): boolean {
  const index = Number(propertyName);

  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < arrayLength &&
    String(index) === propertyName
  );
}

function validatePluginPermissions(permissions: unknown, context: StorageValueContext): string[] {
  if (!Array.isArray(permissions)) {
    throw new Error(
      `Invalid plugin permissions in ${formatStorageValueContext(context)}: permissions must be an array`,
    );
  }

  for (const propertyName of Object.getOwnPropertyNames(permissions)) {
    if (propertyName === 'length') {
      continue;
    }

    if (!isCanonicalArrayIndexProperty(propertyName, permissions.length)) {
      throw new Error(
        `Invalid plugin permissions in ${formatStorageValueContext(context)}: permissions cannot contain non-index property "${propertyName}"`,
      );
    }
  }

  const permissionValues: string[] = [];

  for (let index = 0; index < permissions.length; index += 1) {
    if (!Object.hasOwn(permissions, index)) {
      throw new Error(
        `Invalid plugin permissions in ${formatStorageValueContext(context)}: permissions[${index}] is missing`,
      );
    }

    const permission = permissions[index];

    if (typeof permission !== 'string') {
      throw new Error(
        `Invalid plugin permissions in ${formatStorageValueContext(context)}: permissions[${index}] must be a string`,
      );
    }

    permissionValues.push(permission);
  }

  return permissionValues;
}

function mapPluginRow(row: PluginRow): PluginRecord {
  const permissionsContext = {
    table: 'plugins',
    field: 'permissions',
    pluginId: row.id,
  };
  const permissions = parseStorageJson<StorageJsonValue>(row.permissions, permissionsContext);
  const permissionValues = validatePluginPermissions(permissions, permissionsContext);

  const plugin = {
    id: row.id,
    name: row.name,
    version: row.version,
    main: row.main,
    enabled: row.enabled === 1,
    permissions: permissionValues,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };

  return {
    ...plugin,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.ui === null ? {} : { ui: row.ui }),
  };
}

export interface PluginRepository {
  upsertPlugin: (input: UpsertPluginInput) => PluginRecord;
  getPlugin: (id: string) => PluginRecord | undefined;
  listPlugins: () => PluginRecord[];
  setPluginEnabled: (id: string, enabled: boolean) => PluginRecord | undefined;
  removePlugin: (id: string) => boolean;
  setPluginData: (pluginId: string, key: string, value: StorageJsonValue) => void;
  getPluginData: <T extends StorageJsonValue = StorageJsonValue>(
    pluginId: string,
    key: string,
  ) => T | undefined;
  listPluginData: (pluginId: string) => Record<string, StorageJsonValue>;
  deletePluginData: (pluginId: string, key: string) => boolean;
}

export function createPluginRepository(database: CommandCabinDatabase): PluginRepository {
  const selectPlugin = database.prepare<[string], PluginRow>(
    `
      SELECT id, name, version, description, main, ui, enabled, permissions, installed_at, updated_at
      FROM plugins
      WHERE id = ?
    `,
  );
  const selectPlugins = database.prepare<[], PluginRow>(
    `
      SELECT id, name, version, description, main, ui, enabled, permissions, installed_at, updated_at
      FROM plugins
      ORDER BY name COLLATE NOCASE, id
    `,
  );
  const upsertPlugin = database.prepare<{
    id: string;
    name: string;
    version: string;
    description: string | null;
    main: string;
    ui: string | null;
    enabled: 0 | 1;
    permissions: string;
    installedAt: string;
    updatedAt: string;
  }>(
    `
      INSERT INTO plugins (
        id,
        name,
        version,
        description,
        main,
        ui,
        enabled,
        permissions,
        installed_at,
        updated_at
      )
      VALUES (
        @id,
        @name,
        @version,
        @description,
        @main,
        @ui,
        @enabled,
        @permissions,
        @installedAt,
        @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        version = excluded.version,
        description = excluded.description,
        main = excluded.main,
        ui = excluded.ui,
        enabled = excluded.enabled,
        permissions = excluded.permissions,
        updated_at = excluded.updated_at
    `,
  );
  const updateEnabled = database.prepare<{ id: string; enabled: 0 | 1; updatedAt: string }>(
    `
      UPDATE plugins
      SET enabled = @enabled,
          updated_at = @updatedAt
      WHERE id = @id
    `,
  );
  const deletePlugin = database.prepare<[string]>('DELETE FROM plugins WHERE id = ?');
  const upsertPluginData = database.prepare<{
    pluginId: string;
    key: string;
    value: string;
    updatedAt: string;
  }>(
    `
      INSERT INTO plugin_data (plugin_id, key, value, updated_at)
      VALUES (@pluginId, @key, @value, @updatedAt)
      ON CONFLICT(plugin_id, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
  );
  const selectPluginData = database.prepare<{ pluginId: string; key: string }, PluginDataRow>(
    `
      SELECT key, value
      FROM plugin_data
      WHERE plugin_id = @pluginId
        AND key = @key
    `,
  );
  const selectAllPluginData = database.prepare<[string], PluginDataRow>(
    `
      SELECT key, value
      FROM plugin_data
      WHERE plugin_id = ?
      ORDER BY key
    `,
  );
  const deletePluginData = database.prepare<{ pluginId: string; key: string }>(
    `
      DELETE FROM plugin_data
      WHERE plugin_id = @pluginId
        AND key = @key
    `,
  );

  function getPlugin(id: string): PluginRecord | undefined {
    const row = selectPlugin.get(id);
    return row ? mapPluginRow(row) : undefined;
  }

  function normalizePluginDate(value: Date | string, field: string): string {
    return normalizeStorageDate(value, {
      operation: 'plugin upsertPlugin',
      field,
    });
  }

  return {
    upsertPlugin: (input) => {
      const permissionsContext = {
        table: 'plugins',
        field: 'permissions',
        pluginId: input.id,
      };
      const permissionValues = validatePluginPermissions(
        input.permissions ?? [],
        permissionsContext,
      );
      const existingPlugin = getPlugin(input.id);
      const installedAt =
        input.installedAt === undefined
          ? (existingPlugin?.installedAt ?? normalizePluginDate(new Date(), 'installedAt'))
          : normalizePluginDate(input.installedAt, 'installedAt');
      const updatedAt = normalizePluginDate(input.updatedAt ?? new Date(), 'updatedAt');
      const enabled = input.enabled ?? existingPlugin?.enabled ?? true;

      upsertPlugin.run({
        id: input.id,
        name: input.name,
        version: input.version,
        description: input.description ?? null,
        main: input.main,
        ui: input.ui ?? null,
        enabled: enabled ? 1 : 0,
        permissions: stringifyStorageJson(permissionValues, permissionsContext),
        installedAt,
        updatedAt,
      });

      const plugin = getPlugin(input.id);

      if (!plugin) {
        throw new Error(`Plugin was not saved: ${input.id}`);
      }

      return plugin;
    },
    getPlugin,
    listPlugins: () => selectPlugins.all().map(mapPluginRow),
    setPluginEnabled: (id, enabled) => {
      const result = updateEnabled.run({
        id,
        enabled: enabled ? 1 : 0,
        updatedAt: new Date().toISOString(),
      });

      return result.changes === 0 ? undefined : getPlugin(id);
    },
    removePlugin: (id) => deletePlugin.run(id).changes > 0,
    setPluginData: (pluginId, key, value) => {
      upsertPluginData.run({
        pluginId,
        key,
        value: stringifyStorageJson(value, {
          table: 'plugin_data',
          key,
          pluginId,
        }),
        updatedAt: new Date().toISOString(),
      });
    },
    getPluginData: (pluginId, key) => {
      const row = selectPluginData.get({ pluginId, key });
      return row
        ? parseStorageJson(row.value, {
            table: 'plugin_data',
            key,
            pluginId,
          })
        : undefined;
    },
    listPluginData: (pluginId) => {
      const values: Record<string, StorageJsonValue> = {};

      for (const row of selectAllPluginData.all(pluginId)) {
        values[row.key] = parseStorageJson(row.value, {
          table: 'plugin_data',
          key: row.key,
          pluginId,
        });
      }

      return values;
    },
    deletePluginData: (pluginId, key) => deletePluginData.run({ pluginId, key }).changes > 0,
  };
}
