import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createScreenshotController } from './screenshotController.js';

const launchState = {
  displays: [
    {
      bounds: { height: 1080, width: 1920, x: 0, y: 0 },
      id: 1,
      imageDataUrl: 'data:image/png;base64,AAAA',
      scaleFactor: 1,
      sourceId: 'screen:1',
    },
  ],
  virtualBounds: { height: 1080, width: 1920, x: 0, y: 0 },
};

function createOverlayWindow(webContents: { id: number }) {
  let closedListener: (() => void) | undefined;

  return {
    close: vi.fn(),
    isDestroyed: () => false,
    off: vi.fn((_eventName: 'closed', listener: () => void) => {
      if (closedListener === listener) {
        closedListener = undefined;
      }
    }),
    on: vi.fn((_eventName: 'closed', listener: () => void) => {
      closedListener = listener;
    }),
    webContents,
    emitClosed: () => {
      closedListener?.();
    },
  };
}

function createPinnedWindow(webContents: { id: number }) {
  let closedListener: (() => void) | undefined;

  return {
    off: vi.fn((_eventName: 'closed', listener: () => void) => {
      if (closedListener === listener) {
        closedListener = undefined;
      }
    }),
    on: vi.fn((_eventName: 'closed', listener: () => void) => {
      closedListener = listener;
    }),
    webContents,
    emitClosed: () => {
      closedListener?.();
    },
  };
}

describe('createScreenshotController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('hides the launcher, captures displays, creates overlay, and returns launch state by sender', async () => {
    const overlayWebContents = { id: 42 };
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => ({
        close: vi.fn(),
        isDestroyed: () => false,
        on: vi.fn(),
        webContents: overlayWebContents,
      })),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.start('capture');

    expect(controller.getLaunchState(overlayWebContents)).toEqual({
      ...launchState,
      mode: 'capture',
    });
  });

  it('makes launch state available as soon as the overlay window is created', async () => {
    const overlayWindow = {
      close: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { id: 52 },
    };
    let resolveOverlayWindow: ((window: typeof overlayWindow) => void) | undefined;
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn((_capture, registerWindow) => {
        registerWindow(overlayWindow);
        expect(controller.getLaunchState(overlayWindow.webContents)).toEqual({
          ...launchState,
          mode: 'capture',
        });

        return new Promise<typeof overlayWindow>((resolve) => {
          resolveOverlayWindow = resolve;
        });
      }),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    const start = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);

    resolveOverlayWindow?.(overlayWindow);
    await start;
  });

  it('waits for delay modes before capture', async () => {
    const captureDisplays = vi.fn(async () => launchState);
    const controller = createScreenshotController({
      captureDisplays,
      createOverlayWindow: vi.fn(async () => ({
        close: vi.fn(),
        isDestroyed: () => false,
        on: vi.fn(),
        webContents: { id: 43 },
      })),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    const start = controller.start('capture-delay-3');
    await vi.advanceTimersByTimeAsync(2999);
    expect(captureDisplays).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await start;

    expect(captureDisplays).toHaveBeenCalledOnce();
  });

  it('rejects unknown senders for state and image operations', async () => {
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => ({
        close: vi.fn(),
        isDestroyed: () => false,
        on: vi.fn(),
        webContents: { id: 44 },
      })),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    expect(() => controller.getLaunchState({ id: 999 })).toThrow(/unknown screenshot sender/i);
    await expect(
      controller.copyImage({ id: 999 }, { imageDataUrl: 'data:image/png;base64,AAAA' }),
    ).rejects.toThrow(/unknown screenshot sender/i);
  });

  it('copies, saves, pins, runs OCR, and cancels for the owning sender', async () => {
    const overlayWindow = {
      close: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { id: 45 },
    };
    const writeClipboardImage = vi.fn();
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: 'C:\\capture.jpg' }));
    const writeImageFile = vi.fn();
    const pinnedWindow = createPinnedWindow({ id: 145 });
    const pinImage = vi.fn(async (_request, registerWindow) => {
      registerWindow(pinnedWindow);

      return pinnedWindow;
    });
    const runOcr = vi.fn(async () => ({
      language: 'en-US' as const,
      lines: ['hello'],
      status: 'success' as const,
      text: 'hello',
    }));
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      hideLauncher: vi.fn(),
      writeClipboardImage,
      showSaveDialog,
      writeImageFile,
      createPinnedImageToken: vi.fn(() => 'pin-1'),
      pinImage,
      runOcr,
    });

    await controller.start('ocr');
    await expect(
      controller.copyImage(overlayWindow.webContents, {
        imageDataUrl: 'data:image/png;base64,AAAA',
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      controller.saveImage(overlayWindow.webContents, {
        format: 'jpg',
        imageDataUrl: 'data:image/jpeg;base64,BBBB',
      }),
    ).resolves.toEqual({ canceled: false, filePath: 'C:\\capture.jpg' });
    await expect(
      controller.pinImage(overlayWindow.webContents, {
        imageDataUrl: 'data:image/png;base64,AAAA',
      }),
    ).resolves.toEqual({ id: 'pin-1' });
    expect(controller.getPinnedImageState(pinnedWindow.webContents, 'pin-1')).toEqual({
      imageDataUrl: 'data:image/png;base64,AAAA',
      token: 'pin-1',
    });
    expect(() => controller.getPinnedImageState(pinnedWindow.webContents, 'pin-1')).toThrow(
      /unknown pinned image/i,
    );
    await expect(
      controller.runOcr(overlayWindow.webContents, {
        imageDataUrl: 'data:image/png;base64,AAAA',
        language: 'en-US',
      }),
    ).resolves.toEqual({
      language: 'en-US',
      lines: ['hello'],
      status: 'success',
      text: 'hello',
    });
    expect(controller.cancel(overlayWindow.webContents)).toBe(true);

    expect(writeClipboardImage).toHaveBeenCalledWith('data:image/png;base64,AAAA');
    expect(writeImageFile).toHaveBeenCalledWith('C:\\capture.jpg', {
      format: 'jpg',
      imageDataUrl: 'data:image/jpeg;base64,BBBB',
    });
    expect(pinImage).toHaveBeenCalledWith(
      {
        imageDataUrl: 'data:image/png;base64,AAAA',
        token: 'pin-1',
      },
      expect.any(Function),
    );
    expect(overlayWindow.close).toHaveBeenCalledOnce();
  });

  it('rejects unknown pinned image tokens and senders', async () => {
    const overlayWindow = createOverlayWindow({ id: 48 });
    const pinnedWindow = createPinnedWindow({ id: 148 });
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-owned'),
      pinImage: vi.fn(async (_request, registerWindow) => {
        registerWindow(pinnedWindow);

        return pinnedWindow;
      }),
      runOcr: vi.fn(),
    });

    await controller.start('capture');
    await controller.pinImage(overlayWindow.webContents, {
      imageDataUrl: 'data:image/png;base64,AAAA',
    });

    expect(() => controller.getPinnedImageState(pinnedWindow.webContents, 'missing')).toThrow(
      /unknown pinned image/i,
    );
    expect(() => controller.getPinnedImageState({ id: 999 }, 'pin-owned')).toThrow(
      /unknown pinned image/i,
    );
  });

  it('cleans pinned image state when window creation fails or the pinned window closes', async () => {
    const overlayWindow = createOverlayWindow({ id: 49 });
    const controllerWithFailure = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-failed'),
      pinImage: vi.fn(async () => {
        throw new Error('window failed');
      }),
      runOcr: vi.fn(),
    });

    await controllerWithFailure.start('capture');
    await expect(
      controllerWithFailure.pinImage(overlayWindow.webContents, {
        imageDataUrl: 'data:image/png;base64,AAAA',
      }),
    ).rejects.toThrow(/window failed/i);
    expect(() => controllerWithFailure.getPinnedImageState({ id: 149 }, 'pin-failed')).toThrow(
      /unknown pinned image/i,
    );

    const pinnedWindow = createPinnedWindow({ id: 150 });
    const controllerWithClose = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-closed'),
      pinImage: vi.fn(async (_request, registerWindow) => {
        registerWindow(pinnedWindow);

        return pinnedWindow;
      }),
      runOcr: vi.fn(),
    });

    await controllerWithClose.start('capture');
    await controllerWithClose.pinImage(overlayWindow.webContents, {
      imageDataUrl: 'data:image/png;base64,AAAA',
    });
    pinnedWindow.emitClosed();

    expect(() =>
      controllerWithClose.getPinnedImageState(pinnedWindow.webContents, 'pin-closed'),
    ).toThrow(/unknown pinned image/i);
  });

  it('cleans launch state when the overlay closes without cancel', async () => {
    const overlayWindow = createOverlayWindow({ id: 46 });
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.start('capture');
    overlayWindow.emitClosed();

    expect(() => controller.getLaunchState(overlayWindow.webContents)).toThrow(
      /unknown screenshot sender/i,
    );
  });

  it('uses the selected file extension to choose the save encoding format', async () => {
    const overlayWindow = {
      close: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { id: 47 },
    };
    const writeImageFile = vi.fn();
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: 'C:\\capture.png' })),
      writeImageFile,
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.start('capture');
    await controller.saveImage(overlayWindow.webContents, {
      format: 'jpg',
      imageDataUrl: 'data:image/jpeg;base64,BBBB',
    });

    expect(writeImageFile).toHaveBeenCalledWith('C:\\capture.png', {
      format: 'png',
      imageDataUrl: 'data:image/jpeg;base64,BBBB',
    });
  });
});
