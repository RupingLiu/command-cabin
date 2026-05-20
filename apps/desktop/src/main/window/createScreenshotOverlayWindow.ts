import { BrowserWindow } from 'electron';

import type { ScreenshotBounds } from '../../shared/screenshotApi.js';
import { resolveSafeRendererDevServerUrl } from './devServerUrl.js';

export interface CreateScreenshotOverlayWindowOptions {
  isPackaged: boolean;
  preloadPath: string;
  rendererDevServerUrl?: string | undefined;
  rendererIndexPath: string;
  virtualBounds: ScreenshotBounds;
}

function appendScreenshotMode(rendererDevServerUrl: string): string {
  const url = new URL(rendererDevServerUrl);
  url.searchParams.set('mode', 'screenshot');

  return url.toString();
}

export async function createScreenshotOverlayWindow({
  isPackaged,
  preloadPath,
  rendererDevServerUrl,
  rendererIndexPath,
  virtualBounds,
}: CreateScreenshotOverlayWindowOptions): Promise<BrowserWindow> {
  const overlayWindow = new BrowserWindow({
    x: virtualBounds.x,
    y: virtualBounds.y,
    width: virtualBounds.width,
    height: virtualBounds.height,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false,
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
  });

  const safeRendererDevServerUrl = resolveSafeRendererDevServerUrl({
    isPackaged,
    rendererDevServerUrl,
  });

  if (safeRendererDevServerUrl) {
    await overlayWindow.loadURL(appendScreenshotMode(safeRendererDevServerUrl));
  } else {
    await overlayWindow.loadFile(rendererIndexPath, { query: { mode: 'screenshot' } });
  }

  return overlayWindow;
}
