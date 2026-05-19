import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { cloneCommand } from '../command/commandJson.js';
import type { Command, CommandActionType, CommandPayload } from '../command/types.js';
import {
  isStorageJsonObject,
  parseStorageJson,
  stringifyStorageJson,
  type StorageJsonValue,
} from '../storage/database.js';

const APP_INDEX_CACHE_VERSION = 2;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APP_INDEX_COMMAND_ACTION_TYPES = new Set<CommandActionType>(['open-app', 'open-path']);

export interface AppIndexCacheSnapshot {
  version: typeof APP_INDEX_CACHE_VERSION;
  scannedAt: string;
  commands: Command[];
}

export interface AppIndexCache {
  read: () => Promise<AppIndexCacheSnapshot | undefined>;
  write: (commands: readonly Command[]) => Promise<AppIndexCacheSnapshot>;
  isStale: (snapshot: AppIndexCacheSnapshot) => boolean;
}

export interface IndexCacheFileSystem {
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, contents: string) => Promise<void>;
  makeDirectory: (directoryPath: string) => Promise<void>;
}

export interface IndexCacheOptions {
  cacheFilePath: string;
  maxAgeMs?: number;
  now?: () => Date;
  fileSystem?: IndexCacheFileSystem;
}

interface NodeFileSystemError {
  code?: string;
}

function createDefaultIndexCacheFileSystem(): IndexCacheFileSystem {
  return {
    readFile: async (filePath) => readFile(filePath, 'utf8'),
    writeFile: async (filePath, contents) => {
      await writeFile(filePath, contents, 'utf8');
    },
    makeDirectory: async (directoryPath) => {
      await mkdir(directoryPath, { recursive: true });
    },
  };
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeFileSystemError).code === 'ENOENT'
  );
}

function cloneCommands(commands: readonly Command[]): Command[] {
  return commands.map(cloneCommand);
}

function throwInvalidCache(filePath: string, reason: string): never {
  throw new Error(`Invalid app index cache at "${filePath}": ${reason}`);
}

function validateString(value: unknown, filePath: string, path: string): string {
  if (typeof value !== 'string') {
    throwInvalidCache(filePath, `${path} must be a string`);
  }

  return value;
}

function validateOptionalString(
  value: Record<string, unknown>,
  fieldName: 'subtitle' | 'icon' | 'pluginId',
  filePath: string,
  path: string,
): string | undefined {
  if (!(fieldName in value)) {
    return undefined;
  }

  return validateString(value[fieldName], filePath, `${path}.${fieldName}`);
}

function validateAppCommandSource(value: unknown, filePath: string, path: string): 'app' {
  if (value !== 'app') {
    throwInvalidCache(filePath, `${path} must be "app"`);
  }

  return 'app';
}

function validateCommandActionType(
  value: unknown,
  filePath: string,
  path: string,
): CommandActionType {
  if (
    typeof value !== 'string' ||
    !APP_INDEX_COMMAND_ACTION_TYPES.has(value as CommandActionType)
  ) {
    throwInvalidCache(
      filePath,
      `${path} must be one of: ${Array.from(APP_INDEX_COMMAND_ACTION_TYPES).join(', ')}`,
    );
  }

  return value as CommandActionType;
}

function validateKeywords(value: unknown, filePath: string, path: string): string[] {
  if (!Array.isArray(value)) {
    throwInvalidCache(filePath, `${path} must be an array`);
  }

  return value.map((keyword, index) => validateString(keyword, filePath, `${path}[${index}]`));
}

function validateActionPayload(value: unknown, filePath: string, path: string): CommandPayload {
  if (!isStorageJsonObject(value)) {
    throwInvalidCache(filePath, `${path} must be a JSON object`);
  }

  return value as CommandPayload;
}

function validateCachedCommand(value: unknown, filePath: string, index: number): Command {
  const path = `commands[${index}]`;

  if (!isStorageJsonObject(value)) {
    throwInvalidCache(filePath, `${path} must be an object`);
  }

  const action = value.action;

  if (!isStorageJsonObject(action)) {
    throwInvalidCache(filePath, `${path}.action must be an object`);
  }

  const command: Command = {
    id: validateString(value.id, filePath, `${path}.id`),
    source: validateAppCommandSource(value.source, filePath, `${path}.source`),
    title: validateString(value.title, filePath, `${path}.title`),
    keywords: validateKeywords(value.keywords, filePath, `${path}.keywords`),
    action: {
      type: validateCommandActionType(action.type, filePath, `${path}.action.type`),
      payload: validateActionPayload(action.payload, filePath, `${path}.action.payload`),
    },
  };
  const subtitle = validateOptionalString(value, 'subtitle', filePath, path);
  const icon = validateOptionalString(value, 'icon', filePath, path);
  const pluginId = validateOptionalString(value, 'pluginId', filePath, path);

  if (subtitle !== undefined) {
    command.subtitle = subtitle;
  }
  if (icon !== undefined) {
    command.icon = icon;
  }
  if (pluginId !== undefined) {
    command.pluginId = pluginId;
  }

  return cloneCommand(command);
}

function validateCachedCommands(value: unknown[], filePath: string): Command[] {
  return value.map((command, index) => validateCachedCommand(command, filePath, index));
}

function validateSnapshot(value: StorageJsonValue, filePath: string): AppIndexCacheSnapshot {
  if (!isStorageJsonObject(value)) {
    throwInvalidCache(filePath, 'snapshot must be an object');
  }

  if (value.version !== APP_INDEX_CACHE_VERSION) {
    throwInvalidCache(filePath, `version must be ${APP_INDEX_CACHE_VERSION}`);
  }

  if (
    typeof value.scannedAt !== 'string' ||
    !Number.isFinite(new Date(value.scannedAt).getTime())
  ) {
    throwInvalidCache(filePath, 'scannedAt must be a valid ISO date string');
  }

  if (!Array.isArray(value.commands)) {
    throwInvalidCache(filePath, 'commands must be an array');
  }

  return {
    version: APP_INDEX_CACHE_VERSION,
    scannedAt: value.scannedAt,
    commands: validateCachedCommands(value.commands, filePath),
  };
}

export function createIndexCache(options: IndexCacheOptions): AppIndexCache {
  const fileSystem = options.fileSystem ?? createDefaultIndexCacheFileSystem();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? (() => new Date());
  const context = {
    table: 'app index cache',
    key: options.cacheFilePath,
  };

  return {
    read: async () => {
      let contents: string;

      try {
        contents = await fileSystem.readFile(options.cacheFilePath);
      } catch (error) {
        if (isFileNotFoundError(error)) {
          return undefined;
        }

        throw error;
      }

      return validateSnapshot(
        parseStorageJson<StorageJsonValue>(contents, context),
        options.cacheFilePath,
      );
    },
    write: async (commands) => {
      const snapshot: AppIndexCacheSnapshot = {
        version: APP_INDEX_CACHE_VERSION,
        scannedAt: now().toISOString(),
        commands: cloneCommands(commands),
      };

      await fileSystem.makeDirectory(dirname(options.cacheFilePath));
      await fileSystem.writeFile(options.cacheFilePath, stringifyStorageJson(snapshot, context));

      return {
        ...snapshot,
        commands: cloneCommands(snapshot.commands),
      };
    },
    isStale: (snapshot) => {
      const scannedAtTime = new Date(snapshot.scannedAt).getTime();

      if (!Number.isFinite(scannedAtTime)) {
        return true;
      }

      return now().getTime() - scannedAtTime > maxAgeMs;
    },
  };
}
