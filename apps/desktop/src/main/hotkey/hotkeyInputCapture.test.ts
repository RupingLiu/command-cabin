import { describe, expect, it, vi } from 'vitest';

import { HOTKEY_INPUT_CAPTURE_CHANNEL } from '../../shared/ipcChannels.js';
import { attachHotkeyInputCapture } from './hotkeyInputCapture.js';

describe('attachHotkeyInputCapture', () => {
  it('captures Alt+Space before Chromium opens the window system menu', () => {
    const preventDefault = vi.fn();
    const webContents = {
      on: vi.fn(),
      send: vi.fn(),
    };

    attachHotkeyInputCapture(webContents);

    const listener = webContents.on.mock.calls.find(
      ([eventName]) => eventName === 'before-input-event',
    )?.[1] as ((event: { preventDefault: () => void }, input: unknown) => void) | undefined;

    listener?.(
      { preventDefault },
      {
        alt: true,
        control: false,
        key: 'Space',
        meta: false,
        shift: false,
        type: 'keyDown',
      },
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(webContents.send).toHaveBeenCalledWith(HOTKEY_INPUT_CAPTURE_CHANNEL, {
      altKey: true,
      ctrlKey: false,
      key: ' ',
      metaKey: false,
      shiftKey: false,
    });
  });

  it('leaves regular shortcuts on the renderer keydown path', () => {
    const preventDefault = vi.fn();
    const webContents = {
      on: vi.fn(),
      send: vi.fn(),
    };

    attachHotkeyInputCapture(webContents);

    const listener = webContents.on.mock.calls.find(
      ([eventName]) => eventName === 'before-input-event',
    )?.[1] as ((event: { preventDefault: () => void }, input: unknown) => void) | undefined;

    listener?.(
      { preventDefault },
      {
        alt: true,
        control: true,
        key: 'K',
        meta: false,
        shift: false,
        type: 'keyDown',
      },
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(webContents.send).not.toHaveBeenCalled();
  });
});
