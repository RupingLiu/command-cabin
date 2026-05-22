import type {
  ScreenshotBounds,
  ScreenshotLaunchMode,
  ScreenshotLaunchState,
  ScreenshotOcrRequest,
  ScreenshotOcrResult,
  ScreenshotOperationResult,
  ScreenshotPinnedImageState,
  ScreenshotPinImageResult,
  ScreenshotSaveImageRequest,
  ScreenshotSaveImageResult,
} from '../../shared/screenshotApi.js';
import {
  parseScreenshotCopyImageRequest,
  parseScreenshotLaunchMode,
  parseScreenshotOcrRequest,
  parseScreenshotPinnedImageToken,
  parseScreenshotPinImageRequest,
  parseScreenshotSaveImageRequest,
} from '../../shared/screenshotApi.js';
import type { ScreenshotDisplayCapture } from './screenshotCapture.js';

export interface ScreenshotWebContents {
  id: number;
}

export interface ScreenshotOverlayWindow {
  close: () => void;
  hide?: () => void;
  isDestroyed?: () => boolean;
  off?: (eventName: 'closed', listener: () => void) => unknown;
  on: (eventName: 'closed', listener: () => void) => unknown;
  removeListener?: (eventName: 'closed', listener: () => void) => unknown;
  setBounds?: (bounds: ScreenshotBounds) => void;
  show?: () => void;
  webContents: ScreenshotWebContents;
}

export interface ScreenshotPinnedImageWindow {
  off?: (eventName: 'closed', listener: () => void) => unknown;
  on: (eventName: 'closed', listener: () => void) => unknown;
  removeListener?: (eventName: 'closed', listener: () => void) => unknown;
  webContents: ScreenshotWebContents;
}

export type RegisterScreenshotOverlayWindow = (window: ScreenshotOverlayWindow) => void;

export interface CreateScreenshotControllerOptions {
  captureDisplays: () => Promise<ScreenshotDisplayCapture>;
  createOverlayWindow: (
    virtualBounds: ScreenshotBounds,
    registerWindow: RegisterScreenshotOverlayWindow,
  ) => Promise<ScreenshotOverlayWindow>;
  createPinnedImageToken: () => string;
  getOverlayBounds: () => ScreenshotBounds;
  hideLauncher: () => Promise<void> | void;
  logger?: Pick<Console, 'info'> | undefined;
  notifyOverlayLaunchState: (
    window: ScreenshotOverlayWindow,
    launchState: ScreenshotLaunchState,
  ) => void;
  rendererReadyTimeoutMs?: number;
  pinImage: (
    request: ScreenshotPinnedImageState,
    registerWindow: (window: ScreenshotPinnedImageWindow) => void,
  ) => Promise<ScreenshotPinnedImageWindow> | ScreenshotPinnedImageWindow;
  runOcr: (request: ScreenshotOcrRequest) => Promise<ScreenshotOcrResult> | ScreenshotOcrResult;
  showSaveDialog: (
    request: ScreenshotSaveImageRequest,
  ) => Promise<ScreenshotSaveImageResult> | ScreenshotSaveImageResult;
  writeClipboardImage: (imageDataUrl: string) => Promise<void> | void;
  writeImageFile: (filePath: string, request: ScreenshotSaveImageRequest) => Promise<void> | void;
}

export interface ScreenshotController {
  cancel: (sender: ScreenshotWebContents) => boolean;
  copyImage: (
    sender: ScreenshotWebContents,
    request: unknown,
  ) => Promise<ScreenshotOperationResult>;
  getLaunchState: (sender: ScreenshotWebContents) => Promise<ScreenshotLaunchState>;
  getPinnedImageState: (
    sender: ScreenshotWebContents,
    token: unknown,
  ) => ScreenshotPinnedImageState;
  pinImage: (sender: ScreenshotWebContents, request: unknown) => Promise<ScreenshotPinImageResult>;
  markOverlayReady: (sender: ScreenshotWebContents) => boolean;
  prepare: () => Promise<void>;
  runOcr: (sender: ScreenshotWebContents, request: unknown) => Promise<ScreenshotOcrResult>;
  saveImage: (
    sender: ScreenshotWebContents,
    request: unknown,
  ) => Promise<ScreenshotSaveImageResult>;
  start: (mode: ScreenshotLaunchMode) => Promise<ScreenshotLaunchState>;
}

interface ScreenshotOverlayState {
  handleClosed: () => void;
  launchState: Promise<ScreenshotLaunchState>;
  window: ScreenshotOverlayWindow;
}

interface ScreenshotPinnedImageEntry {
  handleClosed: () => void;
  state: ScreenshotPinnedImageState;
  window: ScreenshotPinnedImageWindow;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

const delayByMode = new Map<ScreenshotLaunchMode, number>([
  ['capture-delay-3', 3000],
  ['capture-delay-5', 5000],
]);

const defaultRendererReadyTimeoutMs = 1500;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function assertLiveState(
  states: Map<number, ScreenshotOverlayState>,
  sender: ScreenshotWebContents,
): ScreenshotOverlayState {
  const state = states.get(sender.id);

  if (!state) {
    throw new Error('Unknown screenshot sender.');
  }

  return state;
}

function removeClosedListener(state: ScreenshotOverlayState): void {
  if (state.window.off) {
    state.window.off('closed', state.handleClosed);
    return;
  }

  state.window.removeListener?.('closed', state.handleClosed);
}

function removePinnedClosedListener(state: ScreenshotPinnedImageEntry): void {
  if (state.window.off) {
    state.window.off('closed', state.handleClosed);
    return;
  }

  state.window.removeListener?.('closed', state.handleClosed);
}

function isOverlayWindowLive(window: ScreenshotOverlayWindow): boolean {
  return window.isDestroyed?.() !== true;
}

function hideOverlayWindow(window: ScreenshotOverlayWindow): void {
  if (isOverlayWindowLive(window)) {
    window.hide?.();
  }
}

function deriveSaveFormatFromPath(
  filePath: string,
  fallbackFormat: ScreenshotSaveImageRequest['format'],
): ScreenshotSaveImageRequest['format'] {
  const extension = filePath.split('.').at(-1)?.toLowerCase();

  if (extension === 'png') {
    return 'png';
  }

  if (extension === 'jpg' || extension === 'jpeg') {
    return 'jpg';
  }

  return fallbackFormat;
}

export function createScreenshotController({
  captureDisplays,
  createOverlayWindow,
  createPinnedImageToken,
  getOverlayBounds,
  hideLauncher,
  logger = console,
  notifyOverlayLaunchState,
  rendererReadyTimeoutMs = defaultRendererReadyTimeoutMs,
  pinImage,
  runOcr,
  showSaveDialog,
  writeClipboardImage,
  writeImageFile,
}: CreateScreenshotControllerOptions): ScreenshotController {
  const states = new Map<number, ScreenshotOverlayState>();
  const pinnedImages = new Map<string, ScreenshotPinnedImageEntry>();
  let overlayWindow: ScreenshotOverlayWindow | undefined;
  let overlayWindowPromise: Promise<ScreenshotOverlayWindow> | undefined;
  let overlayWindowClosedListener: (() => void) | undefined;
  let startInProgress = false;
  let rendererReadyWaiter:
    | (Deferred<void> & {
        senderId: number;
        timeoutId: ReturnType<typeof setTimeout>;
      })
    | undefined;

  const rememberState = (
    window: ScreenshotOverlayWindow,
    launchState: Promise<ScreenshotLaunchState>,
  ) => {
    const previousState = states.get(window.webContents.id);

    if (previousState) {
      removeClosedListener(previousState);
    }

    const handleClosed = () => {
      states.delete(window.webContents.id);
    };
    const state: ScreenshotOverlayState = {
      handleClosed,
      launchState,
      window,
    };
    window.on('closed', handleClosed);
    states.set(window.webContents.id, state);
  };

  const forgetState = (window: ScreenshotOverlayWindow) => {
    const state = states.get(window.webContents.id);

    if (!state) {
      return;
    }

    states.delete(window.webContents.id);
    removeClosedListener(state);
  };

  const clearRendererReadyWaiter = (senderId: number, reason: Error) => {
    const readyWaiter = rendererReadyWaiter;

    if (!readyWaiter || readyWaiter.senderId !== senderId) {
      return;
    }

    rendererReadyWaiter = undefined;
    clearTimeout(readyWaiter.timeoutId);
    readyWaiter.reject(reason);
  };

  const rememberOverlayWindow = (window: ScreenshotOverlayWindow) => {
    if (overlayWindow?.webContents.id === window.webContents.id && isOverlayWindowLive(window)) {
      return;
    }

    if (overlayWindow && overlayWindowClosedListener) {
      if (overlayWindow.off) {
        overlayWindow.off('closed', overlayWindowClosedListener);
      } else {
        overlayWindow.removeListener?.('closed', overlayWindowClosedListener);
      }
    }

    const handleClosed = () => {
      if (overlayWindow?.webContents.id === window.webContents.id) {
        overlayWindow = undefined;
      }

      overlayWindowPromise = undefined;
      overlayWindowClosedListener = undefined;
      states.delete(window.webContents.id);
      clearRendererReadyWaiter(
        window.webContents.id,
        new Error('Screenshot overlay window closed before it was ready.'),
      );
    };

    overlayWindow = window;
    overlayWindowClosedListener = handleClosed;
    window.on('closed', handleClosed);
  };

  const ensureOverlayWindow = async () => {
    if (overlayWindow && isOverlayWindowLive(overlayWindow)) {
      return overlayWindow;
    }

    if (overlayWindowPromise) {
      return overlayWindowPromise;
    }

    const windowPromise = createOverlayWindow(getOverlayBounds(), rememberOverlayWindow)
      .then((window) => {
        rememberOverlayWindow(window);
        return window;
      })
      .catch((error: unknown) => {
        if (overlayWindowPromise === windowPromise) {
          overlayWindowPromise = undefined;
        }

        throw error;
      });

    overlayWindowPromise = windowPromise;

    return windowPromise;
  };

  const rememberPinnedImage = (
    token: string,
    state: ScreenshotPinnedImageState,
    window: ScreenshotPinnedImageWindow,
  ) => {
    const handleClosed = () => {
      pinnedImages.delete(token);
    };
    const entry = {
      handleClosed,
      state,
      window,
    };

    window.on('closed', handleClosed);
    pinnedImages.set(token, entry);
  };

  return {
    cancel: (sender) => {
      const state = assertLiveState(states, sender);
      forgetState(state.window);
      clearRendererReadyWaiter(sender.id, new Error('Screenshot capture was canceled.'));

      hideOverlayWindow(state.window);

      return true;
    },
    copyImage: async (sender, request) => {
      assertLiveState(states, sender);
      const parsedRequest = parseScreenshotCopyImageRequest(request);
      await writeClipboardImage(parsedRequest.imageDataUrl);

      return { ok: true };
    },
    getLaunchState: async (sender) => assertLiveState(states, sender).launchState,
    getPinnedImageState: (sender, token) => {
      const parsedToken = parseScreenshotPinnedImageToken(token);
      const entry = pinnedImages.get(parsedToken);

      if (!entry || entry.window.webContents.id !== sender.id) {
        throw new Error('Unknown pinned image token.');
      }

      pinnedImages.delete(parsedToken);
      removePinnedClosedListener(entry);

      return entry.state;
    },
    pinImage: async (sender, request) => {
      assertLiveState(states, sender);
      const parsedRequest = parseScreenshotPinImageRequest(request);
      const token = createPinnedImageToken();
      const pinnedState = {
        ...parsedRequest,
        token,
      };
      let windowRegistered = false;
      const registerWindow = (window: ScreenshotPinnedImageWindow) => {
        windowRegistered = true;
        rememberPinnedImage(token, pinnedState, window);
      };

      try {
        const pinnedWindow = await pinImage(pinnedState, registerWindow);

        if (!windowRegistered) {
          rememberPinnedImage(token, pinnedState, pinnedWindow);
        }
      } catch (error) {
        pinnedImages.delete(token);
        throw error;
      }

      return { id: token };
    },
    markOverlayReady: (sender) => {
      if (
        !overlayWindow ||
        overlayWindow.webContents.id !== sender.id ||
        !rendererReadyWaiter ||
        rendererReadyWaiter.senderId !== sender.id
      ) {
        return false;
      }

      const readyWaiter = rendererReadyWaiter;
      rendererReadyWaiter = undefined;
      clearTimeout(readyWaiter.timeoutId);
      readyWaiter.resolve(undefined);

      return true;
    },
    prepare: async () => {
      await ensureOverlayWindow();
    },
    runOcr: async (sender, request) => {
      assertLiveState(states, sender);
      return runOcr(parseScreenshotOcrRequest(request));
    },
    saveImage: async (sender, request) => {
      assertLiveState(states, sender);
      const parsedRequest = parseScreenshotSaveImageRequest(request);
      const saveResult = await showSaveDialog(parsedRequest);

      if (!saveResult.canceled && saveResult.filePath) {
        await writeImageFile(saveResult.filePath, {
          ...parsedRequest,
          format: deriveSaveFormatFromPath(saveResult.filePath, parsedRequest.format),
        });
      }

      return saveResult;
    },
    start: async (mode) => {
      if (startInProgress) {
        throw new Error('Screenshot capture is already starting.');
      }

      const launchMode = parseScreenshotLaunchMode(mode);
      const totalStartedAt = performance.now();
      startInProgress = true;

      let activeWindow: ScreenshotOverlayWindow | undefined;

      try {
        await hideLauncher();

        const delayMilliseconds = delayByMode.get(launchMode);

        if (delayMilliseconds !== undefined) {
          await delay(delayMilliseconds);
        }

        activeWindow = await ensureOverlayWindow();
        const readyWindow = activeWindow;

        const captureStartedAt = performance.now();
        const capture = await captureDisplays();
        const captureMs = performance.now() - captureStartedAt;
        const launchState: ScreenshotLaunchState = {
          ...capture,
          mode: launchMode,
        };
        rememberState(activeWindow, Promise.resolve(launchState));

        const readyWaiter = createDeferred<void>();
        void readyWaiter.promise.catch(() => undefined);
        const timeoutId = setTimeout(() => {
          clearRendererReadyWaiter(
            readyWindow.webContents.id,
            new Error('Screenshot overlay renderer ready timed out.'),
          );
        }, rendererReadyTimeoutMs);
        rendererReadyWaiter = {
          ...readyWaiter,
          senderId: activeWindow.webContents.id,
          timeoutId,
        };

        notifyOverlayLaunchState(activeWindow, launchState);

        const rendererReadyStartedAt = performance.now();
        await readyWaiter.promise;
        const rendererReadyMs = performance.now() - rendererReadyStartedAt;

        const showStartedAt = performance.now();
        activeWindow.setBounds?.(launchState.virtualBounds);
        activeWindow.show?.();
        const showMs = performance.now() - showStartedAt;

        logger.info('CommandCabin screenshot timing', {
          captureMs,
          rendererReadyMs,
          showMs,
          totalMs: performance.now() - totalStartedAt,
        });

        return launchState;
      } catch (error) {
        if (activeWindow) {
          forgetState(activeWindow);
          clearRendererReadyWaiter(activeWindow.webContents.id, error as Error);
          hideOverlayWindow(activeWindow);
        }

        throw error;
      } finally {
        startInProgress = false;
      }
    },
  };
}
