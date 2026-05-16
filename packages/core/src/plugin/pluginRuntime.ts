import { readFile } from 'node:fs/promises';

import type {
  CommandCabinPlugin,
  CommandCabinPluginContext,
  CommandCabinPluginModule,
  PluginClipboardCapability,
  PluginCommandHandler,
  PluginCommandHandlerResult,
  PluginCommandRegistration,
  PluginJsonObject,
  PluginStorageCapability,
} from '@command-cabin/plugin-api';

import { cloneCommandExecutionMetadata } from '../command/commandJson.js';
import type {
  CommandActionHandler,
  CommandExecutionMetadata,
  CommandHandlerResult,
  ReadonlyCommand,
} from '../command/types.js';
import type { CommandRegistry } from '../command/commandRegistry.js';
import {
  createPluginCommand,
  readPluginCommandPayload,
  type PluginCommandPayload,
} from './pluginCommandAdapter.js';
import {
  createPluginContext,
  createPluginLogger,
  createPluginLogStore,
  formatPluginThrownValue,
  logPluginError,
  runPluginLifecycleHook,
  type PluginLifecycleClock,
  type PluginLogEntry,
  type PluginLogSink,
} from './pluginLifecycle.js';
import {
  getPluginManifestFilePath,
  resolvePluginManifestRealPath,
  type ResolvePluginManifestPathResult,
} from './pluginPaths.js';
import type { PluginManifest, PluginManifestValidationError } from './pluginManifest.js';
import {
  formatPluginManifestValidationErrors,
  validatePluginManifest,
} from './validateManifest.js';

export type PluginRuntimeStatus = 'loaded' | 'enabled' | 'disabled';

export type PluginRuntimeErrorCode =
  | 'manifest-read-error'
  | 'invalid-manifest'
  | 'main-path-error'
  | 'load-error'
  | 'command-registration-error'
  | 'activate-error'
  | 'deactivate-error'
  | 'plugin-not-loaded'
  | 'invalid-command'
  | 'plugin-disabled'
  | 'missing-handler'
  | 'handler-error'
  | 'invalid-result';

export interface PluginRuntimeError {
  code: PluginRuntimeErrorCode;
  message: string;
  pluginId: string | undefined;
  validationErrors?: PluginManifestValidationError[];
}

export interface PluginRuntimeSuccess<T> {
  ok: true;
  value: T;
}

export interface PluginRuntimeFailure {
  ok: false;
  error: PluginRuntimeError;
}

export type PluginRuntimeResult<T> = PluginRuntimeSuccess<T> | PluginRuntimeFailure;

export interface PluginRuntimePlugin {
  pluginId: string;
  pluginRoot: string;
  mainPath: string;
  manifest: PluginManifest;
  status: PluginRuntimeStatus;
}

export interface DisablePluginSuccess {
  pluginId: string;
  status: 'disabled';
  removedCommands: number;
}

export interface PluginCommandExecutionSuccess {
  status: 'success';
  commandId: string;
  pluginId: string;
  localCommandId: string;
  metadata: CommandExecutionMetadata;
}

export interface PluginCommandExecutionFailure {
  status: 'failure';
  commandId: string;
  pluginId: string | undefined;
  localCommandId: string | undefined;
  error: {
    code: Extract<
      PluginRuntimeErrorCode,
      'invalid-command' | 'plugin-disabled' | 'missing-handler' | 'handler-error' | 'invalid-result'
    >;
    message: string;
  };
}

export type PluginCommandExecutionResult =
  | PluginCommandExecutionSuccess
  | PluginCommandExecutionFailure;

export interface PluginModuleLoadInput {
  pluginRoot: string;
  mainPath: string;
  manifest: PluginManifest;
  context: CommandCabinPluginContext;
}

export type PluginModuleLoader = (
  input: PluginModuleLoadInput,
) =>
  | CommandCabinPluginModule
  | CommandCabinPlugin
  | Promise<CommandCabinPluginModule | CommandCabinPlugin>;

export type PluginManifestReader = (pluginRoot: string) => unknown | Promise<unknown>;

export type PluginMainPathResolver = (
  pluginRoot: string,
  manifest: PluginManifest,
) => ResolvePluginManifestPathResult | Promise<ResolvePluginManifestPathResult>;

export interface PluginRuntimeOptions {
  commandRegistry: CommandRegistry;
  moduleLoader: PluginModuleLoader;
  readManifest?: PluginManifestReader;
  resolveMainPath?: PluginMainPathResolver;
  logSink?: PluginLogSink;
  clock?: PluginLifecycleClock;
  storage?: PluginStorageCapability;
  clipboard?: PluginClipboardCapability;
}

export interface PluginRuntime {
  loadPlugin(pluginRoot: string): Promise<PluginRuntimeResult<PluginRuntimePlugin>>;
  enablePlugin(pluginRoot: string): Promise<PluginRuntimeResult<PluginRuntimePlugin>>;
  disablePlugin(pluginId: string): Promise<PluginRuntimeResult<DisablePluginSuccess>>;
  executePluginCommand(command: ReadonlyCommand): Promise<PluginCommandExecutionResult>;
  createRunPluginCommandHandler(): CommandActionHandler;
  getPlugin(pluginId: string): PluginRuntimePlugin | undefined;
  listPlugins(): PluginRuntimePlugin[];
  getPluginLogs(pluginId?: string): PluginLogEntry[];
}

interface RuntimePluginState {
  pluginRoot: string;
  mainPath: string;
  manifest: PluginManifest;
  plugin: CommandCabinPlugin;
  context: CommandCabinPluginContext;
  status: PluginRuntimeStatus;
  registrationOpen: boolean;
  registrationGeneration: number;
  registeredCommandIds: Set<string>;
  registeredLocalCommandIds: Set<string>;
  commandHandlers: Map<string, PluginCommandHandler>;
}

class PluginCommandExecutionError extends Error {
  constructor(result: PluginCommandExecutionFailure) {
    super(
      `Plugin command "${result.localCommandId ?? 'unknown'}" from plugin "${
        result.pluginId ?? 'unknown'
      }" failed: ${result.error.message}`,
    );
    this.name = 'PluginCommandExecutionError';
  }
}

async function readManifestFromFile(pluginRoot: string): Promise<unknown> {
  const manifestText = await readFile(getPluginManifestFilePath(pluginRoot), 'utf8');

  return JSON.parse(manifestText) as unknown;
}

function createSuccess<T>(value: T): PluginRuntimeSuccess<T> {
  return {
    ok: true,
    value,
  };
}

function createFailure(
  code: PluginRuntimeErrorCode,
  message: string,
  pluginId?: string,
  validationErrors?: PluginManifestValidationError[],
): PluginRuntimeFailure {
  const error: PluginRuntimeError = {
    code,
    message,
    pluginId,
  };

  if (validationErrors !== undefined) {
    error.validationErrors = validationErrors;
  }

  return {
    ok: false,
    error,
  };
}

function getPublicPlugin(state: RuntimePluginState): PluginRuntimePlugin {
  return {
    pluginId: state.manifest.id,
    pluginRoot: state.pluginRoot,
    mainPath: state.mainPath,
    manifest: state.manifest,
    status: state.status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePluginModule(
  moduleValue: CommandCabinPluginModule | CommandCabinPlugin,
): CommandCabinPlugin {
  const maybeModule = moduleValue as CommandCabinPluginModule;
  const plugin = maybeModule.default ?? maybeModule.plugin ?? moduleValue;

  if (!isRecord(plugin) || typeof plugin.activate !== 'function') {
    throw new Error('Plugin module must export a plugin object with an activate function.');
  }

  return plugin as unknown as CommandCabinPlugin;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getPluginCommandHandlerMetadata(
  result: PluginCommandHandlerResult,
  commandId: string,
): CommandExecutionMetadata {
  if (result === undefined) {
    return {};
  }

  if (!isPlainObject(result)) {
    throw new Error('Plugin command handler result must be undefined or a plain object.');
  }

  const metadata = result.metadata ?? {};

  if (!isPlainObject(metadata)) {
    throw new Error('Plugin command handler metadata must be a plain object.');
  }

  return cloneCommandExecutionMetadata(metadata as CommandExecutionMetadata, commandId);
}

function createCommandExecutionFailure(
  commandId: string,
  payload: Partial<PluginCommandPayload>,
  code: PluginCommandExecutionFailure['error']['code'],
  message: string,
): PluginCommandExecutionFailure {
  return {
    status: 'failure',
    commandId,
    pluginId: payload.pluginId,
    localCommandId: payload.commandId,
    error: {
      code,
      message,
    },
  };
}

function createPermissionedClipboard(
  manifest: PluginManifest,
  clipboard: PluginClipboardCapability | undefined,
): PluginClipboardCapability | undefined {
  if (clipboard === undefined) {
    return undefined;
  }

  const permissions = new Set(manifest.permissions);
  const assertPermission = (permission: 'clipboard.read' | 'clipboard.write') => {
    if (!permissions.has(permission)) {
      throw new Error(`Plugin requires permission "${permission}".`);
    }
  };

  return {
    readText: async (request) => {
      assertPermission('clipboard.read');
      return clipboard.readText(request);
    },
    writeText: async (request) => {
      assertPermission('clipboard.write');
      return clipboard.writeText(request);
    },
  };
}

function readPluginCommandEntries(
  state: RuntimePluginState,
  logStore: ReturnType<typeof createPluginLogStore>,
): { ok: true; entries: [string, unknown][] } | { ok: false; message: string } {
  try {
    return {
      ok: true,
      entries: Object.entries(state.plugin.commands ?? {}),
    };
  } catch (error) {
    const message = formatPluginThrownValue(error);

    logPluginError(
      logStore,
      state.manifest.id,
      `Plugin commands could not be read: ${message}`,
      error,
    );

    return {
      ok: false,
      message,
    };
  }
}

function readPluginDeactivateHook(
  state: RuntimePluginState,
  logStore: ReturnType<typeof createPluginLogStore>,
): { ok: true; hook: CommandCabinPlugin['deactivate'] } | { ok: false; message: string } {
  try {
    return {
      ok: true,
      hook: state.plugin.deactivate,
    };
  } catch (error) {
    const message = formatPluginThrownValue(error);

    logPluginError(logStore, state.manifest.id, `Plugin deactivate failed: ${message}`, error);

    return {
      ok: false,
      message,
    };
  }
}

export function createPluginRuntime(options: PluginRuntimeOptions): PluginRuntime {
  const pluginsById = new Map<string, RuntimePluginState>();
  const logStore = createPluginLogStore({
    ...(options.logSink === undefined ? {} : { sink: options.logSink }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const readManifest = options.readManifest ?? readManifestFromFile;
  const resolveMainPath =
    options.resolveMainPath ??
    ((pluginRoot: string, manifest: PluginManifest) =>
      resolvePluginManifestRealPath(pluginRoot, manifest.main, 'main'));

  const unregisterPluginCommands = (state: RuntimePluginState): number => {
    let removedCount = 0;

    for (const commandId of state.registeredCommandIds) {
      if (options.commandRegistry.unregister(commandId)) {
        removedCount += 1;
      }
    }

    state.registeredCommandIds.clear();
    state.registeredLocalCommandIds.clear();
    state.commandHandlers.clear();

    return removedCount;
  };

  const revokePluginRegistration = (state: RuntimePluginState) => {
    state.registrationOpen = false;
    state.registrationGeneration += 1;
  };

  const openPluginRegistration = (state: RuntimePluginState) => {
    state.registrationOpen = true;
  };

  const assertPluginRegistrationAllowed = (
    state: RuntimePluginState,
    contextGeneration: number,
  ) => {
    if (!state.registrationOpen || state.registrationGeneration !== contextGeneration) {
      throw new Error(
        `Plugin command registration is not allowed for plugin "${state.manifest.id}" in its current lifecycle state.`,
      );
    }
  };

  const registerHostPluginCommand = (
    state: RuntimePluginState,
    command: PluginCommandRegistration,
    handler?: PluginCommandHandler,
  ) => {
    if (state.registeredLocalCommandIds.has(command.id)) {
      throw new Error(`Plugin command already registered: ${command.id}`);
    }

    const hostCommand = createPluginCommand(state.manifest, command);

    options.commandRegistry.register(hostCommand);
    state.registeredCommandIds.add(hostCommand.id);
    state.registeredLocalCommandIds.add(command.id);

    if (handler !== undefined) {
      state.commandHandlers.set(command.id, handler);
    }
  };

  const registerContextPluginCommand = (
    state: RuntimePluginState,
    contextGeneration: number,
    command: PluginCommandRegistration,
    handler: PluginCommandHandler,
  ) => {
    assertPluginRegistrationAllowed(state, contextGeneration);
    registerHostPluginCommand(state, command, handler);
  };

  const registerContextPluginCommandHandler = (
    state: RuntimePluginState,
    contextGeneration: number,
    commandId: string,
    handler: PluginCommandHandler,
  ) => {
    assertPluginRegistrationAllowed(state, contextGeneration);

    if (!state.registeredLocalCommandIds.has(commandId)) {
      throw new Error(`Plugin command is not registered: ${commandId}`);
    }

    state.commandHandlers.set(commandId, handler);
  };

  const loadPlugin = async (
    pluginRoot: string,
  ): Promise<PluginRuntimeResult<PluginRuntimePlugin>> => {
    let manifestValue: unknown;

    try {
      manifestValue = await readManifest(pluginRoot);
    } catch (error) {
      const message = formatPluginThrownValue(error);

      logPluginError(logStore, undefined, `Plugin manifest could not be read: ${message}`, error);

      return createFailure('manifest-read-error', message);
    }

    const validationResult = validatePluginManifest(manifestValue);

    if (!validationResult.ok) {
      const messages = formatPluginManifestValidationErrors(validationResult.errors);

      logStore.log({
        level: 'error',
        message: `Plugin manifest is invalid: ${messages.join('; ')}`,
        details: {
          errors: messages,
        },
      });

      return createFailure(
        'invalid-manifest',
        'Plugin manifest is invalid.',
        undefined,
        validationResult.errors,
      );
    }

    const { manifest } = validationResult;
    const existingEnabledState = pluginsById.get(manifest.id);

    if (existingEnabledState?.status === 'enabled') {
      return createSuccess(getPublicPlugin(existingEnabledState));
    }

    let mainPathResult: ResolvePluginManifestPathResult;

    try {
      mainPathResult = await resolveMainPath(pluginRoot, manifest);
    } catch (error) {
      const message = formatPluginThrownValue(error);

      logPluginError(
        logStore,
        manifest.id,
        `Plugin main path could not be resolved: ${message}`,
        error,
      );

      return createFailure('main-path-error', message, manifest.id);
    }

    if (!mainPathResult.ok) {
      logStore.log({
        pluginId: manifest.id,
        level: 'error',
        message: mainPathResult.error.message,
      });

      return createFailure('main-path-error', mainPathResult.error.message, manifest.id, [
        mainPathResult.error,
      ]);
    }

    const logger = createPluginLogger(manifest.id, logStore);
    const stateShell = {
      pluginRoot,
      mainPath: mainPathResult.path,
      manifest,
      status: 'loaded' as const,
      registrationOpen: false,
      registrationGeneration: 0,
      registeredCommandIds: new Set<string>(),
      registeredLocalCommandIds: new Set<string>(),
      commandHandlers: new Map<string, PluginCommandHandler>(),
    };
    const stateRef: { current?: RuntimePluginState } = {};
    const readState = (): RuntimePluginState => {
      if (!stateRef.current) {
        throw new Error('Plugin context is not initialized.');
      }

      return stateRef.current;
    };
    const contextGeneration = stateShell.registrationGeneration;
    const permissionedClipboard = createPermissionedClipboard(manifest, options.clipboard);
    const context = createPluginContext({
      manifest,
      logger,
      registerCommand: (command, handler) =>
        registerContextPluginCommand(readState(), contextGeneration, command, handler),
      registerCommandHandler: (commandId, handler) =>
        registerContextPluginCommandHandler(readState(), contextGeneration, commandId, handler),
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      ...(permissionedClipboard === undefined ? {} : { clipboard: permissionedClipboard }),
    });
    const state: RuntimePluginState = {
      ...stateShell,
      context,
      plugin: {
        activate: () => undefined,
      },
    };
    stateRef.current = state;

    try {
      const moduleValue = await options.moduleLoader({
        pluginRoot,
        mainPath: mainPathResult.path,
        manifest,
        context,
      });
      const plugin = normalizePluginModule(moduleValue);

      if (plugin.id !== undefined && plugin.id !== manifest.id) {
        throw new Error(
          `Plugin module id "${plugin.id}" does not match manifest id "${manifest.id}".`,
        );
      }

      state.plugin = plugin;
    } catch (error) {
      unregisterPluginCommands(state);
      revokePluginRegistration(state);

      const message = formatPluginThrownValue(error);

      logPluginError(logStore, manifest.id, `Plugin module load failed: ${message}`, error);

      return createFailure('load-error', message, manifest.id);
    }

    pluginsById.set(manifest.id, state);

    return createSuccess(getPublicPlugin(state));
  };

  const enablePlugin = async (
    pluginRoot: string,
  ): Promise<PluginRuntimeResult<PluginRuntimePlugin>> => {
    const loadResult = await loadPlugin(pluginRoot);

    if (!loadResult.ok) {
      return loadResult;
    }

    const state = pluginsById.get(loadResult.value.pluginId);

    if (!state) {
      return createFailure(
        'load-error',
        `Plugin "${loadResult.value.pluginId}" did not finish loading.`,
        loadResult.value.pluginId,
      );
    }

    if (state.status === 'enabled') {
      return createSuccess(getPublicPlugin(state));
    }

    const pluginCommandEntriesResult = readPluginCommandEntries(state, logStore);

    if (!pluginCommandEntriesResult.ok) {
      unregisterPluginCommands(state);
      revokePluginRegistration(state);
      state.status = 'disabled';

      return createFailure(
        'command-registration-error',
        pluginCommandEntriesResult.message,
        state.manifest.id,
      );
    }

    for (const [commandId, handler] of pluginCommandEntriesResult.entries) {
      if (typeof handler === 'function') {
        state.commandHandlers.set(commandId, handler as PluginCommandHandler);
      }
    }

    try {
      for (const command of state.manifest.commands) {
        registerHostPluginCommand(state, command, state.commandHandlers.get(command.id));
      }
    } catch (error) {
      unregisterPluginCommands(state);
      revokePluginRegistration(state);
      state.status = 'disabled';

      const message = formatPluginThrownValue(error);

      logPluginError(
        logStore,
        state.manifest.id,
        `Failed to register plugin command: ${message}`,
        error,
      );

      return createFailure('command-registration-error', message, state.manifest.id);
    }

    openPluginRegistration(state);

    const activateResult = await runPluginLifecycleHook(
      state.manifest.id,
      'activate',
      () => state.plugin.activate(state.context),
      logStore,
    );

    if (!activateResult.ok) {
      revokePluginRegistration(state);
      unregisterPluginCommands(state);
      state.status = 'disabled';

      return createFailure('activate-error', activateResult.message, state.manifest.id);
    }

    state.status = 'enabled';

    return createSuccess(getPublicPlugin(state));
  };

  const disablePlugin = async (
    pluginId: string,
  ): Promise<PluginRuntimeResult<DisablePluginSuccess>> => {
    const state = pluginsById.get(pluginId);

    if (!state) {
      return createFailure('plugin-not-loaded', `Plugin "${pluginId}" is not loaded.`, pluginId);
    }

    if (state.status !== 'enabled') {
      revokePluginRegistration(state);
      state.status = 'disabled';

      return createSuccess({
        pluginId: state.manifest.id,
        removedCommands: 0,
        status: 'disabled',
      });
    }

    revokePluginRegistration(state);

    const deactivateHookResult = readPluginDeactivateHook(state, logStore);
    const deactivateResult = deactivateHookResult.ok
      ? deactivateHookResult.hook
        ? await runPluginLifecycleHook(
            state.manifest.id,
            'deactivate',
            () => deactivateHookResult.hook!(state.context),
            logStore,
          )
        : { ok: true as const }
      : {
          ok: false as const,
          message: deactivateHookResult.message,
        };
    const removedCommands = unregisterPluginCommands(state);

    state.status = 'disabled';

    if (!deactivateResult.ok) {
      return createFailure('deactivate-error', deactivateResult.message, state.manifest.id);
    }

    return createSuccess({
      pluginId: state.manifest.id,
      removedCommands,
      status: 'disabled',
    });
  };

  const executePluginCommand = async (
    command: ReadonlyCommand,
  ): Promise<PluginCommandExecutionResult> => {
    let payload: PluginCommandPayload;

    try {
      payload = readPluginCommandPayload(command);
    } catch (error) {
      return createCommandExecutionFailure(
        command.id,
        command.pluginId === undefined ? {} : { pluginId: command.pluginId },
        'invalid-command',
        formatPluginThrownValue(error),
      );
    }

    const state = pluginsById.get(payload.pluginId);

    if (!state || state.status !== 'enabled') {
      return createCommandExecutionFailure(
        command.id,
        payload,
        'plugin-disabled',
        `Plugin "${payload.pluginId}" is not enabled.`,
      );
    }

    const handler = state.commandHandlers.get(payload.commandId);

    if (!handler) {
      return createCommandExecutionFailure(
        command.id,
        payload,
        'missing-handler',
        `Plugin command "${payload.commandId}" has no registered handler.`,
      );
    }

    try {
      const result = await handler(
        {
          pluginId: payload.pluginId,
          commandId: payload.commandId,
          payload: command.action.payload as PluginJsonObject,
        },
        state.context,
      );
      const metadata = getPluginCommandHandlerMetadata(result, command.id);

      return {
        status: 'success',
        commandId: command.id,
        pluginId: payload.pluginId,
        localCommandId: payload.commandId,
        metadata,
      };
    } catch (error) {
      const message = formatPluginThrownValue(error);
      const code =
        message.includes('handler result') || message.includes('metadata')
          ? 'invalid-result'
          : 'handler-error';

      logPluginError(
        logStore,
        payload.pluginId,
        `Plugin command handler failed for "${payload.commandId}": ${message}`,
        error,
      );

      return createCommandExecutionFailure(command.id, payload, code, message);
    }
  };

  const createRunPluginCommandHandler = (): CommandActionHandler => {
    return async (command): Promise<CommandHandlerResult> => {
      const result = await executePluginCommand(command);

      if (result.status === 'success') {
        const state = pluginsById.get(result.pluginId);
        const metadata: CommandExecutionMetadata = {
          pluginId: result.pluginId,
          commandId: result.localCommandId,
          status: 'success',
          pluginMetadata: result.metadata,
        };

        if (state?.manifest.ui !== undefined) {
          metadata.pluginPage = {
            name: state.manifest.name,
            pluginId: result.pluginId,
            pluginRoot: state.pluginRoot,
            uiPath: state.manifest.ui,
          };
        }

        return {
          metadata,
        };
      }

      throw new PluginCommandExecutionError(result);
    };
  };

  return {
    loadPlugin,
    enablePlugin,
    disablePlugin,
    executePluginCommand,
    createRunPluginCommandHandler,
    getPlugin: (pluginId) => {
      const state = pluginsById.get(pluginId);

      return state ? getPublicPlugin(state) : undefined;
    },
    listPlugins: () => Array.from(pluginsById.values(), getPublicPlugin),
    getPluginLogs: (pluginId) => logStore.list(pluginId),
  };
}
