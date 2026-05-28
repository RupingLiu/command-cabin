import type { BrowserWindowConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  createFromDataURL: vi.fn(),
}));

class MockBrowserWindow {
  static instances: MockBrowserWindow[] = [];

  readonly loadFile = vi.fn();
  readonly loadURL = vi.fn();
  readonly show = vi.fn();
  readonly webContents = { id: 17 };
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
  nativeImage: {
    createFromDataURL: electronMock.createFromDataURL,
  },
}));

describe('createPinnedImageWindow', () => {
  beforeEach(() => {
    MockBrowserWindow.instances = [];
    electronMock.createFromDataURL.mockReset();
    electronMock.createFromDataURL.mockReturnValue({
      getSize: () => ({ height: 900, width: 1600 }),
    });
  });

  it('creates a frameless resizable always-on-top pinned image window bounded to image aspect ratio', async () => {
    const { createPinnedImageWindow } = await import('./createPinnedImageWindow.js');

    await createPinnedImageWindow({
      imageDataUrl: 'data:image/png;base64,AAAA',
      isPackaged: false,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      token: 'pin-token-1',
    });

    expect(MockBrowserWindow.instances[0]?.options).toMatchObject({
      alwaysOnTop: true,
      frame: false,
      height: 570,
      movable: true,
      resizable: true,
      show: false,
      skipTaskbar: true,
      transparent: false,
      webPreferences: {
        backgroundThrottling: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: 'C:\\CommandCabin\\dist\\preload\\index.js',
        sandbox: false,
      },
      width: 960,
    });
    expect(MockBrowserWindow.instances[0]?.loadURL).toHaveBeenCalledWith(
      'http://localhost:5173/?mode=pinned-image&token=pin-token-1',
    );

    MockBrowserWindow.instances[0]?.emitReadyToShow();

    expect(MockBrowserWindow.instances[0]?.show).toHaveBeenCalledOnce();
  });

  it('loads the packaged renderer with pinned image query parameters', async () => {
    const { createPinnedImageWindow } = await import('./createPinnedImageWindow.js');

    await createPinnedImageWindow({
      imageDataUrl: 'data:image/png;base64,AAAA',
      isPackaged: true,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      token: 'pin-token-2',
    });

    expect(MockBrowserWindow.instances[0]?.loadFile).toHaveBeenCalledWith(
      'C:\\CommandCabin\\dist\\renderer\\index.html',
      { query: { mode: 'pinned-image', token: 'pin-token-2' } },
    );
    expect(MockBrowserWindow.instances[0]?.loadURL).not.toHaveBeenCalled();
  });

  it('uses a minimum window size when image metadata is unavailable', async () => {
    electronMock.createFromDataURL.mockReturnValue({
      getSize: () => ({ height: 0, width: 0 }),
    });
    const { createPinnedImageWindow } = await import('./createPinnedImageWindow.js');

    await createPinnedImageWindow({
      imageDataUrl: 'data:image/png;base64,AAAA',
      isPackaged: false,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      token: 'pin-token-3',
    });

    expect(MockBrowserWindow.instances[0]?.options).toMatchObject({
      height: 270,
      width: 320,
    });
  });

  it('preserves aspect ratio for very wide pinned images without independently clamping height', async () => {
    electronMock.createFromDataURL.mockReturnValue({
      getSize: () => ({ height: 100, width: 2000 }),
    });
    const { createPinnedImageWindow } = await import('./createPinnedImageWindow.js');

    await createPinnedImageWindow({
      imageDataUrl: 'data:image/png;base64,AAAA',
      isPackaged: false,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      token: 'pin-token-wide',
    });

    expect(MockBrowserWindow.instances[0]?.options).toMatchObject({
      height: 78,
      minHeight: 78,
      minWidth: 320,
      width: 960,
    });
  });

  it('preserves aspect ratio for very tall pinned images without independently clamping width', async () => {
    electronMock.createFromDataURL.mockReturnValue({
      getSize: () => ({ height: 2000, width: 100 }),
    });
    const { createPinnedImageWindow } = await import('./createPinnedImageWindow.js');

    await createPinnedImageWindow({
      imageDataUrl: 'data:image/png;base64,AAAA',
      isPackaged: false,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      token: 'pin-token-tall',
    });

    expect(MockBrowserWindow.instances[0]?.options).toMatchObject({
      height: 750,
      minHeight: 270,
      minWidth: 36,
      width: 36,
    });
  });

  it('reports the pinned window before loading so state can be bound to its renderer', async () => {
    const onWindowCreated = vi.fn();
    const { createPinnedImageWindow } = await import('./createPinnedImageWindow.js');

    await createPinnedImageWindow({
      imageDataUrl: 'data:image/png;base64,AAAA',
      isPackaged: false,
      onWindowCreated,
      preloadPath: 'C:\\CommandCabin\\dist\\preload\\index.js',
      rendererDevServerUrl: 'http://localhost:5173',
      rendererIndexPath: 'C:\\CommandCabin\\dist\\renderer\\index.html',
      token: 'pin-token-created',
    });

    expect(onWindowCreated).toHaveBeenCalledWith(MockBrowserWindow.instances[0]);
    expect(onWindowCreated.mock.invocationCallOrder[0]).toBeLessThan(
      MockBrowserWindow.instances[0]!.loadURL.mock.invocationCallOrder[0]!,
    );
  });
});
