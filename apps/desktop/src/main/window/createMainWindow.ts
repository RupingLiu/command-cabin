import { BrowserWindow } from 'electron';

import { attachHotkeyInputCapture } from '../hotkey/hotkeyInputCapture.js';
import { resolveSafeRendererDevServerUrl } from './devServerUrl.js';
import {
  attachPluginWebviewGuard,
  createPluginWebviewPolicyStore,
  getPluginBridgePreloadPath,
  type PluginWebviewPolicyStore,
} from './webviewGuard.js';

const MAIN_WINDOW_WIDTH = 760;
const MAIN_WINDOW_HEIGHT = 520;

export interface CreateMainWindowOptions {
  isPackaged: boolean;
  preloadPath: string;
  rendererIndexPath: string;
  rendererDevServerUrl?: string | undefined;
  pluginWebviewPolicyStore?: PluginWebviewPolicyStore | undefined;
  showOnReady?: boolean | undefined;
}

export async function createMainWindow({
  isPackaged,
  preloadPath,
  pluginWebviewPolicyStore,
  rendererDevServerUrl,
  rendererIndexPath,
  showOnReady = true,
}: CreateMainWindowOptions): Promise<BrowserWindow> {
  const policyStore =
    pluginWebviewPolicyStore ??
    createPluginWebviewPolicyStore({
      expectedPreloadPath: getPluginBridgePreloadPath(preloadPath),
    });
  const mainWindow = new BrowserWindow({
    width: MAIN_WINDOW_WIDTH,
    height: MAIN_WINDOW_HEIGHT,
    minWidth: MAIN_WINDOW_WIDTH,
    minHeight: MAIN_WINDOW_HEIGHT,
    maxWidth: MAIN_WINDOW_WIDTH,
    maxHeight: MAIN_WINDOW_HEIGHT,
    show: false,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#11151c',
    title: 'CommandCabin',
    webPreferences: {
      backgroundThrottling: false,
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (showOnReady) {
      mainWindow.show();
    }
  });
  attachPluginWebviewGuard(mainWindow.webContents, {
    policyStore,
  });
  attachHotkeyInputCapture(mainWindow.webContents);

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
