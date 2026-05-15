import { contextBridge, ipcRenderer } from 'electron';

import {
  EXECUTE_COMMAND_CHANNEL,
  FOCUS_SEARCH_INPUT_CHANNEL,
  HIDE_LAUNCHER_CHANNEL,
  SEARCH_COMMANDS_CHANNEL,
} from '../shared/ipcChannels.js';
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
  executeCommand: (commandId: string) => Promise<LauncherCommandExecutionResult>;
  getAppInfo: () => DesktopAppInfo;
  hideLauncher: () => Promise<void>;
  onFocusSearchInput: (listener: () => void) => () => void;
  searchCommands: (query: string) => Promise<LauncherCommandSearchResult[]>;
}

const desktopApi = {
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
  onFocusSearchInput: (listener) => {
    const handleFocusSearchInput = () => {
      listener();
    };

    ipcRenderer.on(FOCUS_SEARCH_INPUT_CHANNEL, handleFocusSearchInput);

    return () => {
      ipcRenderer.removeListener(FOCUS_SEARCH_INPUT_CHANNEL, handleFocusSearchInput);
    };
  },
  searchCommands: async (query) =>
    parseLauncherCommandSearchResults(await ipcRenderer.invoke(SEARCH_COMMANDS_CHANNEL, query)),
} satisfies DesktopApi;

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
