import { BrowserWindow } from 'electron';

import { resolveSafeRendererDevServerUrl } from './devServerUrl.js';

export interface CreateMainWindowOptions {
  isPackaged: boolean;
  preloadPath: string;
  rendererIndexPath: string;
  rendererDevServerUrl?: string | undefined;
}

export async function createMainWindow({
  isPackaged,
  preloadPath,
  rendererDevServerUrl,
  rendererIndexPath,
}: CreateMainWindowOptions): Promise<BrowserWindow> {
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
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
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
