import type { BrowserWindowConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ReadyToShowListener = () => void;

class MockBrowserWindow {
  static instances: MockBrowserWindow[] = [];

  readonly loadFile = vi.fn();
  readonly loadURL = vi.fn();
  readonly show = vi.fn();
  readonly webContents = {
    on: vi.fn(),
  };

  private readyToShowListener?: ReadyToShowListener;

  constructor(readonly options: BrowserWindowConstructorOptions) {
    MockBrowserWindow.instances.push(this);
  }

  once(eventName: string, listener: ReadyToShowListener): this {
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

describe('createMainWindow', () => {
  beforeEach(() => {
    MockBrowserWindow.instances = [];
    vi.clearAllMocks();
  });

  it('creates a secure frameless always-on-top launcher window and loads the dev server', async () => {
    const { createMainWindow } = await import('./createMainWindow.js');

    const window = await createMainWindow({
      isPackaged: false,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
    });

    expect(MockBrowserWindow.instances).toHaveLength(1);
    expect(window).toBe(MockBrowserWindow.instances[0]);
    expect(MockBrowserWindow.instances[0]?.options).toMatchObject({
      width: 760,
      height: 520,
      minWidth: 760,
      minHeight: 520,
      maxWidth: 760,
      maxHeight: 520,
      show: false,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      maximizable: false,
      webPreferences: {
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        webviewTag: true,
        preload: 'C:\\CommandCabin\\dist\\preload\\index.js',
      },
    });
    expect(MockBrowserWindow.instances[0]?.loadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(MockBrowserWindow.instances[0]?.loadFile).not.toHaveBeenCalled();
    expect(MockBrowserWindow.instances[0]?.webContents.on).toHaveBeenCalledWith(
      'will-attach-webview',
      expect.any(Function),
    );

    MockBrowserWindow.instances[0]?.emitReadyToShow();

    expect(MockBrowserWindow.instances[0]?.show).toHaveBeenCalledOnce();
  });

  it('loads the built renderer HTML when no dev server URL is available', async () => {
    const { createMainWindow } = await import('./createMainWindow.js');

    await createMainWindow({
      isPackaged: false,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
    });

    expect(MockBrowserWindow.instances[0]?.loadFile).toHaveBeenCalledWith(
      'C:\\CommandCabin\\dist\\renderer\\index.html',
    );
    expect(MockBrowserWindow.instances[0]?.loadURL).not.toHaveBeenCalled();
  });

  it('keeps the window hidden on ready when requested for login startup', async () => {
    const { createMainWindow } = await import('./createMainWindow.js');

    await createMainWindow({
      isPackaged: false,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      showOnReady: false,
    });

    MockBrowserWindow.instances[0]?.emitReadyToShow();

    expect(MockBrowserWindow.instances[0]?.show).not.toHaveBeenCalled();
  });

  it('ignores a dev server URL in packaged mode', async () => {
    const { createMainWindow } = await import('./createMainWindow.js');

    await createMainWindow({
      isPackaged: true,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
    });

    expect(MockBrowserWindow.instances[0]?.loadFile).toHaveBeenCalledWith(
      'C:\\CommandCabin\\dist\\renderer\\index.html',
    );
    expect(MockBrowserWindow.instances[0]?.loadURL).not.toHaveBeenCalled();
  });

  it('rejects non-localhost dev server URLs', async () => {
    const { createMainWindow } = await import('./createMainWindow.js');

    await createMainWindow({
      isPackaged: false,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'https://example.com/launcher',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
    });

    expect(MockBrowserWindow.instances[0]?.loadFile).toHaveBeenCalledWith(
      'C:\\CommandCabin\\dist\\renderer\\index.html',
    );
    expect(MockBrowserWindow.instances[0]?.loadURL).not.toHaveBeenCalled();
  });
});
