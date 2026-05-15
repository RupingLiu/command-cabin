export const COMMAND_CABIN_APP_ID = 'com.commandcabin.app' as const;

export type CommandCabinAppId = typeof COMMAND_CABIN_APP_ID;

export type PluginJsonPrimitive = string | number | boolean | null;
export type PluginJsonValue =
  | PluginJsonPrimitive
  | { readonly [key: string]: PluginJsonValue }
  | readonly PluginJsonValue[];
export type PluginJsonObject = {
  readonly [key: string]: PluginJsonValue;
};

export type PluginPermission = 'clipboard.read' | 'clipboard.write';

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PluginLogger {
  debug(message: string, details?: PluginJsonObject): void;
  info(message: string, details?: PluginJsonObject): void;
  warn(message: string, details?: PluginJsonObject): void;
  error(message: string, details?: PluginJsonObject): void;
}

export interface PluginRuntimeMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly permissions: readonly PluginPermission[];
}

export interface PluginCommandRegistration {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly keywords?: readonly string[];
  readonly icon?: string;
}

export interface PluginCommandInvocation {
  readonly pluginId: string;
  readonly commandId: string;
  readonly payload: PluginJsonObject;
}

export type PluginCommandHandlerResult = void | {
  readonly metadata?: PluginJsonObject;
};

export type PluginCommandHandler = (
  invocation: PluginCommandInvocation,
  context: CommandCabinPluginContext,
) => PluginCommandHandlerResult | Promise<PluginCommandHandlerResult>;

export interface PluginStorageGetRequest {
  readonly key: string;
}

export interface PluginStorageSetRequest {
  readonly key: string;
  readonly value: PluginJsonValue;
}

export interface PluginStorageDeleteRequest {
  readonly key: string;
}

export interface PluginStorageCapability {
  get(request: PluginStorageGetRequest): Promise<PluginJsonValue | undefined>;
  set(request: PluginStorageSetRequest): Promise<void>;
  delete(request: PluginStorageDeleteRequest): Promise<boolean>;
  list(): Promise<Readonly<Record<string, PluginJsonValue>>>;
}

export interface PluginClipboardReadTextRequest {
  readonly permission: 'clipboard.read';
}

export interface PluginClipboardWriteTextRequest {
  readonly permission: 'clipboard.write';
  readonly text: string;
}

export interface PluginClipboardCapability {
  readText(request?: PluginClipboardReadTextRequest): Promise<string>;
  writeText(request: PluginClipboardWriteTextRequest): Promise<void>;
}

export interface CommandCabinPluginContext {
  readonly appId: CommandCabinAppId;
  readonly plugin: PluginRuntimeMetadata;
  readonly permissions: readonly PluginPermission[];
  readonly logger: PluginLogger;
  readonly storage?: PluginStorageCapability;
  readonly clipboard?: PluginClipboardCapability;
  registerCommand(command: PluginCommandRegistration, handler: PluginCommandHandler): void;
  registerCommandHandler(commandId: string, handler: PluginCommandHandler): void;
}

export interface CommandCabinPlugin {
  readonly id?: string;
  readonly commands?: Readonly<Record<string, PluginCommandHandler>>;
  activate(context: CommandCabinPluginContext): void | Promise<void>;
  deactivate?(context: CommandCabinPluginContext): void | Promise<void>;
}

export interface CommandCabinPluginModule {
  readonly default?: CommandCabinPlugin;
  readonly plugin?: CommandCabinPlugin;
  readonly activate?: CommandCabinPlugin['activate'];
  readonly deactivate?: CommandCabinPlugin['deactivate'];
  readonly commands?: Readonly<Record<string, PluginCommandHandler>>;
  readonly id?: string;
}
