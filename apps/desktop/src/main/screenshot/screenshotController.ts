import type {
  ScreenshotImageRequest,
  ScreenshotLaunchMode,
  ScreenshotLaunchState,
  ScreenshotOcrRequest,
  ScreenshotOcrResult,
  ScreenshotOperationResult,
  ScreenshotSaveImageRequest,
  ScreenshotSaveImageResult,
} from '../../shared/screenshotApi.js';
import {
  parseScreenshotCopyImageRequest,
  parseScreenshotLaunchMode,
  parseScreenshotOcrRequest,
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
  webContents: ScreenshotWebContents;
}

export interface CreateScreenshotControllerOptions {
  captureDisplays: () => Promise<ScreenshotDisplayCapture>;
  createOverlayWindow: (capture: ScreenshotDisplayCapture) => Promise<ScreenshotOverlayWindow>;
  hideLauncher: () => Promise<void> | void;
  pinImage: (request: ScreenshotImageRequest) => Promise<unknown> | unknown;
  runOcr: (request: ScreenshotOcrRequest) => Promise<ScreenshotOcrResult>;
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
    request: ScreenshotImageRequest,
  ) => Promise<ScreenshotOperationResult>;
  getLaunchState: (sender: ScreenshotWebContents) => ScreenshotLaunchState;
  pinImage: (sender: ScreenshotWebContents, request: ScreenshotImageRequest) => Promise<unknown>;
  runOcr: (
    sender: ScreenshotWebContents,
    request: ScreenshotOcrRequest,
  ) => Promise<ScreenshotOcrResult>;
  saveImage: (
    sender: ScreenshotWebContents,
    request: ScreenshotSaveImageRequest,
  ) => Promise<ScreenshotSaveImageResult>;
  start: (mode: ScreenshotLaunchMode) => Promise<ScreenshotLaunchState>;
}

interface ScreenshotOverlayState {
  launchState: ScreenshotLaunchState;
  window: ScreenshotOverlayWindow;
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

export function createScreenshotController({
  captureDisplays,
  createOverlayWindow,
  hideLauncher,
  pinImage,
  runOcr,
  showSaveDialog,
  writeClipboardImage,
  writeImageFile,
}: CreateScreenshotControllerOptions): ScreenshotController {
  const states = new Map<number, ScreenshotOverlayState>();

  const rememberState = (window: ScreenshotOverlayWindow, launchState: ScreenshotLaunchState) => {
    states.set(window.webContents.id, {
      launchState,
      window,
    });
  };

  return {
    cancel: (sender) => {
      const state = assertLiveState(states, sender);
      states.delete(sender.id);

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
    pinImage: async (sender, request) => {
      assertLiveState(states, sender);
      return pinImage(parseScreenshotPinImageRequest(request));
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
        await writeImageFile(saveResult.filePath, parsedRequest);
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
      const overlayWindow = await createOverlayWindow(capture);
      rememberState(overlayWindow, launchState);

      return launchState;
    },
  };
}
