import type { CommandCabinDatabase } from '@command-cabin/core';

const DEFAULT_CLIPBOARD_HISTORY_LIMIT = 20;
const MAX_CLIPBOARD_HISTORY_LIMIT = 200;
export const CLIPBOARD_HISTORY_MAX_TEXT_LENGTH = 20_000;

export interface ClipboardHistoryEntry {
  id: number;
  text: string;
  copiedAt: string;
}

export interface SaveClipboardTextOptions {
  copiedAt?: Date | string;
}

export interface ClipboardHistoryRepository {
  saveText: (text: string, options?: SaveClipboardTextOptions) => ClipboardHistoryEntry | undefined;
  listRecent: (limit?: number) => ClipboardHistoryEntry[];
  search: (query: string, limit?: number) => ClipboardHistoryEntry[];
  clear: () => number;
}

interface ClipboardHistoryRow {
  id: number;
  text: string;
  copied_at: string;
}

function mapClipboardHistoryRow(row: ClipboardHistoryRow): ClipboardHistoryEntry {
  validateClipboardHistoryRow(row);

  return {
    id: row.id,
    text: row.text,
    copiedAt: row.copied_at,
  };
}

function normalizeClipboardText(text: string): string {
  return text.trim().slice(0, CLIPBOARD_HISTORY_MAX_TEXT_LENGTH);
}

function normalizeDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid clipboard history copiedAt date: ${String(value)}`);
  }

  return date.toISOString();
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('Clipboard history limit must be a safe integer >= 0');
  }

  return Math.min(limit, MAX_CLIPBOARD_HISTORY_LIMIT);
}

function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function validateClipboardHistoryRow(row: ClipboardHistoryRow): void {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) {
    throw new Error(`Invalid clipboard history row ${row.id}: id must be a positive integer`);
  }

  if (typeof row.text !== 'string' || row.text.length === 0) {
    throw new Error(`Invalid clipboard history row ${row.id}: text must be a non-empty string`);
  }

  if (row.text.length > CLIPBOARD_HISTORY_MAX_TEXT_LENGTH) {
    throw new Error(`Invalid clipboard history row ${row.id}: text exceeds maximum length`);
  }

  const copiedAt = new Date(row.copied_at);

  if (!Number.isFinite(copiedAt.getTime())) {
    throw new Error(`Invalid clipboard history row ${row.id}: copied_at must be a valid date`);
  }
}

export function createClipboardHistoryRepository(
  database: CommandCabinDatabase,
): ClipboardHistoryRepository {
  const selectByText = database.prepare<[string], ClipboardHistoryRow>(
    `
      SELECT id, text, copied_at
      FROM clipboard_history
      WHERE text = ?
    `,
  );
  const selectRecent = database.prepare<[number], ClipboardHistoryRow>(
    `
      SELECT id, text, copied_at
      FROM clipboard_history
      ORDER BY copied_at DESC, id DESC
      LIMIT ?
    `,
  );
  const searchRecent = database.prepare<{ pattern: string; limit: number }, ClipboardHistoryRow>(
    `
      SELECT id, text, copied_at
      FROM clipboard_history
      WHERE text LIKE @pattern ESCAPE '\\'
      ORDER BY copied_at DESC, id DESC
      LIMIT @limit
    `,
  );
  const upsertText = database.prepare<{ text: string; copiedAt: string }>(
    `
      INSERT INTO clipboard_history (text, copied_at)
      VALUES (@text, @copiedAt)
      ON CONFLICT(text) DO UPDATE SET
        copied_at = excluded.copied_at
    `,
  );
  const pruneOldRows = database.prepare<[number]>(
    `
      DELETE FROM clipboard_history
      WHERE id NOT IN (
        SELECT id
        FROM clipboard_history
        ORDER BY copied_at DESC, id DESC
        LIMIT ?
      )
    `,
  );
  const clearHistory = database.prepare('DELETE FROM clipboard_history');

  const saveTransaction = database.transaction((text: string, copiedAt: string) => {
    upsertText.run({ text, copiedAt });
    pruneOldRows.run(MAX_CLIPBOARD_HISTORY_LIMIT);
  });

  return {
    saveText: (inputText, options = {}) => {
      const text = normalizeClipboardText(inputText);

      if (text.length === 0) {
        return undefined;
      }

      saveTransaction(text, normalizeDate(options.copiedAt ?? new Date()));

      const row = selectByText.get(text);

      if (!row) {
        throw new Error('Clipboard history entry was not saved.');
      }

      return mapClipboardHistoryRow(row);
    },
    listRecent: (limit = DEFAULT_CLIPBOARD_HISTORY_LIMIT) =>
      selectRecent.all(normalizeLimit(limit)).map(mapClipboardHistoryRow),
    search: (query, limit = DEFAULT_CLIPBOARD_HISTORY_LIMIT) => {
      const normalizedQuery = normalizeClipboardText(query);

      if (normalizedQuery.length === 0) {
        return selectRecent.all(normalizeLimit(limit)).map(mapClipboardHistoryRow);
      }

      return searchRecent
        .all({
          limit: normalizeLimit(limit),
          pattern: `%${escapeLikePattern(normalizedQuery)}%`,
        })
        .map(mapClipboardHistoryRow);
    },
    clear: () => clearHistory.run().changes,
  };
}
