import type {
  StorageJsonObject,
  StorageJsonPrimitive,
  StorageJsonValue,
} from '../storage/database.js';

export type CommandSource = 'system' | 'app' | 'file' | 'url' | 'plugin';

export type CommandActionType =
  | 'open-app'
  | 'open-path'
  | 'open-url'
  | 'copy-text'
  | 'run-plugin'
  | 'run-system';

export type CommandJsonPrimitive = StorageJsonPrimitive;
export type CommandJsonValue = StorageJsonValue;
export type CommandJsonObject = StorageJsonObject;
export type CommandPayload = CommandJsonObject;
export type CommandExecutionMetadata = CommandJsonObject;

export type ReadonlyCommandJsonValue =
  | CommandJsonPrimitive
  | { readonly [key: string]: ReadonlyCommandJsonValue }
  | readonly ReadonlyCommandJsonValue[];

export type ReadonlyCommandJsonObject = {
  readonly [key: string]: ReadonlyCommandJsonValue;
};

export interface CommandAction {
  type: CommandActionType;
  payload: CommandPayload;
}

export interface ReadonlyCommandAction {
  readonly type: CommandActionType;
  readonly payload: ReadonlyCommandJsonObject;
}

export interface Command {
  id: string;
  source: CommandSource;
  title: string;
  subtitle?: string;
  keywords: string[];
  icon?: string;
  pluginId?: string;
  action: CommandAction;
}

export interface ReadonlyCommand {
  readonly id: string;
  readonly source: CommandSource;
  readonly title: string;
  readonly subtitle?: string;
  readonly keywords: readonly string[];
  readonly icon?: string;
  readonly pluginId?: string;
  readonly action: ReadonlyCommandAction;
}

export type CommandHandlerResult = void | {
  metadata?: CommandExecutionMetadata;
};

export type CommandActionHandler = (
  command: ReadonlyCommand,
) => CommandHandlerResult | Promise<CommandHandlerResult>;

export type CommandActionHandlers = Partial<Record<CommandActionType, CommandActionHandler>>;

export interface CommandExecutionSuccess {
  status: 'success';
  commandId: string;
  actionType: CommandActionType;
  metadata: CommandExecutionMetadata;
}

export interface CommandExecutionFailure {
  status: 'failure';
  commandId: string;
  actionType: CommandActionType;
  error: {
    code: 'missing-handler' | 'handler-error' | 'invalid-command' | 'invalid-result';
    message: string;
  };
}

export type CommandExecutionResult = CommandExecutionSuccess | CommandExecutionFailure;
