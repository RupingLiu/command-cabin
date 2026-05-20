import { describe, expect, it, vi } from 'vitest';

import { createScreenshotShortcutController } from './screenshotShortcutController.js';

describe('createScreenshotShortcutController', () => {
  it('registers screenshot hotkeys independently and starts the matching capture mode', async () => {
    const triggers = new Map<string, () => Promise<void> | void>();
    const registry = {
      register: vi.fn((accelerator: string, callback: () => Promise<void> | void) => {
        triggers.set(accelerator, callback);
        return true;
      }),
      unregister: vi.fn(),
    };
    const startScreenshotCapture = vi.fn();
    const controller = createScreenshotShortcutController({
      getAccelerators: () => ({
        screenshotHotkey: 'Ctrl+Alt+A',
        delayedScreenshotHotkey: 'Ctrl+Alt+D',
      }),
      registry,
      startScreenshotCapture,
    });

    await controller.start();
    await triggers.get('Ctrl+Alt+A')?.();
    await triggers.get('Ctrl+Alt+D')?.();
    controller.dispose();

    expect(registry.register).toHaveBeenCalledWith('Ctrl+Alt+A', expect.any(Function));
    expect(registry.register).toHaveBeenCalledWith('Ctrl+Alt+D', expect.any(Function));
    expect(startScreenshotCapture).toHaveBeenCalledWith('capture');
    expect(startScreenshotCapture).toHaveBeenCalledWith('capture-delay-3');
    expect(registry.unregister).toHaveBeenCalledWith('Ctrl+Alt+A');
    expect(registry.unregister).toHaveBeenCalledWith('Ctrl+Alt+D');
  });

  it('keeps the existing registration when re-registering the same accelerator', () => {
    const registry = {
      register: vi.fn(() => true),
      unregister: vi.fn(),
    };
    const controller = createScreenshotShortcutController({
      getAccelerators: () => ({
        screenshotHotkey: 'Ctrl+Alt+A',
        delayedScreenshotHotkey: 'Ctrl+Alt+D',
      }),
      registry,
      startScreenshotCapture: vi.fn(),
    });

    expect(controller.tryRegisterGlobalHotkey('screenshotHotkey', 'Ctrl+Alt+A')).toBe(true);
    expect(controller.tryRegisterGlobalHotkey('screenshotHotkey', 'Ctrl+Alt+A')).toBe(true);

    expect(registry.register).toHaveBeenCalledTimes(1);
  });

  it('does not dispose the existing hotkey when the replacement conflicts', () => {
    const registry = {
      register: vi.fn((accelerator: string) => accelerator === 'Ctrl+Alt+A'),
      unregister: vi.fn(),
    };
    const controller = createScreenshotShortcutController({
      getAccelerators: () => ({
        screenshotHotkey: 'Ctrl+Alt+A',
        delayedScreenshotHotkey: 'Ctrl+Alt+D',
      }),
      registry,
      startScreenshotCapture: vi.fn(),
    });

    expect(controller.tryRegisterGlobalHotkey('screenshotHotkey', 'Ctrl+Alt+A')).toBe(true);
    expect(controller.tryRegisterGlobalHotkey('screenshotHotkey', 'Ctrl+Shift+S')).toBe(false);
    controller.dispose();

    expect(registry.unregister).toHaveBeenCalledTimes(1);
    expect(registry.unregister).toHaveBeenCalledWith('Ctrl+Alt+A');
  });

  it('re-registers the delayed screenshot hotkey without replacing capture hotkey registration', () => {
    const registry = {
      register: vi.fn((accelerator: string) => accelerator !== 'Ctrl+Shift+D'),
      unregister: vi.fn(),
    };
    const controller = createScreenshotShortcutController({
      getAccelerators: () => ({
        screenshotHotkey: 'Ctrl+Alt+A',
        delayedScreenshotHotkey: 'Ctrl+Alt+D',
      }),
      registry,
      startScreenshotCapture: vi.fn(),
    });

    expect(controller.tryRegisterGlobalHotkey('screenshotHotkey', 'Ctrl+Alt+A')).toBe(true);
    expect(controller.tryRegisterGlobalHotkey('delayedScreenshotHotkey', 'Ctrl+Alt+D')).toBe(true);
    expect(controller.tryRegisterGlobalHotkey('delayedScreenshotHotkey', 'Ctrl+Shift+D')).toBe(
      false,
    );
    controller.dispose();

    expect(registry.unregister).toHaveBeenCalledWith('Ctrl+Alt+A');
    expect(registry.unregister).toHaveBeenCalledWith('Ctrl+Alt+D');
  });

  it('allows screenshot and delayed screenshot hotkeys to swap accelerators', () => {
    const registeredAccelerators = new Set<string>();
    const registry = {
      register: vi.fn((accelerator: string) => {
        if (registeredAccelerators.has(accelerator)) {
          return false;
        }

        registeredAccelerators.add(accelerator);
        return true;
      }),
      unregister: vi.fn((accelerator: string) => {
        registeredAccelerators.delete(accelerator);
      }),
    };
    const controller = createScreenshotShortcutController({
      getAccelerators: () => ({
        screenshotHotkey: 'Ctrl+Alt+A',
        delayedScreenshotHotkey: 'Ctrl+Alt+D',
      }),
      registry,
      startScreenshotCapture: vi.fn(),
    });

    expect(controller.tryRegisterGlobalHotkey('screenshotHotkey', 'Ctrl+Alt+A')).toBe(true);
    expect(controller.tryRegisterGlobalHotkey('delayedScreenshotHotkey', 'Ctrl+Alt+D')).toBe(true);

    expect(controller.tryRegisterGlobalHotkey('screenshotHotkey', 'Ctrl+Alt+D')).toBe(true);
    expect(controller.tryRegisterGlobalHotkey('delayedScreenshotHotkey', 'Ctrl+Alt+A')).toBe(true);
    controller.dispose();

    expect(registry.unregister).toHaveBeenCalledWith('Ctrl+Alt+D');
    expect(registry.unregister).toHaveBeenCalledWith('Ctrl+Alt+A');
  });
});
