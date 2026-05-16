import { describe, expect, it } from 'vitest';

import { openInMemoryCommandCabinDatabase, runMigrations } from '@command-cabin/core';
import {
  CLIPBOARD_HISTORY_MAX_TEXT_LENGTH,
  createClipboardHistoryCommands,
  createClipboardHistoryRepository,
  createClipboardWatcher,
} from '@command-cabin/built-in-plugin-clipboard-history';
import { createLauncherCommandService } from '../../apps/desktop/src/main/launcher/launcherCommandService.js';
import { createClipboardHistoryClearGate } from '../../apps/desktop/src/renderer/src/settings/ClipboardHistorySettings.js';

describe('clipboard history built-in plugin', () => {
  it('watches text clipboard changes and ignores empty or consecutive duplicate values', async () => {
    const values = ['  ', 'Alpha', 'Alpha', 'Beta'];
    const observed: string[] = [];
    const watcher = createClipboardWatcher({
      onText: (text) => {
        observed.push(text);
      },
      readText: () => values.shift() ?? 'Beta',
    });

    await watcher.poll();
    await watcher.poll();
    await watcher.poll();
    await watcher.poll();

    expect(observed).toEqual(['Alpha', 'Beta']);
  });

  it('starts and stops polling with injected timers', () => {
    const clearedTimerIds: number[] = [];
    const watcher = createClipboardWatcher({
      onText: () => undefined,
      readText: () => '',
      setInterval: (callback, intervalMs) => {
        expect(intervalMs).toBe(750);
        callback();
        return 42;
      },
      clearInterval: (timerId) => {
        clearedTimerIds.push(timerId);
      },
      intervalMs: 750,
    });

    watcher.start();
    watcher.start();
    watcher.stop();
    watcher.stop();

    expect(clearedTimerIds).toEqual([42]);
  });

  it('does not overlap polls and reports read or save errors', async () => {
    let releaseRead: ((text: string) => void) | undefined;
    let readCount = 0;
    const errors: unknown[] = [];
    const savedText: string[] = [];
    const watcher = createClipboardWatcher({
      onError: (error) => {
        errors.push(error);
      },
      onText: (text) => {
        savedText.push(text);
        throw new Error('save failed');
      },
      readText: () => {
        readCount += 1;
        return new Promise<string>((resolve) => {
          releaseRead = resolve;
        });
      },
    });

    const firstPoll = watcher.poll();
    const secondPoll = watcher.poll();

    expect(readCount).toBe(1);
    releaseRead?.('Alpha');
    await Promise.all([firstPoll, secondPoll]);

    expect(savedText).toEqual(['Alpha']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it('waits for an in-flight poll when stopped', async () => {
    let releaseSave: (() => void) | undefined;
    const savedText: string[] = [];
    const watcher = createClipboardWatcher({
      onText: (text) =>
        new Promise<void>((resolve) => {
          savedText.push(text);
          releaseSave = resolve;
        }),
      readText: () => 'Alpha',
    });

    const poll = watcher.poll();
    const stop = watcher.stop();
    await Promise.resolve();

    expect(savedText).toEqual(['Alpha']);
    let stopped = false;
    stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseSave?.();
    await poll;
    await stop;

    expect(stopped).toBe(true);
  });

  it('stores the 200 most recent text entries, dedupes by text, and supports search and clear', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createClipboardHistoryRepository(database);

      repository.saveText('Alpha', { copiedAt: '2026-05-15T10:00:00.000Z' });
      repository.saveText('Beta command', { copiedAt: '2026-05-15T10:01:00.000Z' });
      repository.saveText('Alpha', { copiedAt: '2026-05-15T10:02:00.000Z' });

      for (let index = 0; index < 205; index += 1) {
        repository.saveText(`Entry ${index}`, {
          copiedAt: new Date(Date.UTC(2026, 4, 15, 11, index)).toISOString(),
        });
      }

      const recent = repository.listRecent(250);

      expect(recent).toHaveLength(200);
      expect(recent[0]).toMatchObject({ text: 'Entry 204' });
      expect(recent.some((entry) => entry.text === 'Beta command')).toBe(false);
      expect(repository.search('entry 20').map((entry) => entry.text)).toContain('Entry 204');

      repository.clear();

      expect(repository.listRecent()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('caps very large clipboard text before persistence and command indexing', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createClipboardHistoryRepository(database);
      const entry = repository.saveText('x'.repeat(CLIPBOARD_HISTORY_MAX_TEXT_LENGTH + 500));

      expect(entry?.text).toHaveLength(CLIPBOARD_HISTORY_MAX_TEXT_LENGTH);

      const [command] = createClipboardHistoryCommands(repository.listRecent());

      expect(command?.action.payload.text).toHaveLength(CLIPBOARD_HISTORY_MAX_TEXT_LENGTH);
      expect(command?.keywords.join('')).not.toHaveLength(CLIPBOARD_HISTORY_MAX_TEXT_LENGTH);
      expect(command?.subtitle?.length).toBeLessThanOrEqual(96);
    } finally {
      database.close();
    }
  });

  it('rejects corrupt clipboard history rows with contextual errors', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      database
        .prepare('INSERT INTO clipboard_history (text, copied_at) VALUES (?, ?)')
        .run('', 'not-a-date');
      const repository = createClipboardHistoryRepository(database);

      expect(() => repository.listRecent()).toThrow(/Invalid clipboard history row/);
    } finally {
      database.close();
    }
  });

  it('creates searchable copy-text commands with bounded previews', () => {
    const [command] = createClipboardHistoryCommands([
      {
        id: 7,
        text: `Long clipboard value ${'x'.repeat(160)}`,
        copiedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    expect(command).toMatchObject({
      action: {
        payload: {
          text: expect.stringContaining('Long clipboard value') as string,
        },
        type: 'copy-text',
      },
      id: 'clipboard-history.entry.7',
      keywords: expect.arrayContaining(['clip', 'clipboard']) as string[],
      pluginId: 'clipboard-history',
      source: 'plugin',
      title: 'Clipboard History',
    });
    expect(command!.subtitle!.length).toBeLessThanOrEqual(96);
  });

  it('surfaces clipboard history through launcher search and copies selected history text', async () => {
    const database = openInMemoryCommandCabinDatabase();
    const copiedText: string[] = [];

    try {
      runMigrations(database);
      const clipboardHistoryRepository = createClipboardHistoryRepository(database);
      clipboardHistoryRepository.saveText('Release notes draft', {
        copiedAt: '2026-05-15T10:00:00.000Z',
      });
      const service = createLauncherCommandService({
        clipboardHistoryRepository,
        commands: [],
        writeClipboardText: (text) => {
          copiedText.push(text);
        },
      });

      const [result] = service.searchCommands('clip');

      expect(result).toMatchObject({
        id: expect.stringMatching(/^clipboard-history\.entry\./) as string,
        source: 'plugin',
        title: 'Clipboard History',
      });

      await expect(service.executeCommand(result!.id)).resolves.toMatchObject({
        commandId: result!.id,
        metadata: {
          copied: true,
          text: 'Release notes draft',
        },
        status: 'success',
      });
      expect(copiedText).toEqual(['Release notes draft']);
    } finally {
      database.close();
    }
  });

  it('exposes a clear-history service API and settings control gate', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const clipboardHistoryRepository = createClipboardHistoryRepository(database);
      clipboardHistoryRepository.saveText('Temporary secret');
      const service = createLauncherCommandService({
        clipboardHistoryRepository,
        commands: [],
      });
      const gate = createClipboardHistoryClearGate();

      expect(gate.tryStart()).toBe(true);
      expect(gate.tryStart()).toBe(false);
      expect(service.clearClipboardHistory()).toBe(1);
      gate.finish();

      expect(gate.tryStart()).toBe(true);
      expect(service.searchCommands('clip')).toEqual([]);
    } finally {
      database.close();
    }
  });
});
