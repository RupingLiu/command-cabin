import { describe, expect, it } from 'vitest';

import { openInMemoryCommandCabinDatabase, runMigrations } from '@command-cabin/core';

import { CLIPBOARD_HISTORY_MAX_TEXT_LENGTH, createClipboardHistoryCommands } from './index.js';
import { createClipboardHistoryRepository } from './clipboardRepository.js';
import { createClipboardWatcher } from './clipboardWatcher.js';

describe('clipboard history package', () => {
  it('runs real package-scoped tests for repository, command, and watcher behavior', async () => {
    const errors: unknown[] = [];
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createClipboardHistoryRepository(database);
      const watcher = createClipboardWatcher({
        onError: (error) => {
          errors.push(error);
        },
        onText: (text) => {
          repository.saveText(text);
        },
        readText: () => `${'A'.repeat(CLIPBOARD_HISTORY_MAX_TEXT_LENGTH + 1)}`,
      });

      await watcher.poll();

      const [entry] = repository.listRecent();
      const [command] = createClipboardHistoryCommands(repository.listRecent());

      expect(errors).toEqual([]);
      expect(entry?.text).toHaveLength(CLIPBOARD_HISTORY_MAX_TEXT_LENGTH);
      expect(command?.id).toMatch(/^clipboard-history\.entry\./);
      expect(command?.keywords.join('')).not.toHaveLength(CLIPBOARD_HISTORY_MAX_TEXT_LENGTH);
    } finally {
      database.close();
    }
  });
});
