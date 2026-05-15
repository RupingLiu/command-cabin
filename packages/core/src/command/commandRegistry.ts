import { cloneCommand } from './commandJson.js';
import type { Command, CommandSource } from './types.js';

export class DuplicateCommandIdError extends Error {
  constructor(commandId: string) {
    super(`Command already registered: ${commandId}`);
    this.name = 'DuplicateCommandIdError';
  }
}

export interface CommandRegistry {
  register: (command: Command) => Command;
  unregister: (commandId: string) => boolean;
  get: (commandId: string) => Command | undefined;
  has: (commandId: string) => boolean;
  list: () => Command[];
  clearBySource: (source: CommandSource) => number;
  clear: () => void;
}

export function createCommandRegistry(): CommandRegistry {
  const commandsById = new Map<string, Command>();

  return {
    register: (command) => {
      if (commandsById.has(command.id)) {
        throw new DuplicateCommandIdError(command.id);
      }

      const registeredCommand = cloneCommand(command);
      commandsById.set(command.id, registeredCommand);
      return cloneCommand(registeredCommand);
    },
    unregister: (commandId) => commandsById.delete(commandId),
    get: (commandId) => {
      const command = commandsById.get(commandId);
      return command ? cloneCommand(command) : undefined;
    },
    has: (commandId) => commandsById.has(commandId),
    list: () => Array.from(commandsById.values(), cloneCommand),
    clearBySource: (source) => {
      let removedCount = 0;

      for (const [commandId, command] of commandsById) {
        if (command.source === source) {
          commandsById.delete(commandId);
          removedCount += 1;
        }
      }

      return removedCount;
    },
    clear: () => {
      commandsById.clear();
    },
  };
}
