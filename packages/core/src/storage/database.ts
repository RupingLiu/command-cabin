import Database from 'better-sqlite3';

export type CommandCabinDatabase = Database.Database;

export type StorageJsonPrimitive = string | number | boolean | null;
export type StorageJsonValue =
  | StorageJsonPrimitive
  | { [key: string]: StorageJsonValue }
  | StorageJsonValue[];
export type StorageJsonObject = { [key: string]: StorageJsonValue };

export interface CommandCabinDatabaseOptions {
  path: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  timeoutMs?: number;
  verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
}

export interface StorageValueContext {
  table: string;
  field?: string;
  key?: string;
  pluginId?: string;
  commandId?: string;
}

export interface StorageDateContext {
  operation: string;
  field: string;
}

export function openCommandCabinDatabase(
  options: CommandCabinDatabaseOptions,
): CommandCabinDatabase {
  if (!options || typeof options.path !== 'string') {
    throw new Error('openCommandCabinDatabase requires an explicit database path');
  }
  if (options.path.trim().length === 0) {
    throw new Error('openCommandCabinDatabase requires a non-empty database path');
  }

  const databaseOptions: Database.Options = {};

  if (options.readonly !== undefined) {
    databaseOptions.readonly = options.readonly;
  }
  if (options.fileMustExist !== undefined) {
    databaseOptions.fileMustExist = options.fileMustExist;
  }
  if (options.timeoutMs !== undefined) {
    databaseOptions.timeout = options.timeoutMs;
  }
  if (options.verbose !== undefined) {
    databaseOptions.verbose = options.verbose;
  }

  const databasePath = options.path;
  const database = new Database(databasePath, databaseOptions);

  database.pragma('foreign_keys = ON');

  if (!database.readonly && databasePath !== ':memory:' && databasePath !== '') {
    database.pragma('journal_mode = WAL');
  }

  return database;
}

export function openInMemoryCommandCabinDatabase(
  options: Omit<CommandCabinDatabaseOptions, 'path'> = {},
): CommandCabinDatabase {
  return openCommandCabinDatabase({ ...options, path: ':memory:' });
}

export function formatStorageValueContext(context: StorageValueContext): string {
  const pieces = [context.table];

  if (context.field) {
    pieces.push(context.field);
  }
  if (context.key) {
    pieces.push(`key "${context.key}"`);
  }
  if (context.pluginId) {
    pieces.push(`for plugin "${context.pluginId}"`);
  }
  if (context.commandId) {
    pieces.push(`for command "${context.commandId}"`);
  }

  return pieces.join(' ');
}

function getStorageJsonRootPath(context: StorageValueContext): string {
  return context.key ?? context.field ?? context.table;
}

function throwInvalidStorageJsonValue(
  context: StorageValueContext,
  path: string,
  reason: string,
): never {
  throw new Error(
    `Invalid JSON value in ${formatStorageValueContext(context)} at ${path}: ${reason}`,
  );
}

function isCanonicalArrayIndexProperty(propertyName: string, arrayLength: number): boolean {
  const index = Number(propertyName);

  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < arrayLength &&
    String(index) === propertyName
  );
}

function validateStorageJsonObject(
  value: object,
  context: StorageValueContext,
  path: string,
  ancestors: WeakSet<object>,
): void {
  if (ancestors.has(value)) {
    throwInvalidStorageJsonValue(context, path, 'circular reference');
  }

  ancestors.add(value);

  try {
    for (const symbolKey of Object.getOwnPropertySymbols(value)) {
      throwInvalidStorageJsonValue(
        context,
        `${path}[${symbolKey.toString()}]`,
        'symbol keys are not JSON-serializable',
      );
    }

    if (Array.isArray(value)) {
      for (const propertyName of Object.getOwnPropertyNames(value)) {
        if (propertyName === 'length') {
          continue;
        }

        if (!isCanonicalArrayIndexProperty(propertyName, value.length)) {
          throwInvalidStorageJsonValue(
            context,
            `${path}.${propertyName}`,
            'arrays cannot contain non-index properties',
          );
        }
      }

      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throwInvalidStorageJsonValue(context, `${path}[${index}]`, 'arrays cannot contain holes');
        }

        validateStorageJsonValue(value[index], context, `${path}[${index}]`, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throwInvalidStorageJsonValue(context, path, 'object must be a plain JSON object');
    }

    for (const [key, propertyValue] of Object.entries(value)) {
      validateStorageJsonValue(propertyValue, context, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function validateStorageJsonValue(
  value: unknown,
  context: StorageValueContext,
  path = getStorageJsonRootPath(context),
  ancestors = new WeakSet<object>(),
): asserts value is StorageJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throwInvalidStorageJsonValue(context, path, 'number must be finite');
    }
    return;
  }

  if (typeof value === 'undefined') {
    throwInvalidStorageJsonValue(context, path, 'undefined is not JSON-serializable');
  }

  if (typeof value === 'function') {
    throwInvalidStorageJsonValue(context, path, 'function is not JSON-serializable');
  }

  if (typeof value === 'symbol') {
    throwInvalidStorageJsonValue(context, path, 'symbol is not JSON-serializable');
  }

  if (typeof value === 'bigint') {
    throwInvalidStorageJsonValue(context, path, 'bigint is not JSON-serializable');
  }

  validateStorageJsonObject(value, context, path, ancestors);
}

export function stringifyStorageJson(value: unknown, context: StorageValueContext): string {
  validateStorageJsonValue(value, context);

  try {
    return JSON.stringify(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to stringify JSON in ${formatStorageValueContext(context)}: ${reason}`,
      {
        cause: error,
      },
    );
  }
}

export function parseStorageJson<T extends StorageJsonValue>(
  value: string,
  context: StorageValueContext,
): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${formatStorageValueContext(context)}: ${reason}`, {
      cause: error,
    });
  }
}

export function isStorageJsonObject(value: unknown): value is Record<string, unknown> {
  return !Array.isArray(value) && value !== null && typeof value === 'object';
}

export function normalizeStorageDate(value: Date | string, context: StorageDateContext): string {
  const date = value instanceof Date ? value : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid date for ${context.operation} ${context.field}: ${String(value)}`);
  }

  return date.toISOString();
}
