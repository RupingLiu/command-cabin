import type {
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
  isDestroyed?: () => boolean;
  off?: (eventName: 'closed', listener: () => void) => unknown;
  on: (eventName: 'closed', listener: () => void) => unknown;
  removeListener?: (eventName: 'closed', listener: () => void) => unknown;
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
    capture: ScreenshotDisplayCapture,
    registerWindow: RegisterScreenshotOverlayWindow,
  ) => Promise<ScreenshotOverlayWindow>;
  createPinnedImageToken: () => string;
  hideLauncher: () => Promise<void> | void;
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
  getLaunchState: (sender: ScreenshotWebContents) => ScreenshotLaunchState;
  getPinnedImageState: (
    sender: ScreenshotWebContents,
    token: unknown,
  ) => ScreenshotPinnedImageState;
  pinImage: (sender: ScreenshotWebContents, request: unknown) => Promise<ScreenshotPinImageResult>;
  runOcr: (sender: ScreenshotWebContents, request: unknown) => Promise<ScreenshotOcrResult>;
  saveImage: (
    sender: ScreenshotWebContents,
    request: unknown,
  ) => Promise<ScreenshotSaveImageResult>;
  start: (mode: ScreenshotLaunchMode) => Promise<ScreenshotLaunchState>;
}

interface ScreenshotOverlayState {
  handleClosed: () => void;
  launchState: ScreenshotLaunchState;
  window: ScreenshotOverlayWindow;
}

interface ScreenshotPinnedImageEntry {
  handleClosed: () => void;
  state: ScreenshotPinnedImageState;
  window: ScreenshotPinnedImageWindow;
}

const delayByMode = new Map<ScreenshotLaunchMode, number>([
  ['capture-delay-3', 3000],
  ['capture-delay-5', 5000],
]);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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
  hideLauncher,
  pinImage,
  runOcr,
  showSaveDialog,
  writeClipboardImage,
  writeImageFile,
}: CreateScreenshotControllerOptions): ScreenshotController {
  const states = new Map<number, ScreenshotOverlayState>();
  const pinnedImages = new Map<string, ScreenshotPinnedImageEntry>();

  const rememberState = (window: ScreenshotOverlayWindow, launchState: ScreenshotLaunchState) => {
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

    if (!state.window.isDestroyed?.()) {
      state.window.close();
    }
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
      states.delete(sender.id);
      removeClosedListener(state);

      if (!state.window.isDestroyed?.()) {
        state.window.close();
      }

      return true;
    },
    copyImage: async (sender, request) => {
      assertLiveState(states, sender);
      const parsedRequest = parseScreenshotCopyImageRequest(request);
      await writeClipboardImage(parsedRequest.imageDataUrl);

      return { ok: true };
    },
    getLaunchState: (sender) => assertLiveState(states, sender).launchState,
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
      const launchMode = parseScreenshotLaunchMode(mode);
      await hideLauncher();

      const delayMilliseconds = delayByMode.get(launchMode);

      if (delayMilliseconds !== undefined) {
        await delay(delayMilliseconds);
      }

      const capture = await captureDisplays();
      const launchState: ScreenshotLaunchState = {
        ...capture,
        mode: launchMode,
      };
      let registeredWindow: ScreenshotOverlayWindow | undefined;
      const registerWindow = (window: ScreenshotOverlayWindow) => {
        if (registeredWindow) {
          return;
        }

        registeredWindow = window;
        rememberState(window, launchState);
      };

      try {
        const overlayWindow = await createOverlayWindow(capture, registerWindow);

        if (!registeredWindow) {
          rememberState(overlayWindow, launchState);
        }
      } catch (error) {
        if (registeredWindow) {
          forgetState(registeredWindow);
        }

        throw error;
      }

      return launchState;
    },
  };
}
