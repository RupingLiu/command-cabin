import { createHash } from 'node:crypto';

import type { FavoriteRecord } from '../indexer/favoritesRepository.js';
import { normalizeSearchKeywords } from '../search/tokenize.js';
import { cloneCommand } from './commandJson.js';
import type { Command } from './types.js';

export const LAUNCHER_PINNED_APP_METADATA_KEY = 'launcherPinnedApp';
export const LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY = 'launcherPinnedAppExecutablePath';
export const LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY = 'launcherPinnedAppIconPath';

export function createFavoriteCommandId(favoriteId: string): string {
  const digest = createHash('sha256').update(favoriteId).digest('hex').slice(0, 12);

  return `favorite.${digest}`;
}

function createFavoriteKeywords(favorite: FavoriteRecord): string[] {
  return normalizeSearchKeywords([favorite.title, ...favorite.keywords, favorite.kind]);
}

function getFavoriteMetadataString(favorite: FavoriteRecord, key: string): string | undefined {
  const value = favorite.metadata[key];

  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function isLauncherPinnedAppFavorite(favorite: FavoriteRecord): boolean {
  return favorite.kind === 'file' && favorite.metadata[LAUNCHER_PINNED_APP_METADATA_KEY] === true;
}

export function createFavoriteCommand(favorite: FavoriteRecord): Command {
  const commandBase = {
    id: createFavoriteCommandId(favorite.id),
    title: favorite.title,
    subtitle: favorite.kind === 'url' ? favorite.url : favorite.path,
    keywords: createFavoriteKeywords(favorite),
  };

  if (isLauncherPinnedAppFavorite(favorite)) {
    const appPath = favorite.path;

    if (appPath === undefined) {
      throw new Error('Pinned app favorite path is missing.');
    }

    const executablePath =
      getFavoriteMetadataString(favorite, LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY) ??
      appPath;
    const iconPath =
      getFavoriteMetadataString(favorite, LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY) ??
      executablePath;

    return {
      ...commandBase,
      source: 'app',
      subtitle: executablePath,
      icon: iconPath,
      action: {
        type: 'open-app',
        payload: {
          executablePath,
          favoriteId: favorite.id,
          shortcutPath: appPath,
        },
      },
    };
  }

  if (favorite.kind === 'url') {
    return {
      ...commandBase,
      source: 'url',
      action: {
        type: 'open-url',
        payload: {
          favoriteId: favorite.id,
          url: favorite.url,
        },
      },
    };
  }

  return {
    ...commandBase,
    source: 'file',
    action: {
      type: 'open-path',
      payload: {
        favoriteId: favorite.id,
        favoriteKind: favorite.kind,
        path: favorite.path,
      },
    },
  };
}

export function createFavoriteCommands(favorites: readonly FavoriteRecord[]): Command[] {
  const commandsById = new Map<string, Command>();

  for (const favorite of favorites) {
    const command = createFavoriteCommand(favorite);

    if (!commandsById.has(command.id)) {
      commandsById.set(command.id, command);
    }
  }

  return Array.from(commandsById.values(), cloneCommand);
}
