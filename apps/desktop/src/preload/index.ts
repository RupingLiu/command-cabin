import { contextBridge, ipcRenderer } from 'electron';
import { join } from 'node:path';

import {
  ADD_FAVORITE_CHANNEL,
  EXECUTE_COMMAND_CHANNEL,
  FOCUS_SEARCH_INPUT_CHANNEL,
  HIDE_LAUNCHER_CHANNEL,
  LIST_FAVORITES_CHANNEL,
  REMOVE_FAVORITE_CHANNEL,
  REGISTER_PLUGIN_HOST_ENTRY_CHANNEL,
  RELEASE_PLUGIN_HOST_ENTRY_CHANNEL,
  SEARCH_COMMANDS_CHANNEL,
  UPDATE_FAVORITE_CHANNEL,
} from '../shared/ipcChannels.js';
import {
  parseFavoriteCreateRequest,
  parseFavoriteId,
  parseFavoriteRecord,
  parseFavoriteRecords,
  parseFavoriteRemovalResult,
  parseFavoriteUpdateRequest,
  type FavoriteCreateRequest,
  type FavoriteListRecord,
  type FavoriteUpdateRequest,
} from '../shared/favoritesApi.js';
import {
  parseLauncherCommandExecutionResult,
  parseLauncherCommandSearchResults,
  type LauncherCommandExecutionResult,
  type LauncherCommandSearchResult,
} from '../shared/launcherApi.js';

const PLUGIN_BRIDGE_CHANNEL = 'command-cabin:plugin-bridge';
const PLUGIN_BRIDGE_METHODS = Object.freeze(['close', 'reportError'] as const);

export type PluginHostBridgeMethod = (typeof PLUGIN_BRIDGE_METHODS)[number];

export interface PluginHostBridgeInfo {
  channel: typeof PLUGIN_BRIDGE_CHANNEL;
  methods: readonly PluginHostBridgeMethod[];
}

export interface PluginHostEntryRequest {
  name: string;
  pluginId: string;
  pluginRoot: string;
  uiPath: string;
}

export interface PluginHostEntry {
  allowedBaseUrl: string;
  entryUrl: string;
  launchToken: string;
  name: string;
  partition: string;
  pluginId: string;
}

export interface PluginHostPreloadApi {
  createEntry: (input: PluginHostEntryRequest) => Promise<PluginHostEntry>;
  getBridgeInfo: () => PluginHostBridgeInfo;
  getPluginBridgePreloadPath: () => string;
  releaseEntry: (launchToken: string) => Promise<boolean>;
}

export interface DesktopAppInfo {
  name: string;
  versions: {
    chrome: string;
    electron: string;
    node: string;
  };
}

export interface DesktopApi {
  addFavorite: (input: FavoriteCreateRequest) => Promise<FavoriteListRecord>;
  executeCommand: (commandId: string) => Promise<LauncherCommandExecutionResult>;
  getAppInfo: () => DesktopAppInfo;
  hideLauncher: () => Promise<void>;
  listFavorites: () => Promise<FavoriteListRecord[]>;
  onFocusSearchInput: (listener: () => void) => () => void;
  pluginHost: PluginHostPreloadApi;
  removeFavorite: (id: string) => Promise<boolean>;
  searchCommands: (query: string) => Promise<LauncherCommandSearchResult[]>;
  updateFavorite: (
    id: string,
    input: FavoriteUpdateRequest,
  ) => Promise<FavoriteListRecord | undefined>;
}

const pluginBridgePreloadPath = join(__dirname, 'pluginBridge.cjs');

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }

  return value.trim();
}

function parsePluginHostEntryRequest(value: unknown): PluginHostEntryRequest {
  if (!isRecord(value)) {
    throw new Error('Invalid plugin host entry request must be an object.');
  }

  const request = {
    name: parseNonEmptyString(value.name, 'Plugin host entry name'),
    pluginId: parseNonEmptyString(value.pluginId, 'Plugin host entry plugin id'),
    pluginRoot: parseNonEmptyString(value.pluginRoot, 'Plugin host entry plugin root'),
    uiPath: parseNonEmptyString(value.uiPath, 'Plugin host entry UI path'),
  };

  return request;
}

function parsePluginHostEntry(value: unknown): PluginHostEntry {
  if (!isRecord(value)) {
    throw new Error('Invalid plugin host entry response must be an object.');
  }

  return {
    allowedBaseUrl: parseNonEmptyString(value.allowedBaseUrl, 'Plugin host entry allowed base URL'),
    entryUrl: parseNonEmptyString(value.entryUrl, 'Plugin host entry URL'),
    launchToken: parseNonEmptyString(value.launchToken, 'Plugin host launch token'),
    name: parseNonEmptyString(value.name, 'Plugin host entry name'),
    partition: parseNonEmptyString(value.partition, 'Plugin host partition'),
    pluginId: parseNonEmptyString(value.pluginId, 'Plugin host entry plugin id'),
  };
}

function parseBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean.`);
  }

  return value;
}

const desktopApi = {
  addFavorite: async (input) =>
    parseFavoriteRecord(
      await ipcRenderer.invoke(ADD_FAVORITE_CHANNEL, parseFavoriteCreateRequest(input)),
    ),
  executeCommand: async (commandId) =>
    parseLauncherCommandExecutionResult(
      await ipcRenderer.invoke(EXECUTE_COMMAND_CHANNEL, commandId),
    ),
  getAppInfo: () => ({
    name: 'CommandCabin',
    versions: {
      chrome: process.versions.chrome,
      electron: process.versions.electron,
      node: process.versions.node,
    },
  }),
  hideLauncher: () => ipcRenderer.invoke(HIDE_LAUNCHER_CHANNEL) as Promise<void>,
  listFavorites: async () => parseFavoriteRecords(await ipcRenderer.invoke(LIST_FAVORITES_CHANNEL)),
  onFocusSearchInput: (listener) => {
    const handleFocusSearchInput = () => {
      listener();
    };

    ipcRenderer.on(FOCUS_SEARCH_INPUT_CHANNEL, handleFocusSearchInput);

    return () => {
      ipcRenderer.removeListener(FOCUS_SEARCH_INPUT_CHANNEL, handleFocusSearchInput);
    };
  },
  pluginHost: {
    createEntry: async (input) =>
      parsePluginHostEntry(
        await ipcRenderer.invoke(
          REGISTER_PLUGIN_HOST_ENTRY_CHANNEL,
          parsePluginHostEntryRequest(input),
        ),
      ),
    getBridgeInfo: () => ({
      channel: PLUGIN_BRIDGE_CHANNEL,
      methods: PLUGIN_BRIDGE_METHODS,
    }),
    getPluginBridgePreloadPath: () => pluginBridgePreloadPath,
    releaseEntry: async (launchToken) =>
      parseBoolean(
        await ipcRenderer.invoke(
          RELEASE_PLUGIN_HOST_ENTRY_CHANNEL,
          parseNonEmptyString(launchToken, 'Plugin host launch token'),
        ),
        'Plugin host release entry response',
      ),
  },
  removeFavorite: async (id) =>
    parseFavoriteRemovalResult(
      await ipcRenderer.invoke(REMOVE_FAVORITE_CHANNEL, parseFavoriteId(id)),
    ),
  searchCommands: async (query) =>
    parseLauncherCommandSearchResults(await ipcRenderer.invoke(SEARCH_COMMANDS_CHANNEL, query)),
  updateFavorite: async (id, input) => {
    const updatedFavorite = await ipcRenderer.invoke(
      UPDATE_FAVORITE_CHANNEL,
      parseFavoriteId(id),
      parseFavoriteUpdateRequest(input),
    );

    return updatedFavorite === undefined ? undefined : parseFavoriteRecord(updatedFavorite);
  },
} satisfies DesktopApi;

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
