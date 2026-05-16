import type { CommandCabinDatabase } from './database.js';

export interface StorageMigration {
  id: number;
  name: string;
  sql: string;
}

export interface MigrationResult {
  appliedMigrationIds: number[];
}

const STORAGE_MIGRATIONS: readonly StorageMigration[] = [
  {
    id: 1,
    name: '001_initial_storage',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS command_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        subtitle TEXT,
        source TEXT NOT NULL,
        execution_count INTEGER NOT NULL DEFAULT 1 CHECK (execution_count > 0),
        executed_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_command_history_executed_at
        ON command_history(executed_at DESC);

      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT,
        main TEXT NOT NULL,
        ui TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        permissions TEXT NOT NULL DEFAULT '[]',
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_plugins_name
        ON plugins(name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS plugin_data (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, key),
        FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
      );
    `,
  },
  {
    id: 2,
    name: '002_favorites',
    sql: `
      CREATE TABLE IF NOT EXISTS favorites (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'folder', 'url')),
        title TEXT NOT NULL,
        path TEXT,
        url TEXT,
        keywords TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (
            kind IN ('file', 'folder')
            AND path IS NOT NULL
            AND length(trim(path)) > 0
            AND url IS NULL
          )
          OR (
            kind = 'url'
            AND url IS NOT NULL
            AND length(trim(url)) > 0
            AND path IS NULL
          )
        )
      );

      CREATE INDEX IF NOT EXISTS idx_favorites_title
        ON favorites(title COLLATE NOCASE);
    `,
  },
  {
    id: 3,
    name: '003_clipboard_history',
    sql: `
      CREATE TABLE IF NOT EXISTS clipboard_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL UNIQUE,
        copied_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_clipboard_history_copied_at
        ON clipboard_history(copied_at DESC);
    `,
  },
  {
    id: 4,
    name: '004_plugin_root',
    sql: `
      ALTER TABLE plugins
        ADD COLUMN plugin_root TEXT;
    `,
  },
];

interface MigrationRow {
  id: number;
  name: string;
}

export function validateStorageMigrationDefinitions(migrations: readonly StorageMigration[]): void {
  const migrationIds = new Set<number>();
  const migrationNames = new Set<string>();
  let previousMigrationId = 0;

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.id) || migration.id <= 0) {
      throw new Error(
        `Invalid migration id ${migration.id}; migration IDs must be positive safe integers`,
      );
    }

    if (migrationIds.has(migration.id)) {
      throw new Error(`Invalid storage migrations: duplicate migration id ${migration.id}`);
    }

    if (migration.id <= previousMigrationId) {
      throw new Error(
        `Invalid storage migrations: migration IDs must be strictly increasing; ${migration.id} followed ${previousMigrationId}`,
      );
    }

    if (migrationNames.has(migration.name)) {
      throw new Error(`Invalid storage migrations: duplicate migration name "${migration.name}"`);
    }

    migrationIds.add(migration.id);
    migrationNames.add(migration.name);
    previousMigrationId = migration.id;
  }
}

function verifyAppliedMigrations(
  appliedMigrations: readonly MigrationRow[],
  migrations: readonly StorageMigration[],
): void {
  const definitionsById = new Map(migrations.map((migration) => [migration.id, migration]));
  const definitionsByName = new Map(migrations.map((migration) => [migration.name, migration]));
  const appliedIds = new Set<number>();
  const appliedNames = new Set<string>();
  let previousAppliedMigrationId = 0;

  for (const appliedMigration of appliedMigrations) {
    if (!Number.isSafeInteger(appliedMigration.id) || appliedMigration.id <= 0) {
      throw new Error(
        `Invalid applied storage migration id ${appliedMigration.id}; applied migration IDs must be positive safe integers`,
      );
    }

    if (appliedIds.has(appliedMigration.id)) {
      throw new Error(
        `Invalid applied storage migrations: duplicate applied migration id ${appliedMigration.id}`,
      );
    }

    if (appliedNames.has(appliedMigration.name)) {
      throw new Error(
        `Invalid applied storage migrations: duplicate applied migration name "${appliedMigration.name}"`,
      );
    }

    if (appliedMigration.id <= previousAppliedMigrationId) {
      throw new Error(
        `Invalid applied storage migrations: applied migration IDs must be strictly increasing; ${appliedMigration.id} followed ${previousAppliedMigrationId}`,
      );
    }

    appliedIds.add(appliedMigration.id);
    appliedNames.add(appliedMigration.name);
    previousAppliedMigrationId = appliedMigration.id;

    const migrationById = definitionsById.get(appliedMigration.id);

    if (migrationById && migrationById.name !== appliedMigration.name) {
      throw new Error(
        `Storage migration id ${appliedMigration.id} was applied as "${appliedMigration.name}" but current definition is "${migrationById.name}"`,
      );
    }

    const migrationByName = definitionsByName.get(appliedMigration.name);

    if (migrationByName && migrationByName.id !== appliedMigration.id) {
      throw new Error(
        `Storage migration name "${appliedMigration.name}" was applied with id ${appliedMigration.id} but current definition uses id ${migrationByName.id}`,
      );
    }
  }

  for (const appliedMigration of appliedMigrations) {
    if (
      !definitionsById.has(appliedMigration.id) &&
      !definitionsByName.has(appliedMigration.name)
    ) {
      throw new Error(
        `Invalid applied storage migrations: unknown applied migration id ${appliedMigration.id} with name "${appliedMigration.name}"`,
      );
    }
  }
}

export function runMigrations(database: CommandCabinDatabase): MigrationResult {
  validateStorageMigrationDefinitions(STORAGE_MIGRATIONS);

  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedMigrationRows = database
    .prepare<[], MigrationRow>('SELECT id, name FROM migrations ORDER BY rowid')
    .all();

  verifyAppliedMigrations(appliedMigrationRows, STORAGE_MIGRATIONS);

  const appliedMigrationIds = new Set(appliedMigrationRows.map((row) => row.id));
  const newlyAppliedMigrationIds: number[] = [];

  const applyMigration = database.transaction((migration: StorageMigration) => {
    database.exec(migration.sql);
    database
      .prepare<{ id: number; name: string; appliedAt: string }>(
        `
          INSERT INTO migrations (id, name, applied_at)
          VALUES (@id, @name, @appliedAt)
        `,
      )
      .run({
        id: migration.id,
        name: migration.name,
        appliedAt: new Date().toISOString(),
      });
  });

  for (const migration of STORAGE_MIGRATIONS) {
    if (!appliedMigrationIds.has(migration.id)) {
      applyMigration(migration);
      newlyAppliedMigrationIds.push(migration.id);
    }
  }

  return {
    appliedMigrationIds: newlyAppliedMigrationIds,
  };
}
