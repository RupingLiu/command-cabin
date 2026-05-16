import { BrowserWindow } from 'electron';

import { resolveSafeRendererDevServerUrl } from './devServerUrl.js';
import {
  attachPluginWebviewGuard,
  createPluginWebviewPolicyStore,
  getPluginBridgePreloadPath,
  type PluginWebviewPolicyStore,
} from './webviewGuard.js';

export interface CreateMainWindowOptions {
  isPackaged: boolean;
  preloadPath: string;
  rendererIndexPath: string;
  rendererDevServerUrl?: string | undefined;
  pluginWebviewPolicyStore?: PluginWebviewPolicyStore | undefined;
}

export async function createMainWindow({
  isPackaged,
  preloadPath,
  pluginWebviewPolicyStore,
  rendererDevServerUrl,
  rendererIndexPath,
}: CreateMainWindowOptions): Promise<BrowserWindow> {
  const policyStore =
    pluginWebviewPolicyStore ??
    createPluginWebviewPolicyStore({
      expectedPreloadPath: getPluginBridgePreloadPath(preloadPath),
    });
  const mainWindow = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 560,
    minHeight: 360,
    show: false,
    frame: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: '#11151c',
    title: 'CommandCabin',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  attachPluginWebviewGuard(mainWindow.webContents, {
    policyStore,
  });

  const safeRendererDevServerUrl = resolveSafeRendererDevServerUrl({
    isPackaged,
    rendererDevServerUrl,
  });

  if (safeRendererDevServerUrl) {
    await mainWindow.loadURL(safeRendererDevServerUrl);
  } else {
    await mainWindow.loadFile(rendererIndexPath);
  }

  return mainWindow;
}
