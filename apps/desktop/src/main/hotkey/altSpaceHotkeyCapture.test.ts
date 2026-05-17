import { describe, expect, it, vi } from 'vitest';

import { HOTKEY_INPUT_CAPTURE_CHANNEL } from '../../shared/ipcChannels.js';
import { createAltSpaceHotkeyCaptureController } from './altSpaceHotkeyCapture.js';

describe('createAltSpaceHotkeyCaptureController', () => {
  it('temporarily captures Alt+Space and releases it before notifying the renderer', () => {
    let capturedCallback: (() => void) | undefined;
    const registry = {
      register: vi.fn((_accelerator: string, callback: () => void) => {
        capturedCallback = callback;
        return true;
      }),
      unregister: vi.fn(),
    };
    const sender = {
      send: vi.fn(),
    };
    const controller = createAltSpaceHotkeyCaptureController({ registry });

    expect(controller.start(sender)).toBe(true);
    capturedCallback?.();

    expect(registry.register).toHaveBeenCalledWith('Alt+Space', expect.any(Function));
    expect(registry.unregister).toHaveBeenCalledWith('Alt+Space');
    expect(sender.send).toHaveBeenCalledWith(HOTKEY_INPUT_CAPTURE_CHANNEL, {
      altKey: true,
      ctrlKey: false,
      key: ' ',
      metaKey: false,
      shiftKey: false,
    });
    expect(registry.unregister.mock.invocationCallOrder[0]).toBeLessThan(
      sender.send.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('does not keep stale capture registrations when restarted or stopped', () => {
    const registry = {
      register: vi.fn(() => true),
      unregister: vi.fn(),
    };
    const sender = {
      send: vi.fn(),
    };
    const controller = createAltSpaceHotkeyCaptureController({ registry });

    controller.start(sender);
    controller.start(sender);
    controller.stop();
    controller.stop();

    expect(registry.register).toHaveBeenCalledTimes(2);
    expect(registry.unregister).toHaveBeenCalledTimes(2);
    expect(registry.unregister).toHaveBeenNthCalledWith(1, 'Alt+Space');
    expect(registry.unregister).toHaveBeenNthCalledWith(2, 'Alt+Space');
  });

  it('reports a failed temporary capture without unregistering another owner', () => {
    const registry = {
      register: vi.fn(() => false),
      unregister: vi.fn(),
    };
    const sender = {
      send: vi.fn(),
    };
    const controller = createAltSpaceHotkeyCaptureController({ registry });

    expect(controller.start(sender)).toBe(false);

    expect(registry.unregister).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });
});
