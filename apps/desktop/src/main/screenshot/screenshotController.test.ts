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
        webContents: overlayWebContents,
      })),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.start('capture');

    expect(controller.getLaunchState(overlayWebContents)).toEqual({
      ...launchState,
      mode: 'capture',
    });
  });

  it('waits for delay modes before capture', async () => {
    const captureDisplays = vi.fn(async () => launchState);
    const controller = createScreenshotController({
      captureDisplays,
      createOverlayWindow: vi.fn(async () => ({
        close: vi.fn(),
        isDestroyed: () => false,
        webContents: { id: 43 },
      })),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
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
        webContents: { id: 44 },
      })),
      hideLauncher: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
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
      webContents: { id: 45 },
    };
    const writeClipboardImage = vi.fn();
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: 'C:\\capture.jpg' }));
    const writeImageFile = vi.fn();
    const pinImage = vi.fn(async () => ({ id: 'pin-1' }));
    const runOcr = vi.fn(async () => ({ language: 'en-US' as const, text: 'hello' }));
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      hideLauncher: vi.fn(),
      writeClipboardImage,
      showSaveDialog,
      writeImageFile,
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
    await expect(
      controller.runOcr(overlayWindow.webContents, {
        imageDataUrl: 'data:image/png;base64,AAAA',
        language: 'en-US',
      }),
    ).resolves.toEqual({ language: 'en-US', text: 'hello' });
    expect(controller.cancel(overlayWindow.webContents)).toBe(true);

    expect(writeClipboardImage).toHaveBeenCalledWith('data:image/png;base64,AAAA');
    expect(writeImageFile).toHaveBeenCalledWith('C:\\capture.jpg', {
      format: 'jpg',
      imageDataUrl: 'data:image/jpeg;base64,BBBB',
    });
    expect(overlayWindow.close).toHaveBeenCalledOnce();
  });
});
