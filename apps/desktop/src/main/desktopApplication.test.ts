import { describe, expect, it, vi } from 'vitest';

import { createDesktopApplicationController } from './desktopApplication.js';
import { FOCUS_SEARCH_INPUT_CHANNEL } from './window/windowVisibility.js';

type WindowEvent = 'blur' | 'closed';
type HotkeyCallback = () => Promise<void> | void;

class MockLauncherWindow {
  readonly center = vi.fn();
  readonly focus = vi.fn();
  readonly hide = vi.fn(() => {
    this.visible = false;
  });
  readonly show = vi.fn(() => {
    this.visible = true;
  });
  readonly webContents = {
    send: vi.fn(),
  };

  private destroyed = false;
  private readonly listeners = new Map<WindowEvent, Set<() => void>>();

  constructor(private visible: boolean) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }

  on(eventName: WindowEvent, listener: () => void): this {
    const listeners = this.listeners.get(eventName) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return this;
  }

  off(eventName: WindowEvent, listener: () => void): this {
    this.listeners.get(eventName)?.delete(listener);
    return this;
  }

  emit(eventName: WindowEvent): void {
    if (eventName === 'closed') {
      this.destroyed = true;
    }

    for (const listener of this.listeners.get(eventName) ?? []) {
      listener();
    }
  }
}

describe('createDesktopApplicationController', () => {
  it('recreates and shows the launcher when the hotkey is pressed after the window closes', async () => {
    const firstWindow = new MockLauncherWindow(true);
    const recreatedWindow = new MockLauncherWindow(false);
    const windows = [firstWindow, recreatedWindow];
    let hotkeyCallback: HotkeyCallback | undefined;
    const createWindow = vi.fn(async () => {
      const window = windows.shift();

      if (!window) {
        throw new Error('Unexpected extra window creation.');
      }

      return window;
    });
    const hotkeyRegistry = {
      register: vi.fn((_accelerator: string, callback: HotkeyCallback) => {
        hotkeyCallback = callback;
        return true;
      }),
      unregister: vi.fn(),
    };
    const controller = createDesktopApplicationController({
      createWindow,
      getSettings: () => ({
        hideOnBlur: true,
        hotkey: 'Alt+Space',
      }),
      hotkeyRegistry,
    });

    await controller.start();
    firstWindow.emit('closed');
    await hotkeyCallback?.();

    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(recreatedWindow.center).toHaveBeenCalledOnce();
    expect(recreatedWindow.show).toHaveBeenCalledOnce();
    expect(recreatedWindow.focus).toHaveBeenCalledOnce();
    expect(recreatedWindow.webContents.send).toHaveBeenCalledWith(FOCUS_SEARCH_INPUT_CHANNEL);
  });

  it('shows and focuses an existing hidden launcher on app activation', async () => {
    const hiddenWindow = new MockLauncherWindow(false);
    const createWindow = vi.fn(async () => hiddenWindow);
    const controller = createDesktopApplicationController({
      createWindow,
      getSettings: () => ({
        hideOnBlur: true,
        hotkey: 'Alt+Space',
      }),
      hotkeyRegistry: {
        register: vi.fn(() => true),
        unregister: vi.fn(),
      },
    });

    await controller.start();
    await controller.handleActivate();

    expect(createWindow).toHaveBeenCalledOnce();
    expect(hiddenWindow.center).toHaveBeenCalledOnce();
    expect(hiddenWindow.show).toHaveBeenCalledOnce();
    expect(hiddenWindow.focus).toHaveBeenCalledOnce();
  });
});
