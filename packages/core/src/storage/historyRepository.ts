import {
  type CommandCabinDatabase,
  type StorageJsonObject,
  type StorageJsonValue,
  formatStorageValueContext,
  isStorageJsonObject,
  normalizeStorageDate,
  parseStorageJson,
  stringifyStorageJson,
} from './database.js';

const DEFAULT_RECENT_HISTORY_LIMIT = 20;
const MAX_RECENT_HISTORY_LIMIT = 100;

export interface RecordCommandExecutionInput {
  commandId: string;
  title: string;
  source: string;
  subtitle?: string;
  executedAt?: Date | string;
  metadata?: StorageJsonObject;
}

export interface CommandHistoryEntry {
  id: number;
  commandId: string;
  title: string;
  source: string;
  executionCount: number;
  executedAt: string;
  metadata: StorageJsonObject;
  subtitle?: string;
}

interface CommandHistoryRow {
  id: number;
  command_id: string;
  title: string;
  subtitle: string | null;
  source: string;
  execution_count: number;
  executed_at: string;
  metadata: string;
}

function mapCommandHistoryRow(row: CommandHistoryRow): CommandHistoryEntry {
  const metadataContext = {
    table: 'command_history',
    field: 'metadata',
    commandId: row.command_id,
  };
  const metadata = parseStorageJson<StorageJsonValue>(row.metadata, metadataContext);

  if (!isStorageJsonObject(metadata)) {
    throw new Error(
      `Invalid command history metadata in ${formatStorageValueContext(metadataContext)}: metadata must be an object`,
    );
  }

  const entry = {
    id: row.id,
    commandId: row.command_id,
    title: row.title,
    source: row.source,
    executionCount: row.execution_count,
    executedAt: row.executed_at,
    metadata,
  };

  return row.subtitle === null
    ? entry
    : {
        ...entry,
        subtitle: row.subtitle,
      };
}

function normalizeRecentHistoryLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('Command history listRecent limit must be a safe integer >= 0');
  }

  return Math.min(limit, MAX_RECENT_HISTORY_LIMIT);
}

function validateCommandHistoryMetadata(
  metadata: StorageJsonValue,
  commandId: string,
): StorageJsonObject {
  if (!isStorageJsonObject(metadata)) {
    throw new Error(
      `Invalid command history metadata in ${formatStorageValueContext({
        table: 'command_history',
        field: 'metadata',
        commandId,
      })}: metadata must be an object`,
    );
  }

  return metadata;
}

export interface HistoryRepository {
  recordExecution: (input: RecordCommandExecutionInput) => CommandHistoryEntry;
  getByCommandId: (commandId: string) => CommandHistoryEntry | undefined;
  listRecent: (limit?: number) => CommandHistoryEntry[];
  clear: () => void;
}

export function createHistoryRepository(database: CommandCabinDatabase): HistoryRepository {
  const selectByCommandId = database.prepare<[string], CommandHistoryRow>(
    `
      SELECT id, command_id, title, subtitle, source, execution_count, executed_at, metadata
      FROM command_history
      WHERE command_id = ?
    `,
  );
  const selectRecent = database.prepare<[number], CommandHistoryRow>(
    `
      SELECT id, command_id, title, subtitle, source, execution_count, executed_at, metadata
      FROM command_history
      ORDER BY executed_at DESC, id DESC
      LIMIT ?
    `,
  );
  const upsertExecution = database.prepare<{
    commandId: string;
    title: string;
    subtitle: string | null;
    source: string;
    executedAt: string;
    metadata: string;
  }>(
    `
      INSERT INTO command_history (
        command_id,
        title,
        subtitle,
        source,
        execution_count,
        executed_at,
        metadata
      )
      VALUES (
        @commandId,
        @title,
        @subtitle,
        @source,
        1,
        @executedAt,
        @metadata
      )
      ON CONFLICT(command_id) DO UPDATE SET
        title = excluded.title,
        subtitle = excluded.subtitle,
        source = excluded.source,
        execution_count = command_history.execution_count + 1,
        executed_at = excluded.executed_at,
        metadata = excluded.metadata
    `,
  );
  const clearHistory = database.prepare('DELETE FROM command_history');

  return {
    recordExecution: (input) => {
      const metadata = validateCommandHistoryMetadata(input.metadata ?? {}, input.commandId);

      upsertExecution.run({
        commandId: input.commandId,
        title: input.title,
        subtitle: input.subtitle ?? null,
        source: input.source,
        executedAt: normalizeStorageDate(input.executedAt ?? new Date(), {
          operation: 'command history recordExecution',
          field: 'executedAt',
        }),
        metadata: stringifyStorageJson(metadata, {
          table: 'command_history',
          field: 'metadata',
          commandId: input.commandId,
        }),
      });

      const row = selectByCommandId.get(input.commandId);

      if (!row) {
        throw new Error(`Command history entry was not saved: ${input.commandId}`);
      }

      return mapCommandHistoryRow(row);
    },
    getByCommandId: (commandId) => {
      const row = selectByCommandId.get(commandId);
      return row ? mapCommandHistoryRow(row) : undefined;
    },
    listRecent: (limit = DEFAULT_RECENT_HISTORY_LIMIT) =>
      selectRecent.all(normalizeRecentHistoryLimit(limit)).map(mapCommandHistoryRow),
    clear: () => {
      clearHistory.run();
    },
  };
}
