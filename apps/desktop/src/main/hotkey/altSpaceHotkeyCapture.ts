import type { HotkeyInputCapturePayload } from '../../shared/hotkeyInputApi.js';
import { HOTKEY_INPUT_CAPTURE_CHANNEL } from '../../shared/ipcChannels.js';

const ALT_SPACE_ACCELERATOR = 'Alt+Space';
const ALT_SPACE_PAYLOAD: HotkeyInputCapturePayload = {
  altKey: true,
  ctrlKey: false,
  key: ' ',
  metaKey: false,
  shiftKey: false,
};

export interface AltSpaceHotkeyCaptureRegistry {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
}

export interface AltSpaceHotkeyCaptureSender {
  send: (channel: string, payload: HotkeyInputCapturePayload) => unknown;
}

export interface AltSpaceHotkeyCaptureController {
  start: (sender: AltSpaceHotkeyCaptureSender) => boolean;
  stop: () => void;
}

export interface CreateAltSpaceHotkeyCaptureControllerOptions {
  registry: AltSpaceHotkeyCaptureRegistry;
}

export function createAltSpaceHotkeyCaptureController({
  registry,
}: CreateAltSpaceHotkeyCaptureControllerOptions): AltSpaceHotkeyCaptureController {
  let isCapturing = false;

  const stop = (): void => {
    if (!isCapturing) {
      return;
    }

    registry.unregister(ALT_SPACE_ACCELERATOR);
    isCapturing = false;
  };

  return {
    start: (sender) => {
      stop();

      const registered = registry.register(ALT_SPACE_ACCELERATOR, () => {
        stop();
        sender.send(HOTKEY_INPUT_CAPTURE_CHANNEL, ALT_SPACE_PAYLOAD);
      });

      isCapturing = registered;

      return registered;
    },
    stop,
  };
}
