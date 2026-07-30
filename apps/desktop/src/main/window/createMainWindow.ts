import { BrowserWindow } from 'electron';

import { attachHotkeyInputCapture } from '../hotkey/hotkeyInputCapture.js';
import { resolveSafeRendererDevServerUrl } from './devServerUrl.js';
import {
  attachPluginWebviewGuard,
  createPluginWebviewPolicyStore,
  getPluginBridgePreloadPath,
  type PluginWebviewPolicyStore,
} from './webviewGuard.js';
import { attachTrustedWindowPolicy, createWindowPreloadArguments } from './trustedWindowPolicy.js';

const MAIN_WINDOW_WIDTH = 760;
const MAIN_WINDOW_HEIGHT = 520;

export interface CreateMainWindowOptions {
  appVersion?: string | undefined;
  isPackaged: boolean;
  preloadPath: string;
  rendererIndexPath: string;
  rendererDevServerUrl?: string | undefined;
  pluginWebviewPolicyStore?: PluginWebviewPolicyStore | undefined;
  showOnReady?: boolean | undefined;
}

export async function createMainWindow({
  appVersion,
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
  const safeRendererDevServerUrl = resolveSafeRendererDevServerUrl({
    isPackaged,
    rendererDevServerUrl,
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
      additionalArguments: createWindowPreloadArguments({
        appVersion,
        pluginPreloadPath: policyStore.expectedPreloadPath,
        role: 'launcher',
      }),
      backgroundThrottling: true,
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
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
  attachTrustedWindowPolicy(mainWindow, {
    isPackaged,
    rendererDevServerUrl: safeRendererDevServerUrl,
    rendererIndexPath,
    role: 'launcher',
  });
  attachHotkeyInputCapture(mainWindow.webContents);

  try {
    if (safeRendererDevServerUrl) {
      await mainWindow.loadURL(safeRendererDevServerUrl);
    } else {
      await mainWindow.loadFile(rendererIndexPath);
    }
  } catch (error) {
    mainWindow.destroy();
    throw error;
  }

  return mainWindow;
}
