import type {
  Command,
  CommandActionHandlers,
  CommandActionType,
  CommandExecutionFailure,
  CommandExecutionResult,
  CommandExecutionMetadata,
} from './types.js';
import { cloneCommand, cloneCommandExecutionMetadata } from './commandJson.js';

export interface CommandExecutorOptions {
  handlers: CommandActionHandlers;
}

export interface CommandExecutor {
  execute: (command: Command) => Promise<CommandExecutionResult>;
}

function createFailureResult(
  commandId: string,
  actionType: CommandActionType,
  code: CommandExecutionFailure['error']['code'],
  message: string,
): CommandExecutionFailure {
  return {
    status: 'failure',
    commandId,
    actionType,
    error: {
      code,
      message,
    },
  };
}

function formatThrownValue(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getHandlerResultMetadata(handlerResult: unknown): CommandExecutionMetadata {
  if (handlerResult === undefined) {
    return {};
  }

  if (!isPlainObject(handlerResult)) {
    throw new Error('Command handler result must be undefined or a plain object.');
  }

  return (handlerResult.metadata ?? {}) as CommandExecutionMetadata;
}

export function createCommandExecutor(options: CommandExecutorOptions): CommandExecutor {
  return {
    execute: async (command) => {
      const commandId = command.id;
      const actionType = command.action.type;
      const handler = options.handlers[actionType];

      if (!handler) {
        return createFailureResult(
          commandId,
          actionType,
          'missing-handler',
          `No command handler registered for action type "${actionType}".`,
        );
      }

      let handlerCommand;

      try {
        handlerCommand = cloneCommand(command);
      } catch (error) {
        return createFailureResult(
          commandId,
          actionType,
          'invalid-command',
          formatThrownValue(error),
        );
      }

      let handlerResult: unknown;

      try {
        handlerResult = await handler(handlerCommand);
      } catch (error) {
        return createFailureResult(
          commandId,
          actionType,
          'handler-error',
          formatThrownValue(error),
        );
      }

      try {
        const metadata = cloneCommandExecutionMetadata(
          getHandlerResultMetadata(handlerResult),
          commandId,
        );
        return {
          status: 'success',
          commandId,
          actionType,
          metadata,
        };
      } catch (error) {
        return createFailureResult(
          commandId,
          actionType,
          'invalid-result',
          formatThrownValue(error),
        );
      }
    },
  };
}
