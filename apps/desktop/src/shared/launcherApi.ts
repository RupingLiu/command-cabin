import type {
  CommandActionType,
  CommandExecutionFailure,
  CommandExecutionResult,
  CommandSource,
} from '@command-cabin/core';

import {
  isRecord,
  parseFiniteNumber,
  parseOptionalString,
  parseString,
  sanitizeJsonObject,
} from './parsers.js';

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
