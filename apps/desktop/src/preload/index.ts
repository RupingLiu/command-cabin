import { contextBridge, ipcRenderer } from 'electron';

import {
  ADD_FAVORITE_CHANNEL,
  EXECUTE_COMMAND_CHANNEL,
  FOCUS_SEARCH_INPUT_CHANNEL,
  HIDE_LAUNCHER_CHANNEL,
  LIST_FAVORITES_CHANNEL,
  REMOVE_FAVORITE_CHANNEL,
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
  removeFavorite: (id: string) => Promise<boolean>;
  searchCommands: (query: string) => Promise<LauncherCommandSearchResult[]>;
  updateFavorite: (
    id: string,
    input: FavoriteUpdateRequest,
  ) => Promise<FavoriteListRecord | undefined>;
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
