import { contextBridge, ipcRenderer } from 'electron';
import { join } from 'node:path';

import {
  ADD_PINNED_APP_CANDIDATE_CHANNEL,
  ADD_PINNED_APP_CHANNEL,
  ADD_FAVORITE_CHANNEL,
  CLEAR_CLIPBOARD_HISTORY_CHANNEL,
  EXECUTE_COMMAND_CHANNEL,
  FOCUS_SEARCH_INPUT_CHANNEL,
  GET_DATA_DIRECTORY_CHANNEL,
  GET_SETTINGS_CHANNEL,
  HIDE_LAUNCHER_CHANNEL,
  HOTKEY_INPUT_CAPTURE_CHANNEL,
  INSTALL_PLUGIN_CHANNEL,
  LIST_APP_CANDIDATES_CHANNEL,
  LIST_FAVORITES_CHANNEL,
  LIST_PLUGINS_CHANNEL,
  OPEN_DATA_DIRECTORY_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  REMOVE_FAVORITE_CHANNEL,
  REMOVE_PLUGIN_CHANNEL,
  REGISTER_PLUGIN_HOST_ENTRY_CHANNEL,
  RELEASE_PLUGIN_HOST_ENTRY_CHANNEL,
  SEARCH_COMMANDS_CHANNEL,
  SET_PLUGIN_ENABLED_CHANNEL,
  START_HOTKEY_INPUT_CAPTURE_CHANNEL,
  STOP_HOTKEY_INPUT_CAPTURE_CHANNEL,
  UPDATE_FAVORITE_CHANNEL,
  UPDATE_PINNED_APP_CHANNEL,
  UPDATE_SETTINGS_CHANNEL,
} from '../shared/ipcChannels.js';
import {
  parseAppCandidateAddRequest,
  parseAppCandidates,
  type AppCandidate,
} from '../shared/appCandidatesApi.js';
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
  parseHotkeyInputCapturePayload,
  type HotkeyInputCapturePayload,
} from '../shared/hotkeyInputApi.js';
import {
  parseLauncherCommandExecutionResult,
  parseLauncherCommandSearchResults,
  type LauncherCommandExecutionResult,
  type LauncherCommandSearchResult,
} from '../shared/launcherApi.js';
import {
  parseDataDirectoryResponse,
  parsePluginInstallRequest,
  parsePluginRecord,
  parsePluginRecords,
  parsePluginRemovalResult,
  parseSettings,
  parseSettingsPatch,
  parseUpdatedPluginRecord,
  type DataDirectoryResponse,
  type PluginListRecord,
  type SettingsReadResponse,
  type SettingsUpdateRequest,
  type SettingsUpdateResponse,
} from '../shared/settingsApi.js';

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
  addPinnedApp: () => Promise<FavoriteListRecord | undefined>;
  addPinnedAppCandidate: (candidate: AppCandidate) => Promise<FavoriteListRecord>;
  clearClipboardHistory: () => Promise<number>;
  executeCommand: (commandId: string) => Promise<LauncherCommandExecutionResult>;
  getAppInfo: () => DesktopAppInfo;
  getDataDirectory: () => Promise<DataDirectoryResponse>;
  getSettings: () => Promise<SettingsReadResponse>;
  hideLauncher: () => Promise<void>;
  installPlugin: (pluginRoot: string) => Promise<PluginListRecord>;
  listAppCandidates: (query?: string | undefined) => Promise<AppCandidate[]>;
  listFavorites: () => Promise<FavoriteListRecord[]>;
  listPlugins: () => Promise<PluginListRecord[]>;
  onFocusSearchInput: (listener: () => void) => () => void;
  onHotkeyInputCapture: (listener: (payload: HotkeyInputCapturePayload) => void) => () => void;
  onOpenSettings: (listener: () => void) => () => void;
  openDataDirectory: () => Promise<DataDirectoryResponse>;
  pluginHost: PluginHostPreloadApi;
  removeFavorite: (id: string) => Promise<boolean>;
  removePlugin: (id: string) => Promise<boolean>;
  searchCommands: (query: string) => Promise<LauncherCommandSearchResult[]>;
  setPluginEnabled: (id: string, enabled: boolean) => Promise<PluginListRecord | undefined>;
  startHotkeyInputCapture: () => Promise<boolean>;
  stopHotkeyInputCapture: () => Promise<boolean>;
  updatePinnedApp: (id: string) => Promise<FavoriteListRecord | undefined>;
  updateFavorite: (
    id: string,
    input: FavoriteUpdateRequest,
  ) => Promise<FavoriteListRecord | undefined>;
  updateSettings: (patch: SettingsUpdateRequest) => Promise<SettingsUpdateResponse>;
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

function parseNonNegativeInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} must be a non-negative integer.`);
  }

  return value;
}

const desktopApi = {
  addFavorite: async (input) =>
    parseFavoriteRecord(
      await ipcRenderer.invoke(ADD_FAVORITE_CHANNEL, parseFavoriteCreateRequest(input)),
    ),
  addPinnedApp: async () => {
    const favorite = await ipcRenderer.invoke(ADD_PINNED_APP_CHANNEL);

    return favorite === undefined ? undefined : parseFavoriteRecord(favorite);
  },
  addPinnedAppCandidate: async (candidate) =>
    parseFavoriteRecord(
      await ipcRenderer.invoke(
        ADD_PINNED_APP_CANDIDATE_CHANNEL,
        parseAppCandidateAddRequest(candidate),
      ),
    ),
  clearClipboardHistory: async () =>
    parseNonNegativeInteger(
      await ipcRenderer.invoke(CLEAR_CLIPBOARD_HISTORY_CHANNEL),
      'Clipboard history clear response',
    ),
  executeCommand: async (commandId) =>
    parseLauncherCommandExecutionResult(
      await ipcRenderer.invoke(EXECUTE_COMMAND_CHANNEL, commandId),
    ),
  getDataDirectory: async () =>
    parseDataDirectoryResponse(await ipcRenderer.invoke(GET_DATA_DIRECTORY_CHANNEL)),
  getAppInfo: () => ({
    name: 'CommandCabin',
    versions: {
      chrome: process.versions.chrome,
      electron: process.versions.electron,
      node: process.versions.node,
    },
  }),
  getSettings: async () => parseSettings(await ipcRenderer.invoke(GET_SETTINGS_CHANNEL)),
  hideLauncher: () => ipcRenderer.invoke(HIDE_LAUNCHER_CHANNEL) as Promise<void>,
  installPlugin: async (pluginRoot) =>
    parsePluginRecord(
      await ipcRenderer.invoke(
        INSTALL_PLUGIN_CHANNEL,
        parsePluginInstallRequest(pluginRoot).pluginRoot,
      ),
    ),
  listAppCandidates: async (query = '') =>
    parseAppCandidates(await ipcRenderer.invoke(LIST_APP_CANDIDATES_CHANNEL, query)),
  listFavorites: async () => parseFavoriteRecords(await ipcRenderer.invoke(LIST_FAVORITES_CHANNEL)),
  listPlugins: async () => parsePluginRecords(await ipcRenderer.invoke(LIST_PLUGINS_CHANNEL)),
  onFocusSearchInput: (listener) => {
    const handleFocusSearchInput = () => {
      listener();
    };

    ipcRenderer.on(FOCUS_SEARCH_INPUT_CHANNEL, handleFocusSearchInput);

    return () => {
      ipcRenderer.removeListener(FOCUS_SEARCH_INPUT_CHANNEL, handleFocusSearchInput);
    };
  },
  onHotkeyInputCapture: (listener) => {
    const handleHotkeyInputCapture = (_event: unknown, payload: unknown) => {
      listener(parseHotkeyInputCapturePayload(payload));
    };

    ipcRenderer.on(HOTKEY_INPUT_CAPTURE_CHANNEL, handleHotkeyInputCapture);

    return () => {
      ipcRenderer.removeListener(HOTKEY_INPUT_CAPTURE_CHANNEL, handleHotkeyInputCapture);
    };
  },
  onOpenSettings: (listener) => {
    const handleOpenSettings = () => {
      listener();
    };

    ipcRenderer.on(OPEN_SETTINGS_CHANNEL, handleOpenSettings);

    return () => {
      ipcRenderer.removeListener(OPEN_SETTINGS_CHANNEL, handleOpenSettings);
    };
  },
  openDataDirectory: async () =>
    parseDataDirectoryResponse(await ipcRenderer.invoke(OPEN_DATA_DIRECTORY_CHANNEL)),
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
  removePlugin: async (id) =>
    parsePluginRemovalResult(
      await ipcRenderer.invoke(REMOVE_PLUGIN_CHANNEL, parseNonEmptyString(id, 'Plugin id')),
    ),
  searchCommands: async (query) =>
    parseLauncherCommandSearchResults(await ipcRenderer.invoke(SEARCH_COMMANDS_CHANNEL, query)),
  setPluginEnabled: async (id, enabled) =>
    parseUpdatedPluginRecord(
      await ipcRenderer.invoke(
        SET_PLUGIN_ENABLED_CHANNEL,
        parseNonEmptyString(id, 'Plugin id'),
        parseBoolean(enabled, 'Plugin enabled state'),
      ),
    ),
  startHotkeyInputCapture: async () =>
    parseBoolean(
      await ipcRenderer.invoke(START_HOTKEY_INPUT_CAPTURE_CHANNEL),
      'Hotkey input capture start response',
    ),
  stopHotkeyInputCapture: async () =>
    parseBoolean(
      await ipcRenderer.invoke(STOP_HOTKEY_INPUT_CAPTURE_CHANNEL),
      'Hotkey input capture stop response',
    ),
  updatePinnedApp: async (id) => {
    const updatedFavorite = await ipcRenderer.invoke(
      UPDATE_PINNED_APP_CHANNEL,
      parseFavoriteId(id),
    );

    return updatedFavorite === undefined ? undefined : parseFavoriteRecord(updatedFavorite);
  },
  updateFavorite: async (id, input) => {
    const updatedFavorite = await ipcRenderer.invoke(
      UPDATE_FAVORITE_CHANNEL,
      parseFavoriteId(id),
      parseFavoriteUpdateRequest(input),
    );

    return updatedFavorite === undefined ? undefined : parseFavoriteRecord(updatedFavorite);
  },
  updateSettings: async (patch) =>
    parseSettings(await ipcRenderer.invoke(UPDATE_SETTINGS_CHANNEL, parseSettingsPatch(patch))),
} satisfies DesktopApi;

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
