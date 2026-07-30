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

  it('preserves original clipboard whitespace while ignoring whitespace-only text', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createClipboardHistoryRepository(database);
      const originalText = '  copied value\r\nwith trailing whitespace  \n';

      expect(repository.saveText(' \r\n\t ')).toBeUndefined();
      expect(repository.saveText(originalText)?.text).toBe(originalText);
      expect(repository.listRecent()).toEqual([
        expect.objectContaining({
          text: originalText,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it('updates one normalized duplicate with the latest original text', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createClipboardHistoryRepository(database);
      const first = repository.saveText('duplicate', {
        copiedAt: '2026-07-29T00:00:00.000Z',
      });
      const latestText = '\tduplicate \r\n';
      const latest = repository.saveText(latestText, {
        copiedAt: '2026-07-30T00:00:00.000Z',
      });

      expect(latest?.id).toBe(first?.id);
      expect(latest?.text).toBe(latestText);
      expect(repository.listRecent()).toEqual([
        expect.objectContaining({
          id: first?.id,
          text: latestText,
          copiedAt: '2026-07-30T00:00:00.000Z',
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it('passes original text to the watcher callback and deduplicates by normalized text', async () => {
    const clipboardValues = ['  copied value \n', 'copied value', ' \r\n\t '];
    const copiedTexts: string[] = [];
    const watcher = createClipboardWatcher({
      onText: (text) => {
        copiedTexts.push(text);
      },
      readText: () => clipboardValues.shift() ?? '',
    });

    await watcher.poll();
    await watcher.poll();
    await watcher.poll();

    expect(copiedTexts).toEqual(['  copied value \n']);
  });

  it('retries the same clipboard text when persistence fails', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const watcher = createClipboardWatcher({
      onError: (error) => {
        errors.push(error);
      },
      onText: () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error('Temporary persistence failure');
        }
      },
      readText: () => 'retry this text',
    });

    await watcher.poll();
    await watcher.poll();
    await watcher.poll();

    expect(attempts).toBe(2);
    expect(errors).toEqual([expect.objectContaining({ message: 'Temporary persistence failure' })]);
  });
});
