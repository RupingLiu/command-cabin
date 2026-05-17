import type {
  CommandActionType,
  CommandExecutionFailure,
  CommandExecutionMetadata,
  CommandExecutionResult,
  CommandSource,
  CommandJsonValue,
} from '@command-cabin/core';

export interface LauncherCommandSearchResult {
  id: string;
  source: CommandSource;
  title: string;
  subtitle?: string;
  icon?: string;
  iconCandidates?: string[];
  favoriteId?: string;
  score: number;
}

export type LauncherCommandExecutionResult = CommandExecutionResult;

const commandSources = new Set<CommandSource>(['system', 'app', 'file', 'url', 'plugin']);
const commandActionTypes = new Set<CommandActionType>([
  'open-app',
  'open-path',
  'open-url',
  'copy-text',
  'run-plugin',
  'run-system',
]);
const commandExecutionFailureCodes = new Set<CommandExecutionFailure['error']['code']>([
  'missing-handler',
  'handler-error',
  'invalid-command',
  'invalid-result',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string.`);
  }

  return value;
}

function parseOptionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseString(value, context);
}

function parseFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number.`);
  }

  return value;
}

function parseCommandSource(value: unknown, context: string): CommandSource {
  const source = parseString(value, context);

  if (!commandSources.has(source as CommandSource)) {
    throw new Error(`${context} is not a supported command source.`);
  }

  return source as CommandSource;
}

function parseCommandActionType(value: unknown, context: string): CommandActionType {
  const actionType = parseString(value, context);

  if (!commandActionTypes.has(actionType as CommandActionType)) {
    throw new Error(`${context} is not a supported command action type.`);
  }

  return actionType as CommandActionType;
}

function sanitizeJsonValue(value: unknown, context: string): CommandJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeJsonValue(item, `${context}[${index}]`));
  }

  if (isRecord(value)) {
    return sanitizeJsonObject(value, context);
  }

  throw new Error(`${context} must be JSON-compatible.`);
}

function sanitizeJsonObject(value: unknown, context: string): CommandExecutionMetadata {
  if (!isRecord(value)) {
    throw new Error(`${context} must be a plain object.`);
  }

  const sanitized: CommandExecutionMetadata = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = sanitizeJsonValue(nestedValue, `${context}.${key}`);
  }

  return sanitized;
}

function parseSearchResult(value: unknown, index: number): LauncherCommandSearchResult {
  const context = `Invalid launcher command search response at results[${index}]`;

  if (!isRecord(value)) {
    throw new Error(`${context}: result must be an object.`);
  }

  const result: LauncherCommandSearchResult = {
    id: parseString(value.id, `${context}.id`),
    score: parseFiniteNumber(value.score, `${context}.score`),
    source: parseCommandSource(value.source, `${context}.source`),
    title: parseString(value.title, `${context}.title`),
  };
  const subtitle = parseOptionalString(value.subtitle, `${context}.subtitle`);
  const icon = parseOptionalString(value.icon, `${context}.icon`);
  const favoriteId = parseOptionalString(value.favoriteId, `${context}.favoriteId`);

  if (subtitle !== undefined) {
    result.subtitle = subtitle;
  }

  if (icon !== undefined) {
    result.icon = icon;
  }

  if (favoriteId !== undefined) {
    result.favoriteId = favoriteId;
  }

  return result;
}

export function parseLauncherCommandSearchResults(value: unknown): LauncherCommandSearchResult[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid launcher command search response: expected an array.');
  }

  return value.map(parseSearchResult);
}

function parseExecutionFailureCode(
  value: unknown,
  context: string,
): CommandExecutionFailure['error']['code'] {
  const code = parseString(value, context);

  if (!commandExecutionFailureCodes.has(code as CommandExecutionFailure['error']['code'])) {
    throw new Error(`${context} is not a supported command execution failure code.`);
  }

  return code as CommandExecutionFailure['error']['code'];
}

export function parseLauncherCommandExecutionResult(
  value: unknown,
): LauncherCommandExecutionResult {
  const context = 'Invalid launcher command execution response';

  if (!isRecord(value)) {
    throw new Error(`${context}: result must be an object.`);
  }

  const status = parseString(value.status, `${context}.status`);
  const commandId = parseString(value.commandId, `${context}.commandId`);
  const actionType = parseCommandActionType(value.actionType, `${context}.actionType`);

  if (status === 'success') {
    return {
      status,
      commandId,
      actionType,
      metadata: sanitizeJsonObject(value.metadata, `${context}.metadata`),
    };
  }

  if (status === 'failure') {
    if (!isRecord(value.error)) {
      throw new Error(`${context}.error must be an object.`);
    }

    return {
      status,
      commandId,
      actionType,
      error: {
        code: parseExecutionFailureCode(value.error.code, `${context}.error.code`),
        message: parseString(value.error.message, `${context}.error.message`),
      },
    };
  }

  throw new Error(`${context}.status is not supported.`);
}
