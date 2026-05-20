import { BrowserWindow, nativeImage } from 'electron';

import { resolveSafeRendererDevServerUrl } from './devServerUrl.js';

const MAX_PINNED_IMAGE_WIDTH = 960;
const MAX_PINNED_IMAGE_HEIGHT = 720;
const MIN_PINNED_IMAGE_WIDTH = 320;
const MIN_PINNED_IMAGE_HEIGHT = 240;

export interface CreatePinnedImageWindowOptions {
  imageDataUrl: string;
  isPackaged: boolean;
  preloadPath: string;
  rendererDevServerUrl?: string | undefined;
  rendererIndexPath: string;
  token: string;
}

function appendPinnedImageMode(rendererDevServerUrl: string, token: string): string {
  const url = new URL(rendererDevServerUrl);
  url.searchParams.set('mode', 'pinned-image');
  url.searchParams.set('token', token);

  return url.toString();
}

function resolvePinnedImageWindowSize(imageDataUrl: string): { height: number; width: number } {
  const { height, width } = nativeImage.createFromDataURL(imageDataUrl).getSize();

  if (height <= 0 || width <= 0) {
    return {
      height: MIN_PINNED_IMAGE_HEIGHT,
      width: MIN_PINNED_IMAGE_WIDTH,
    };
  }

  const scale = Math.min(1, MAX_PINNED_IMAGE_WIDTH / width, MAX_PINNED_IMAGE_HEIGHT / height);

  return {
    height: Math.max(MIN_PINNED_IMAGE_HEIGHT, Math.round(height * scale)),
    width: Math.max(MIN_PINNED_IMAGE_WIDTH, Math.round(width * scale)),
  };
}

export async function createPinnedImageWindow({
  imageDataUrl,
  isPackaged,
  preloadPath,
  rendererDevServerUrl,
  rendererIndexPath,
  token,
}: CreatePinnedImageWindowOptions): Promise<BrowserWindow> {
  const { height, width } = resolvePinnedImageWindowSize(imageDataUrl);
  const pinnedWindow = new BrowserWindow({
    width,
    height,
    minWidth: MIN_PINNED_IMAGE_WIDTH,
    minHeight: MIN_PINNED_IMAGE_HEIGHT,
    show: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: '#10110f',
    title: 'Pinned screenshot',
    webPreferences: {
      backgroundThrottling: false,
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  pinnedWindow.once('ready-to-show', () => {
    pinnedWindow.show();
  });

  const safeRendererDevServerUrl = resolveSafeRendererDevServerUrl({
    isPackaged,
    rendererDevServerUrl,
  });

  if (safeRendererDevServerUrl) {
    await pinnedWindow.loadURL(appendPinnedImageMode(safeRendererDevServerUrl, token));
  } else {
    await pinnedWindow.loadFile(rendererIndexPath, { query: { mode: 'pinned-image', token } });
  }

  return pinnedWindow;
}
