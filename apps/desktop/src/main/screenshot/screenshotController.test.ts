import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScreenshotController, ScreenshotOverlayWindow } from './screenshotController.js';
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

const overlayBounds = { height: 1080, width: 1920, x: 0, y: 0 };

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function createOverlayWindow(webContents: { id: number }) {
  let destroyed = false;
  const closedListeners = new Set<() => void>();
  const emitClosed = () => {
    if (destroyed) {
      return;
    }

    destroyed = true;

    for (const listener of closedListeners) {
      listener();
    }
  };

  return {
    close: vi.fn(emitClosed),
    hide: vi.fn(),
    isDestroyed: () => destroyed,
    off: vi.fn((_eventName: 'closed', listener: () => void) => {
      closedListeners.delete(listener);
    }),
    on: vi.fn((_eventName: 'closed', listener: () => void) => {
      closedListeners.add(listener);
    }),
    setBounds: vi.fn(),
    show: vi.fn(),
    get webContents() {
      if (destroyed) {
        throw new TypeError('Object has been destroyed');
      }

      return webContents;
    },
    emitClosed,
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

function createAutoReadyNotify(getController: () => ScreenshotController) {
  return vi.fn((window: ScreenshotOverlayWindow) => {
    getController().markOverlayReady(window.webContents);
  });
}

async function observePromise<T>(promise: Promise<T>) {
  const result:
    | { status: 'fulfilled'; value: T }
    | { reason: unknown; status: 'rejected' }
    | { status: 'pending' } = { status: 'pending' };
  const observed = { current: result };

  promise.then(
    (value) => {
      observed.current = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      observed.current = { reason, status: 'rejected' };
    },
  );
  await Promise.resolve();

  return observed.current;
}

describe('createScreenshotController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('hides the launcher, captures displays, creates overlay, and returns launch state by sender', async () => {
    const overlayWebContents = { id: 42 };
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => ({
        close: vi.fn(),
        isDestroyed: () => false,
        on: vi.fn(),
        webContents: overlayWebContents,
      })),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.start('capture');
    expect(notifyOverlayLaunchState).toHaveBeenCalledOnce();

    await expect(controller.getLaunchState(overlayWebContents)).resolves.toEqual({
      ...launchState,
      mode: 'capture',
    });
  });

  it('waits for the capture surface to settle after hiding a launcher window', async () => {
    const events: string[] = [];
    const overlayWindow = createOverlayWindow({ id: 51 });
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => {
        events.push('capture');
        return launchState;
      }),
      createOverlayWindow: vi.fn(async () => {
        events.push('overlay');
        return overlayWindow;
      }),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(async () => {
        events.push('hide');
        return true;
      }),
      notifyOverlayLaunchState,
      waitForCaptureSurface: vi.fn(async () => {
        events.push('settle');
      }),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.start('capture');

    expect(events).toEqual(['overlay', 'hide', 'settle', 'capture']);
  });

  it('does not wait for the capture surface when no launcher window was hidden', async () => {
    const overlayWindow = createOverlayWindow({ id: 50 });
    const waitForCaptureSurface = vi.fn();
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(async () => false),
      notifyOverlayLaunchState,
      waitForCaptureSurface,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.start('capture');

    expect(waitForCaptureSurface).not.toHaveBeenCalled();
  });

  it('rejects overlay launch state requests until capture state is concrete', async () => {
    const capture = createDeferred<typeof launchState>();
    const overlayWindow = createOverlayWindow({ id: 52 });
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(() => capture.promise),
      createOverlayWindow: vi.fn(async (_bounds, registerWindow) => {
        registerWindow(overlayWindow);

        return overlayWindow;
      }),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    const start = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);

    const launchStateRequest = await observePromise(
      controller.getLaunchState(overlayWindow.webContents),
    );
    expect(launchStateRequest.status).toBe('rejected');
    expect(launchStateRequest).toMatchObject({
      reason: expect.objectContaining({ message: 'Unknown screenshot sender.' }),
    });

    capture.resolve(launchState);
    await start;
    await expect(controller.getLaunchState(overlayWindow.webContents)).resolves.toEqual({
      ...launchState,
      mode: 'capture',
    });
  });

  it('starts loading the hidden overlay before screen capture finishes', async () => {
    const capture = createDeferred<typeof launchState>();
    const createOverlayWindow = vi.fn(async () => ({
      close: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn(),
      show: vi.fn(),
      webContents: { id: 53 },
    }));
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(() => capture.promise),
      createOverlayWindow,
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    const start = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);

    expect(createOverlayWindow).toHaveBeenCalledWith(overlayBounds, expect.any(Function));

    capture.resolve(launchState);
    await start;
  });

  it('captures after launcher hiding without waiting for slow overlay creation', async () => {
    const overlay = createDeferred<ScreenshotOverlayWindow>();
    const overlayWindow = createOverlayWindow({ id: 153 });
    const captureDisplays = vi.fn(async () => launchState);
    const notifyOverlayLaunchState = vi.fn();
    const controller = createScreenshotController({
      captureDisplays,
      createOverlayWindow: vi.fn(() => overlay.promise),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(() => false),
      notifyOverlayLaunchState,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    const start = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);

    expect(captureDisplays).toHaveBeenCalledOnce();
    expect((await observePromise(start)).status).toBe('pending');

    overlay.resolve(overlayWindow);
    await vi.advanceTimersByTimeAsync(0);

    expect(notifyOverlayLaunchState).toHaveBeenCalledWith(overlayWindow, {
      ...launchState,
      mode: 'capture',
    });
    expect(controller.markOverlayReady(overlayWindow.webContents)).toBe(true);
    await start;
  });

  it('keeps the preloaded overlay hidden until capture state is ready', async () => {
    const capture = createDeferred<typeof launchState>();
    const overlayWindow = {
      close: vi.fn(),
      hide: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn(),
      setBounds: vi.fn(),
      show: vi.fn(),
      webContents: { id: 54 },
    };
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(() => capture.promise),
      createOverlayWindow: vi.fn(async (_bounds, registerWindow) => {
        registerWindow(overlayWindow);
        return overlayWindow;
      }),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    const start = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);

    expect(overlayWindow.show).not.toHaveBeenCalled();

    capture.resolve(launchState);
    await start;

    expect(overlayWindow.setBounds).toHaveBeenCalledWith(launchState.virtualBounds);
    expect(overlayWindow.setBounds).toHaveBeenCalledBefore(overlayWindow.show);
    expect(overlayWindow.show).toHaveBeenCalledOnce();
  });

  it('preloads a fresh hidden overlay after the active capture closes', async () => {
    const firstOverlayWindow = createOverlayWindow({ id: 55 });
    const secondOverlayWindow = createOverlayWindow({ id: 56 });
    const createOverlayWindowSpy = vi
      .fn()
      .mockResolvedValueOnce(firstOverlayWindow)
      .mockResolvedValueOnce(secondOverlayWindow);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: createOverlayWindowSpy,
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.prepare();

    const firstStart = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.markOverlayReady(firstOverlayWindow.webContents)).toBe(true);
    await firstStart;

    await expect(controller.start('capture')).rejects.toThrow(/already/i);
    expect(controller.cancel(firstOverlayWindow.webContents)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    const secondStart = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.markOverlayReady(secondOverlayWindow.webContents)).toBe(true);
    await secondStart;

    expect(createOverlayWindowSpy).toHaveBeenCalledTimes(2);
  });

  it('shows the prepared overlay as soon as capture state is available', async () => {
    const overlayWindow = createOverlayWindow({ id: 56 });
    const notifyOverlayLaunchState = vi.fn();
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.prepare();
    const start = controller.start('capture');
    let startSettled = false;
    void start.finally(() => {
      startSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(notifyOverlayLaunchState).toHaveBeenCalledWith(overlayWindow, {
      ...launchState,
      mode: 'capture',
    });
    expect(startSettled).toBe(true);
    expect(overlayWindow.setBounds).toHaveBeenCalledWith(launchState.virtualBounds);
    expect(overlayWindow.setBounds).toHaveBeenCalledBefore(overlayWindow.show);
    expect(overlayWindow.show).toHaveBeenCalledOnce();
    await start;

    expect(controller.markOverlayReady(overlayWindow.webContents)).toBe(true);
  });

  it('logs successful screenshot timing when the overlay is shown', async () => {
    const overlayWindow = createOverlayWindow({ id: 60 });
    const logger = { info: vi.fn() };
    const notifyOverlayLaunchState = vi.fn();
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      logger,
      notifyOverlayLaunchState,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    const start = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);
    await start;

    expect(logger.info).toHaveBeenCalledWith('CommandCabin screenshot timing', {
      captureMs: expect.any(Number),
      rendererReadyMs: expect.any(Number),
      showMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    expect(logger.info).toHaveBeenCalledAfter(overlayWindow.show);

    expect(controller.markOverlayReady(overlayWindow.webContents)).toBe(true);
  });

  it('rejects a second start while the first capture is waiting for overlay readiness', async () => {
    const overlayWindow = createOverlayWindow({ id: 156 });
    const notifyOverlayLaunchState = vi.fn();
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    const firstStart = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);
    expect(notifyOverlayLaunchState).toHaveBeenCalledOnce();

    const secondStart = controller.start('capture');
    void secondStart.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    const secondResult = await observePromise(secondStart);
    expect(secondResult.status).toBe('rejected');
    expect(secondResult).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringMatching(/already/i) }),
    });

    expect(controller.markOverlayReady(overlayWindow.webContents)).toBe(true);
    await expect(firstStart).resolves.toEqual({
      ...launchState,
      mode: 'capture',
    });
  });

  it('keeps the visible overlay active when renderer readiness times out', async () => {
    const firstOverlayWindow = createOverlayWindow({ id: 157 });
    const createOverlayWindowSpy = vi.fn().mockResolvedValue(firstOverlayWindow);
    const notifyOverlayLaunchState = vi.fn();
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: createOverlayWindowSpy,
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
      rendererReadyTimeoutMs: 25,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    const start = controller.start('capture');
    void start.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(notifyOverlayLaunchState).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(25);

    const timeoutResult = await observePromise(start);
    expect(timeoutResult.status).toBe('fulfilled');
    expect(firstOverlayWindow.close).not.toHaveBeenCalled();
    expect(firstOverlayWindow.hide).not.toHaveBeenCalled();
    await expect(controller.getLaunchState(firstOverlayWindow.webContents)).resolves.toEqual({
      ...launchState,
      mode: 'capture',
    });
    await expect(controller.start('capture')).rejects.toThrow(/already/i);
    expect(createOverlayWindowSpy).toHaveBeenCalledOnce();
  });

  it('returns false when overlay ready arrives from wrong, stale, or missing waiters', async () => {
    const firstOverlayWindow = createOverlayWindow({ id: 256 });
    const secondOverlayWindow = createOverlayWindow({ id: 257 });
    let registerOverlayWindow: ((window: ScreenshotOverlayWindow) => void) | undefined;
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async (_bounds, registerWindow) => {
        registerOverlayWindow = registerWindow;

        return firstOverlayWindow;
      }),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.prepare();
    expect(controller.markOverlayReady(firstOverlayWindow.webContents)).toBe(false);

    const start = controller.start('capture');
    void start.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.markOverlayReady({ id: 999 })).toBe(false);

    registerOverlayWindow?.(secondOverlayWindow);
    expect(controller.markOverlayReady(secondOverlayWindow.webContents)).toBe(false);

    expect(controller.cancel(firstOverlayWindow.webContents)).toBe(true);
    await expect(start).resolves.toEqual({
      ...launchState,
      mode: 'capture',
    });
  });

  it('closes the overlay on cancel so the hidden renderer can release memory', async () => {
    const overlayWindow = createOverlayWindow({ id: 57 });
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    const start = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.markOverlayReady(overlayWindow.webContents)).toBe(true);
    await start;

    expect(controller.cancel(overlayWindow.webContents)).toBe(true);

    expect(overlayWindow.close).toHaveBeenCalledOnce();
    expect(overlayWindow.hide).not.toHaveBeenCalled();
  });

  it('recreates the overlay after the persistent window closes', async () => {
    const firstOverlayWindow = createOverlayWindow({ id: 58 });
    const secondOverlayWindow = createOverlayWindow({ id: 59 });
    const createOverlayWindowSpy = vi
      .fn()
      .mockResolvedValueOnce(firstOverlayWindow)
      .mockResolvedValueOnce(secondOverlayWindow);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: createOverlayWindowSpy,
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.prepare();
    firstOverlayWindow.emitClosed();
    await controller.prepare();

    const start = controller.start('capture');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.markOverlayReady(secondOverlayWindow.webContents)).toBe(true);
    await start;

    expect(createOverlayWindowSpy).toHaveBeenCalledTimes(2);
    expect(secondOverlayWindow.show).toHaveBeenCalledOnce();
  });

  it('waits for delay modes before capture', async () => {
    const captureDisplays = vi.fn(async () => launchState);
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays,
      createOverlayWindow: vi.fn(async () => ({
        close: vi.fn(),
        isDestroyed: () => false,
        on: vi.fn(),
        webContents: { id: 43 },
      })),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
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
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState: vi.fn(),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await expect(controller.getLaunchState({ id: 999 })).rejects.toThrow(
      /unknown screenshot sender/i,
    );
    await expect(
      controller.copyImage({ id: 999 }, { imageDataUrl: 'data:image/png;base64,AAAA' }),
    ).rejects.toThrow(/unknown screenshot sender/i);
  });

  it('copies, saves, pins, runs OCR, and cancels for the owning sender', async () => {
    const overlayWindow = {
      close: vi.fn(),
      hide: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { id: 45 },
      show: vi.fn(),
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
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
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
    expect(overlayWindow.hide).not.toHaveBeenCalled();
  });

  it('rejects unknown pinned image tokens and senders', async () => {
    const overlayWindow = createOverlayWindow({ id: 48 });
    const pinnedWindow = createPinnedWindow({ id: 148 });
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
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
    const failureNotifyOverlayLaunchState = createAutoReadyNotify(() => controllerWithFailure);
    const controllerWithFailure = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState: failureNotifyOverlayLaunchState,
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
    const closeNotifyOverlayLaunchState = createAutoReadyNotify(() => controllerWithClose);
    const controllerWithClose = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState: closeNotifyOverlayLaunchState,
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
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(),
      writeImageFile: vi.fn(),
      createPinnedImageToken: vi.fn(() => 'pin-unused'),
      pinImage: vi.fn(),
      runOcr: vi.fn(),
    });

    await controller.start('capture');
    const overlaySender = overlayWindow.webContents;
    overlayWindow.emitClosed();

    await expect(controller.getLaunchState(overlaySender)).rejects.toThrow(
      /unknown screenshot sender/i,
    );
  });

  it('uses the selected file extension to choose the save encoding format', async () => {
    const overlayWindow = {
      close: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { id: 47 },
      show: vi.fn(),
    };
    const writeImageFile = vi.fn();
    const notifyOverlayLaunchState = createAutoReadyNotify(() => controller);
    const controller = createScreenshotController({
      captureDisplays: vi.fn(async () => launchState),
      createOverlayWindow: vi.fn(async () => overlayWindow),
      getOverlayBounds: vi.fn(() => overlayBounds),
      hideLauncher: vi.fn(),
      notifyOverlayLaunchState,
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
