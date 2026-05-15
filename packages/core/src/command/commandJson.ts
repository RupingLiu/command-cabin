import {
  formatStorageValueContext,
  isStorageJsonObject,
  validateStorageJsonValue,
  type StorageJsonObject,
  type StorageValueContext,
} from '../storage/database.js';
import type { Command, CommandExecutionMetadata, CommandPayload } from './types.js';

function cloneJsonObject(
  value: unknown,
  context: StorageValueContext,
  path: string,
  objectName: string,
): StorageJsonObject {
  validateStorageJsonValue(value, context, path);

  if (!isStorageJsonObject(value)) {
    throw new Error(
      `Invalid JSON value in ${formatStorageValueContext(
        context,
      )} at ${path}: ${objectName} must be a JSON object`,
    );
  }

  return JSON.parse(JSON.stringify(value)) as StorageJsonObject;
}

export function cloneCommandPayload(payload: CommandPayload, commandId: string): CommandPayload {
  return cloneJsonObject(
    payload,
    {
      table: 'command',
      field: 'action payload',
      commandId,
    },
    'payload',
    'payload',
  );
}

export function cloneCommandExecutionMetadata(
  metadata: CommandExecutionMetadata,
  commandId: string,
): CommandExecutionMetadata {
  return cloneJsonObject(
    metadata,
    {
      table: 'command execution',
      field: 'metadata',
      commandId,
    },
    'metadata',
    'metadata',
  );
}

export function cloneCommand(command: Command): Command {
  return {
    ...command,
    keywords: [...command.keywords],
    action: {
      type: command.action.type,
      payload: cloneCommandPayload(command.action.payload, command.id),
    },
  };
}
