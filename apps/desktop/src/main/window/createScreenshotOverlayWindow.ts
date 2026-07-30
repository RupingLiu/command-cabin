import { BrowserWindow } from 'electron';

import type { ScreenshotBounds } from '../../shared/screenshotApi.js';
import { resolveSafeRendererDevServerUrl } from './devServerUrl.js';
import { attachTrustedWindowPolicy, createWindowPreloadArguments } from './trustedWindowPolicy.js';

export interface CreateScreenshotOverlayWindowOptions {
  appVersion?: string | undefined;
  isPackaged: boolean;
  onWindowCreated?: ((window: BrowserWindow) => void) | undefined;
  initialBounds?: ScreenshotBounds | undefined;
  preloadPath: string;
  rendererDevServerUrl?: string | undefined;
  rendererIndexPath: string;
  showOnReady?: boolean | undefined;
  virtualBounds: ScreenshotBounds;
}

function appendScreenshotMode(rendererDevServerUrl: string): string {
  const url = new URL(rendererDevServerUrl);
  url.searchParams.set('mode', 'screenshot');

  return url.toString();
}

export async function createScreenshotOverlayWindow({
  appVersion,
  isPackaged,
  initialBounds,
  onWindowCreated,
  preloadPath,
  rendererDevServerUrl,
  rendererIndexPath,
  showOnReady = true,
  virtualBounds,
}: CreateScreenshotOverlayWindowOptions): Promise<BrowserWindow> {
  const windowBounds = initialBounds ?? virtualBounds;
  const safeRendererDevServerUrl = resolveSafeRendererDevServerUrl({
    isPackaged,
    rendererDevServerUrl,
  });
  const overlayWindow = new BrowserWindow({
    x: windowBounds.x,
    y: windowBounds.y,
    width: windowBounds.width,
    height: windowBounds.height,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: {
      additionalArguments: createWindowPreloadArguments({
        appVersion,
        role: 'screenshot',
      }),
      backgroundThrottling: false,
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  overlayWindow.once('ready-to-show', () => {
    if (showOnReady) {
      overlayWindow.show();
    }
  });
  onWindowCreated?.(overlayWindow);
  attachTrustedWindowPolicy(overlayWindow, {
    isPackaged,
    rendererDevServerUrl: safeRendererDevServerUrl,
    rendererIndexPath,
    role: 'screenshot',
  });

  try {
    if (safeRendererDevServerUrl) {
      await overlayWindow.loadURL(appendScreenshotMode(safeRendererDevServerUrl));
    } else {
      await overlayWindow.loadFile(rendererIndexPath, { query: { mode: 'screenshot' } });
    }
  } catch (error) {
    overlayWindow.destroy();
    throw error;
  }

  return overlayWindow;
}
