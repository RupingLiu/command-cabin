import type { Command } from '@command-cabin/core';

import {
  type ClipboardHistoryEntry,
  type ClipboardHistoryRepository,
} from './clipboardRepository.js';
import { createClipboardWatcher, type ClipboardWatcher } from './clipboardWatcher.js';

export {
  createClipboardHistoryRepository,
  CLIPBOARD_HISTORY_MAX_TEXT_LENGTH,
  type ClipboardHistoryEntry,
  type ClipboardHistoryRepository,
} from './clipboardRepository.js';
export { createClipboardWatcher, type ClipboardWatcher } from './clipboardWatcher.js';

export const CLIPBOARD_HISTORY_PLUGIN_ID = 'clipboard-history';
export const CLIPBOARD_HISTORY_COMMAND_PREFIX = 'clipboard-history.entry.';
const MAX_CLIPBOARD_PREVIEW_LENGTH = 93;

function truncatePreview(text: string): string {
  const singleLineText = text.replace(/\s+/g, ' ').trim();

  if (singleLineText.length <= MAX_CLIPBOARD_PREVIEW_LENGTH) {
    return singleLineText;
  }

  return `${singleLineText.slice(0, MAX_CLIPBOARD_PREVIEW_LENGTH - 1)}...`;
}

export function createClipboardHistoryCommandId(entryId: number): string {
  return `${CLIPBOARD_HISTORY_COMMAND_PREFIX}${entryId}`;
}

export function createClipboardHistoryCommands(
  entries: readonly ClipboardHistoryEntry[],
): Command[] {
  return entries.map((entry) => ({
    id: createClipboardHistoryCommandId(entry.id),
    source: 'plugin',
    title: 'Clipboard History',
    subtitle: truncatePreview(entry.text),
    keywords: ['clip', 'clipboard', 'history', truncatePreview(entry.text)],
    pluginId: CLIPBOARD_HISTORY_PLUGIN_ID,
    action: {
      type: 'copy-text',
      payload: {
        text: entry.text,
      },
    },
  }));
}

export function isClipboardHistoryCommandId(commandId: string): boolean {
  return commandId.startsWith(CLIPBOARD_HISTORY_COMMAND_PREFIX);
}

export interface ClipboardHistoryPluginRuntime {
  repository: ClipboardHistoryRepository;
  watcher: ClipboardWatcher;
}

export interface CreateClipboardHistoryPluginRuntimeOptions {
  onError?: (error: unknown) => void;
  onText?: (text: string) => void;
  readText: () => string | Promise<string>;
  repository: ClipboardHistoryRepository;
}

export function createClipboardHistoryPluginRuntime(
  options: CreateClipboardHistoryPluginRuntimeOptions,
): ClipboardHistoryPluginRuntime {
  const watcherOptions = {
    onText: (text: string) => {
      options.repository.saveText(text);
      options.onText?.(text);
    },
    readText: options.readText,
  };
  const watcher = createClipboardWatcher(
    options.onError === undefined
      ? watcherOptions
      : {
          ...watcherOptions,
          onError: options.onError,
        },
  );

  return {
    repository: options.repository,
    watcher,
  };
}
