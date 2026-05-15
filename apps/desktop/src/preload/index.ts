import { contextBridge } from 'electron';

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
} satisfies DesktopApi;

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
