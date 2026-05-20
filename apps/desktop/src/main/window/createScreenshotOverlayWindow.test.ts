import type { BrowserWindowConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockBrowserWindow {
  static instances: MockBrowserWindow[] = [];

  readonly loadFile = vi.fn();
  readonly loadURL = vi.fn();
  readonly webContents = { id: 7 };

  constructor(readonly options: BrowserWindowConstructorOptions) {
    MockBrowserWindow.instances.push(this);
  }
}

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
}));

describe('createScreenshotOverlayWindow', () => {
  beforeEach(() => {
    MockBrowserWindow.instances = [];
    vi.clearAllMocks();
  });

  it('creates a transparent always-on-top overlay spanning virtual desktop bounds', async () => {
    const { createScreenshotOverlayWindow } = await import('./createScreenshotOverlayWindow.js');

    await createScreenshotOverlayWindow({
      isPackaged: false,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      virtualBounds: { height: 1080, width: 3360, x: -1440, y: 0 },
    });

    expect(MockBrowserWindow.instances[0]?.options).toMatchObject({
      alwaysOnTop: true,
      frame: false,
      height: 1080,
      resizable: false,
      show: false,
      transparent: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: 'C:\\CommandCabin\\dist\\preload\\index.js',
        sandbox: false,
      },
      width: 3360,
      x: -1440,
      y: 0,
    });
    expect(MockBrowserWindow.instances[0]?.loadURL).toHaveBeenCalledWith(
      'http://localhost:5173/?mode=screenshot',
    );
  });

  it('loads file renderer with a screenshot query when no safe dev server is available', async () => {
    const { createScreenshotOverlayWindow } = await import('./createScreenshotOverlayWindow.js');

    await createScreenshotOverlayWindow({
      isPackaged: true,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      virtualBounds: { height: 600, width: 800, x: 0, y: 0 },
    });

    expect(MockBrowserWindow.instances[0]?.loadFile).toHaveBeenCalledWith(
      'C:\\CommandCabin\\dist\\renderer\\index.html',
      { query: { mode: 'screenshot' } },
    );
    expect(MockBrowserWindow.instances[0]?.loadURL).not.toHaveBeenCalled();
  });
});
