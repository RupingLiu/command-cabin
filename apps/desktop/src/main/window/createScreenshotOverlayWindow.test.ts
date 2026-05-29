import type { BrowserWindowConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockBrowserWindow {
  static instances: MockBrowserWindow[] = [];

  readonly loadFile = vi.fn();
  readonly loadURL = vi.fn();
  readonly show = vi.fn();
  readonly webContents = { id: 7 };
  private readyToShowListener?: () => void;

  constructor(readonly options: BrowserWindowConstructorOptions) {
    MockBrowserWindow.instances.push(this);
  }

  once(eventName: string, listener: () => void): this {
    if (eventName === 'ready-to-show') {
      this.readyToShowListener = listener;
    }

    return this;
  }

  emitReadyToShow(): void {
    this.readyToShowListener?.();
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
        backgroundThrottling: false,
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

    MockBrowserWindow.instances[0]?.emitReadyToShow();

    expect(MockBrowserWindow.instances[0]?.show).toHaveBeenCalledOnce();
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

  it('can preload hidden until the caller explicitly shows it', async () => {
    const { createScreenshotOverlayWindow } = await import('./createScreenshotOverlayWindow.js');

    await createScreenshotOverlayWindow({
      isPackaged: true,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      showOnReady: false,
      virtualBounds: { height: 600, width: 800, x: 0, y: 0 },
    });

    MockBrowserWindow.instances[0]?.emitReadyToShow();

    expect(MockBrowserWindow.instances[0]?.show).not.toHaveBeenCalled();
  });

  it('can start from offscreen preload bounds before the caller moves it into place', async () => {
    const { createScreenshotOverlayWindow } = await import('./createScreenshotOverlayWindow.js');

    await createScreenshotOverlayWindow({
      initialBounds: { height: 1, width: 1, x: -32000, y: -32000 },
      isPackaged: true,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      showOnReady: false,
      virtualBounds: { height: 1080, width: 3360, x: -1440, y: 0 },
    });

    expect(MockBrowserWindow.instances[0]?.options).toMatchObject({
      height: 1,
      skipTaskbar: true,
      width: 1,
      x: -32000,
      y: -32000,
    });
  });

  it('reports the overlay window before renderer loading completes', async () => {
    const { createScreenshotOverlayWindow } = await import('./createScreenshotOverlayWindow.js');
    const onWindowCreated = vi.fn();

    await createScreenshotOverlayWindow({
      isPackaged: true,
      onWindowCreated,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      virtualBounds: { height: 600, width: 800, x: 0, y: 0 },
    });

    expect(onWindowCreated).toHaveBeenCalledWith(MockBrowserWindow.instances[0]);
    expect(onWindowCreated).toHaveBeenCalledBefore(MockBrowserWindow.instances[0]!.loadFile);
  });
});
