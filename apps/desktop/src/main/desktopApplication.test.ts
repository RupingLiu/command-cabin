import { describe, expect, it, vi } from 'vitest';

import { createDesktopApplicationController } from './desktopApplication.js';
import { FOCUS_SEARCH_INPUT_CHANNEL } from './window/windowVisibility.js';

type WindowEvent = 'blur' | 'close' | 'closed';
type WindowListener = (event?: { preventDefault: () => void }) => void;
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
  private readonly listeners = new Map<WindowEvent, Set<WindowListener>>();

  constructor(private visible: boolean) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }

  on(eventName: WindowEvent, listener: WindowListener): this {
    const listeners = this.listeners.get(eventName) ?? new Set<WindowListener>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return this;
  }

  off(eventName: WindowEvent, listener: WindowListener): this {
    this.listeners.get(eventName)?.delete(listener);
    return this;
  }

  emit(eventName: WindowEvent, event?: { preventDefault: () => void }): void {
    if (eventName === 'closed') {
      this.destroyed = true;
    }

    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event);
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

  it('can start without showing the launcher for login startup', async () => {
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

    await controller.start({ showWindow: false });

    expect(createWindow).toHaveBeenCalledOnce();
    expect(hiddenWindow.show).not.toHaveBeenCalled();
    expect(hiddenWindow.focus).not.toHaveBeenCalled();
  });

  it('keeps the launcher visible when the startup hotkey conflict dialog blurs it', async () => {
    const window = new MockLauncherWindow(true);
    const createWindow = vi.fn(async () => window);
    const notifyHotkeyConflict = vi.fn(() => {
      window.emit('blur');
    });
    const controller = createDesktopApplicationController({
      createWindow,
      getSettings: () => ({
        hideOnBlur: true,
        hotkey: 'Alt+Space',
      }),
      hotkeyRegistry: {
        register: vi.fn(() => false),
        unregister: vi.fn(),
      },
      notifyHotkeyConflict,
    });

    await controller.start();

    expect(notifyHotkeyConflict).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.center).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith(FOCUS_SEARCH_INPUT_CHANNEL);
  });

  it('re-registers the global hotkey when settings change', async () => {
    const window = new MockLauncherWindow(false);
    let currentHotkey = 'Alt+Space';
    const hotkeyRegistry = {
      register: vi.fn(() => true),
      unregister: vi.fn(),
    };
    const controller = createDesktopApplicationController({
      createWindow: vi.fn(async () => window),
      getSettings: () => ({
        hideOnBlur: true,
        hotkey: currentHotkey,
      }),
      hotkeyRegistry,
    });

    await controller.start();
    currentHotkey = 'Ctrl+Alt+K';
    expect(controller.tryRegisterGlobalHotkey(currentHotkey)).toBe(true);

    expect(hotkeyRegistry.unregister).toHaveBeenCalledWith('Alt+Space');
    expect(hotkeyRegistry.register).toHaveBeenNthCalledWith(2, 'Ctrl+Alt+K', expect.any(Function));
  });

  it('keeps the old working hotkey when the new registration fails', async () => {
    const window = new MockLauncherWindow(false);
    const hotkeyRegistry = {
      register: vi.fn((accelerator: string) => accelerator === 'Alt+Space'),
      unregister: vi.fn(),
    };
    const controller = createDesktopApplicationController({
      createWindow: vi.fn(async () => window),
      getSettings: () => ({
        hideOnBlur: true,
        hotkey: 'Alt+Space',
      }),
      hotkeyRegistry,
    });

    await controller.start();

    expect(controller.tryRegisterGlobalHotkey('Ctrl+Alt+K')).toBe(false);
    expect(hotkeyRegistry.unregister).not.toHaveBeenCalled();
    expect(hotkeyRegistry.register).toHaveBeenNthCalledWith(2, 'Ctrl+Alt+K', expect.any(Function));
  });

  it('hides the launcher instead of closing when close is not a real quit', async () => {
    const window = new MockLauncherWindow(true);
    const controller = createDesktopApplicationController({
      createWindow: vi.fn(async () => window),
      getSettings: () => ({
        hideOnBlur: true,
        hotkey: 'Ctrl+Alt+K',
      }),
      hotkeyRegistry: {
        register: vi.fn(() => true),
        unregister: vi.fn(),
      },
    });
    const event = { preventDefault: vi.fn() };

    await controller.start();
    controller.handleWindowClose(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
  });

  it('allows window close after quit is requested', async () => {
    const window = new MockLauncherWindow(true);
    const controller = createDesktopApplicationController({
      createWindow: vi.fn(async () => window),
      getSettings: () => ({
        hideOnBlur: true,
        hotkey: 'Ctrl+Alt+K',
      }),
      hotkeyRegistry: {
        register: vi.fn(() => true),
        unregister: vi.fn(),
      },
    });
    const event = { preventDefault: vi.fn() };

    await controller.start();
    controller.requestQuit();
    controller.handleWindowClose(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('sends an open-settings signal after showing the launcher', async () => {
    const window = new MockLauncherWindow(false);
    const controller = createDesktopApplicationController({
      createWindow: vi.fn(async () => window),
      getSettings: () => ({
        hideOnBlur: true,
        hotkey: 'Ctrl+Alt+K',
      }),
      hotkeyRegistry: {
        register: vi.fn(() => true),
        unregister: vi.fn(),
      },
    });

    await controller.openSettings();

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith('command-cabin:open-settings');
  });
});
