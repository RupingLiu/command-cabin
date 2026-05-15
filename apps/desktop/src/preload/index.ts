import { contextBridge, ipcRenderer } from 'electron';

import { FOCUS_SEARCH_INPUT_CHANNEL } from '../shared/ipcChannels.js';

export interface DesktopAppInfo {
  name: string;
  versions: {
    chrome: string;
    electron: string;
    node: string;
  };
}

export interface DesktopApi {
  getAppInfo: () => DesktopAppInfo;
  onFocusSearchInput: (listener: () => void) => () => void;
}

const desktopApi = {
  getAppInfo: () => ({
    name: 'CommandCabin',
    versions: {
      chrome: process.versions.chrome,
      electron: process.versions.electron,
      node: process.versions.node,
    },
  }),
  onFocusSearchInput: (listener) => {
    const handleFocusSearchInput = () => {
      listener();
    };

    ipcRenderer.on(FOCUS_SEARCH_INPUT_CHANNEL, handleFocusSearchInput);

    return () => {
      ipcRenderer.removeListener(FOCUS_SEARCH_INPUT_CHANNEL, handleFocusSearchInput);
    };
  },
} satisfies DesktopApi;

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
