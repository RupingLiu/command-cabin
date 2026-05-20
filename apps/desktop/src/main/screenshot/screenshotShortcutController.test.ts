import { describe, expect, it, vi } from 'vitest';

import { createScreenshotShortcutController } from './screenshotShortcutController.js';

describe('createScreenshotShortcutController', () => {
  it('registers the screenshot hotkey independently and starts capture when triggered', async () => {
    let trigger: (() => Promise<void> | void) | undefined;
    const registry = {
      register: vi.fn((_accelerator: string, callback: () => Promise<void> | void) => {
        trigger = callback;
        return true;
      }),
      unregister: vi.fn(),
    };
    const startScreenshotCapture = vi.fn();
    const controller = createScreenshotShortcutController({
      getAccelerator: () => 'Ctrl+Alt+A',
      registry,
      startScreenshotCapture,
    });

    await controller.start();
    await trigger?.();
    controller.dispose();

    expect(registry.register).toHaveBeenCalledWith('Ctrl+Alt+A', expect.any(Function));
    expect(startScreenshotCapture).toHaveBeenCalledWith('capture');
    expect(registry.unregister).toHaveBeenCalledWith('Ctrl+Alt+A');
  });

  it('keeps the existing registration when re-registering the same accelerator', () => {
    const registry = {
      register: vi.fn(() => true),
      unregister: vi.fn(),
    };
    const controller = createScreenshotShortcutController({
      getAccelerator: () => 'Ctrl+Alt+A',
      registry,
      startScreenshotCapture: vi.fn(),
    });

    expect(controller.tryRegisterGlobalHotkey('Ctrl+Alt+A')).toBe(true);
    expect(controller.tryRegisterGlobalHotkey('Ctrl+Alt+A')).toBe(true);

    expect(registry.register).toHaveBeenCalledTimes(1);
  });

  it('does not dispose the existing hotkey when the replacement conflicts', () => {
    const registry = {
      register: vi.fn((accelerator: string) => accelerator === 'Ctrl+Alt+A'),
      unregister: vi.fn(),
    };
    const controller = createScreenshotShortcutController({
      getAccelerator: () => 'Ctrl+Alt+A',
      registry,
      startScreenshotCapture: vi.fn(),
    });

    expect(controller.tryRegisterGlobalHotkey('Ctrl+Alt+A')).toBe(true);
    expect(controller.tryRegisterGlobalHotkey('Ctrl+Shift+S')).toBe(false);
    controller.dispose();

    expect(registry.unregister).toHaveBeenCalledTimes(1);
    expect(registry.unregister).toHaveBeenCalledWith('Ctrl+Alt+A');
  });
});
