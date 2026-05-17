import { readdirSync, type Dirent } from 'node:fs';
import { win32 as path } from 'node:path';

import { createAppCommandsFromShortcuts, type Command } from '@command-cabin/core';

export interface DesktopShortcutCommandDirectoryEntry {
  isFile: () => boolean;
  name: string;
}

export interface ListDesktopShortcutCommandsOptions {
  directories: readonly string[];
  readDirectory?: (directory: string) => readonly DesktopShortcutCommandDirectoryEntry[];
}

function readDesktopDirectory(directory: string): Dirent[] {
  return readdirSync(directory, { withFileTypes: true });
}

function createDesktopShortcutTitle(shortcutPath: string): string {
  const title = path
    .basename(shortcutPath, path.extname(shortcutPath))
    .replace(/\s+-\s+快捷方式$/u, '')
    .trim();

  return title.length > 0 ? title : shortcutPath;
}

export function listDesktopShortcutCommands({
  directories,
  readDirectory = readDesktopDirectory,
}: ListDesktopShortcutCommandsOptions): Command[] {
  const shortcuts = [];

  for (const directory of directories) {
    let entries: readonly DesktopShortcutCommandDirectoryEntry[];

    try {
      entries = readDirectory(directory);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.lnk')) {
        continue;
      }

      const shortcutPath = path.join(directory, entry.name);

      shortcuts.push({
        name: createDesktopShortcutTitle(shortcutPath),
        opensApplication: true,
        shortcutPath,
      });
    }
  }

  return createAppCommandsFromShortcuts(shortcuts);
}
