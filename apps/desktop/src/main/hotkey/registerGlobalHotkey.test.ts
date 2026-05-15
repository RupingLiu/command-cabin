import { describe, expect, it, vi } from 'vitest';

import { registerGlobalHotkey } from './registerGlobalHotkey.js';

describe('registerGlobalHotkey', () => {
  it('registers Alt+Space by default and invokes the trigger callback', () => {
    let registeredCallback: (() => void) | undefined;
    const registry = {
      register: vi.fn((accelerator: string, callback: () => void) => {
        registeredCallback = callback;
        return accelerator === 'Alt+Space';
      }),
      unregister: vi.fn(),
    };
    const onTriggered = vi.fn();

    const registration = registerGlobalHotkey({
      onTriggered,
      registry,
    });

    registeredCallback?.();

    expect(registration).toMatchObject({
      accelerator: 'Alt+Space',
      registered: true,
    });
    expect(registry.register).toHaveBeenCalledWith('Alt+Space', expect.any(Function));
    expect(onTriggered).toHaveBeenCalledOnce();

    registration.dispose();

    expect(registry.unregister).toHaveBeenCalledWith('Alt+Space');
  });

  it('returns a diagnosable conflict warning when registration fails', () => {
    const registry = {
      register: vi.fn(() => false),
      unregister: vi.fn(),
    };
    const logger = {
      warn: vi.fn(),
    };

    const registration = registerGlobalHotkey({
      accelerator: 'Alt+Space',
      logger,
      onTriggered: vi.fn(),
      registry,
    });

    expect(registration).toMatchObject({
      accelerator: 'Alt+Space',
      conflict: true,
      registered: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'CommandCabin global hotkey conflict: failed to register Alt+Space.',
    );

    registration.dispose();

    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it('notifies through a user-visible conflict path when registration fails', () => {
    const registry = {
      register: vi.fn(() => false),
      unregister: vi.fn(),
    };
    const notifier = vi.fn();

    registerGlobalHotkey({
      accelerator: 'Alt+Space',
      logger: {
        warn: vi.fn(),
      },
      notifyConflict: notifier,
      onTriggered: vi.fn(),
      registry,
    });

    expect(notifier).toHaveBeenCalledWith(
      'CommandCabin could not register Alt+Space. Another application or the operating system may already be using this shortcut.',
    );
  });
});
