import type {
  CommandCabinPluginContext,
  PluginClipboardCapability,
  PluginCommandHandler,
  PluginCommandRegistration,
  PluginJsonObject,
  PluginLogger,
  PluginLogLevel,
  PluginStorageCapability,
} from '@command-cabin/plugin-api';

import { validateStorageJsonValue } from '../storage/database.js';
import type { PluginManifest } from './pluginManifest.js';

export interface PluginLogEntry {
  timestamp: string;
  level: PluginLogLevel;
  message: string;
  pluginId?: string;
  error?: string;
  details?: PluginJsonObject;
}

export type PluginLogSink = (entry: PluginLogEntry) => void;

export interface PluginLogStore {
  log: (entry: Omit<PluginLogEntry, 'timestamp'>) => PluginLogEntry;
  list: (pluginId?: string) => PluginLogEntry[];
}

export interface PluginLifecycleClock {
  (): Date;
}

export interface CreatePluginLogStoreOptions {
  sink?: PluginLogSink;
  clock?: PluginLifecycleClock;
}

export interface CreatePluginContextOptions {
  manifest: PluginManifest;
  logger: PluginLogger;
  registerCommand: (command: PluginCommandRegistration, handler: PluginCommandHandler) => void;
  registerCommandHandler: (commandId: string, handler: PluginCommandHandler) => void;
  storage?: PluginStorageCapability;
  clipboard?: PluginClipboardCapability;
}

export interface PluginLifecycleHookSuccess {
  ok: true;
}

export interface PluginLifecycleHookFailure {
  ok: false;
  message: string;
}

export type PluginLifecycleHookResult = PluginLifecycleHookSuccess | PluginLifecycleHookFailure;

export function formatPluginThrownValue(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') {
      return error.message;
    }
  } catch {
    // Fall through to string coercion below.
  }

  try {
    return String(error);
  } catch {
    return '[unformattable thrown value]';
  }
}

function clonePluginLogDetails(
  details: PluginJsonObject | undefined,
): PluginJsonObject | undefined {
  if (details === undefined) {
    return undefined;
  }

  validateStorageJsonValue(details, {
    table: 'plugin log',
    field: 'details',
  });

  return JSON.parse(JSON.stringify(details)) as PluginJsonObject;
}

function clonePluginLogEntry(entry: PluginLogEntry): PluginLogEntry {
  const clonedEntry: PluginLogEntry = {
    timestamp: entry.timestamp,
    level: entry.level,
    message: entry.message,
  };
  const details = clonePluginLogDetails(entry.details);

  if (entry.pluginId !== undefined) {
    clonedEntry.pluginId = entry.pluginId;
  }

  if (entry.error !== undefined) {
    clonedEntry.error = entry.error;
  }

  if (details !== undefined) {
    clonedEntry.details = details;
  }

  return clonedEntry;
}

function normalizePluginLogMessage(message: unknown): string {
  return formatPluginThrownValue(message);
}

export function createPluginLogStore(options: CreatePluginLogStoreOptions = {}): PluginLogStore {
  const entries: PluginLogEntry[] = [];
  const clock = options.clock ?? (() => new Date());

  return {
    log: (entry) => {
      const logEntry: PluginLogEntry = {
        timestamp: clock().toISOString(),
        level: entry.level,
        message: normalizePluginLogMessage(entry.message),
      };
      const details = clonePluginLogDetails(entry.details);

      if (entry.pluginId !== undefined) {
        logEntry.pluginId = entry.pluginId;
      }

      if (entry.error !== undefined) {
        logEntry.error = entry.error;
      }

      if (details !== undefined) {
        logEntry.details = details;
      }

      entries.push(logEntry);
      options.sink?.(clonePluginLogEntry(logEntry));

      return clonePluginLogEntry(logEntry);
    },
    list: (pluginId) =>
      entries
        .filter((entry) => pluginId === undefined || entry.pluginId === pluginId)
        .map(clonePluginLogEntry),
  };
}

export function createPluginLogger(pluginId: string, logStore: PluginLogStore): PluginLogger {
  const log = (level: PluginLogLevel, message: string, details?: PluginJsonObject) => {
    logStore.log({
      pluginId,
      level,
      message,
      ...(details === undefined ? {} : { details }),
    });
  };

  return {
    debug: (message, details) => log('debug', message, details),
    info: (message, details) => log('info', message, details),
    warn: (message, details) => log('warn', message, details),
    error: (message, details) => log('error', message, details),
  };
}

export function logPluginError(
  logStore: PluginLogStore,
  pluginId: string | undefined,
  message: string,
  error: unknown,
): PluginLogEntry {
  return logStore.log({
    ...(pluginId === undefined ? {} : { pluginId }),
    level: 'error',
    message,
    error: formatPluginThrownValue(error),
  });
}

export async function runPluginLifecycleHook(
  pluginId: string,
  hookName: 'activate' | 'deactivate',
  hook: () => void | Promise<void>,
  logStore: PluginLogStore,
): Promise<PluginLifecycleHookResult> {
  try {
    await hook();
    return {
      ok: true,
    };
  } catch (error) {
    const message = formatPluginThrownValue(error);

    logPluginError(logStore, pluginId, `Plugin ${hookName} failed: ${message}`, error);

    return {
      ok: false,
      message,
    };
  }
}

export function createPluginContext(
  options: CreatePluginContextOptions,
): CommandCabinPluginContext {
  const context: CommandCabinPluginContext = {
    appId: 'com.commandcabin.app',
    plugin: {
      id: options.manifest.id,
      name: options.manifest.name,
      version: options.manifest.version,
      description: options.manifest.description,
      permissions: [...options.manifest.permissions],
    },
    permissions: [...options.manifest.permissions],
    logger: options.logger,
    registerCommand: options.registerCommand,
    registerCommandHandler: options.registerCommandHandler,
  };

  if (options.storage !== undefined) {
    Object.assign(context, { storage: options.storage });
  }

  if (options.clipboard !== undefined) {
    Object.assign(context, { clipboard: options.clipboard });
  }

  return context;
}
