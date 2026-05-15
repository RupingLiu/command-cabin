import type { PluginCommandRegistration } from '@command-cabin/plugin-api';

import type { Command, ReadonlyCommand } from '../command/types.js';
import {
  PLUGIN_COMMAND_ID_PATTERN,
  type PluginManifest,
  type PluginManifestCommand,
} from './pluginManifest.js';

export interface PluginCommandPayload {
  pluginId: string;
  commandId: string;
}

export class PluginCommandAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCommandAdapterError';
  }
}

function hasOptionalStringField<T extends string>(
  command: PluginManifestCommand | PluginCommandRegistration,
  field: T,
): command is PluginCommandRegistration & Record<T, string> {
  return field in command && typeof command[field as keyof typeof command] === 'string';
}

function readOptionalString(
  command: PluginManifestCommand | PluginCommandRegistration,
  field: 'subtitle' | 'icon',
): string | undefined {
  if (!hasOptionalStringField(command, field)) {
    return undefined;
  }

  const value = command[field];

  if (value.trim().length === 0) {
    throw new PluginCommandAdapterError(`Command ${field} cannot be empty.`);
  }

  return value;
}

function readKeywords(command: PluginManifestCommand | PluginCommandRegistration): string[] {
  if (command.keywords === undefined) {
    return [];
  }

  if (!Array.isArray(command.keywords)) {
    throw new PluginCommandAdapterError('Command keywords must be an array.');
  }

  return command.keywords.map((keyword, index) => {
    if (typeof keyword !== 'string') {
      throw new PluginCommandAdapterError(`Command keyword at index ${index} must be a string.`);
    }

    if (keyword.trim().length === 0) {
      throw new PluginCommandAdapterError(`Command keyword at index ${index} cannot be empty.`);
    }

    return keyword;
  });
}

function validatePluginCommandDeclaration(
  command: PluginManifestCommand | PluginCommandRegistration,
): void {
  if (typeof command.id !== 'string' || command.id.trim().length === 0) {
    throw new PluginCommandAdapterError('Command ID is required.');
  }

  if (!PLUGIN_COMMAND_ID_PATTERN.test(command.id)) {
    throw new PluginCommandAdapterError(
      'Command ID must use lowercase letters, numbers, dots, or hyphens, for example "uppercase".',
    );
  }

  if (typeof command.title !== 'string' || command.title.trim().length === 0) {
    throw new PluginCommandAdapterError('Command title is required.');
  }
}

export function createPluginCommandId(pluginId: string, commandId: string): string {
  return `${pluginId}.${commandId}`;
}

export function createPluginCommand(
  manifest: PluginManifest,
  command: PluginManifestCommand | PluginCommandRegistration,
): Command {
  validatePluginCommandDeclaration(command);

  const hostCommand: Command = {
    id: createPluginCommandId(manifest.id, command.id),
    source: 'plugin',
    pluginId: manifest.id,
    title: command.title,
    subtitle: readOptionalString(command, 'subtitle') ?? manifest.name,
    keywords: readKeywords(command),
    action: {
      type: 'run-plugin',
      payload: {
        pluginId: manifest.id,
        commandId: command.id,
      },
    },
  };
  const icon = readOptionalString(command, 'icon');

  if (icon !== undefined) {
    hostCommand.icon = icon;
  }

  return hostCommand;
}

export function readPluginCommandPayload(command: Command | ReadonlyCommand): PluginCommandPayload {
  if (command.source !== 'plugin' || command.action.type !== 'run-plugin') {
    throw new PluginCommandAdapterError('Command is not a plugin run command.');
  }

  const { pluginId, commandId } = command.action.payload;

  if (typeof pluginId !== 'string' || pluginId.trim().length === 0) {
    throw new PluginCommandAdapterError('Plugin command payload is missing pluginId.');
  }

  if (typeof commandId !== 'string' || commandId.trim().length === 0) {
    throw new PluginCommandAdapterError('Plugin command payload is missing commandId.');
  }

  return {
    pluginId,
    commandId,
  };
}
