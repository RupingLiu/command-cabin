import type { HotkeyInputCapturePayload } from '../../shared/hotkeyInputApi.js';
import { HOTKEY_INPUT_CAPTURE_CHANNEL } from '../../shared/ipcChannels.js';

export interface PreventableInputEvent {
  preventDefault: () => void;
}

export interface HotkeyInput {
  alt?: boolean;
  control?: boolean;
  key?: string;
  meta?: boolean;
  shift?: boolean;
  type?: string;
}

export interface HotkeyInputWebContents {
  on: (
    eventName: 'before-input-event',
    listener: (event: PreventableInputEvent, input: HotkeyInput) => void,
  ) => unknown;
  send: (channel: string, payload: HotkeyInputCapturePayload) => unknown;
}

function isSpaceKey(key: string | undefined): boolean {
  return key === ' ' || key === 'Space';
}

function createAltSpacePayload(input: HotkeyInput): HotkeyInputCapturePayload | undefined {
  if (input.type !== 'keyDown' || !input.alt || !isSpaceKey(input.key)) {
    return undefined;
  }

  return {
    altKey: true,
    ctrlKey: input.control === true,
    key: ' ',
    metaKey: input.meta === true,
    shiftKey: input.shift === true,
  };
}

export function attachHotkeyInputCapture(webContents: HotkeyInputWebContents): void {
  webContents.on('before-input-event', (event, input) => {
    const payload = createAltSpacePayload(input);

    if (!payload) {
      return;
    }

    event.preventDefault();
    webContents.send(HOTKEY_INPUT_CAPTURE_CHANNEL, payload);
  });
}
