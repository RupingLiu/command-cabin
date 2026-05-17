import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FOCUS_SEARCH_INPUT_CHANNEL,
  createWindowVisibilityController,
} from './windowVisibility.js';

type WindowEvent = 'blur';

class MockLauncherWindow {
  readonly center = vi.fn();
  readonly focus = vi.fn();
  readonly hide = vi.fn(() => {
    this.visible = false;
  });
  readonly show = vi.fn(() => {
    this.visible = true;
  });
  readonly showInactive = vi.fn(() => {
    this.visible = true;
  });
  readonly webContents = {
    send: vi.fn(),
  };

  private readonly listeners = new Map<WindowEvent, Set<() => void>>();

  constructor(private visible: boolean) {}

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
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener();
    }
  }
}

describe('createWindowVisibilityController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows hidden windows before focusing the search field', () => {
    const window = new MockLauncherWindow(false);
    const controller = createWindowVisibilityController({
      getSettings: () => ({ hideOnBlur: true }),
      window,
    });

    controller.toggle();

    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith(FOCUS_SEARCH_INPUT_CHANNEL);
  });

  it('uses the normal show path when showInactive is not available', () => {
    const window = new MockLauncherWindow(false);
    const controller = createWindowVisibilityController({
      getSettings: () => ({ hideOnBlur: true }),
      window: {
        center: window.center,
        focus: window.focus,
        hide: window.hide,
        isVisible: () => window.isVisible(),
        on: window.on.bind(window),
        show: window.show,
        webContents: window.webContents,
      },
    });

    controller.show();

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it('hides the window when toggled while visible', () => {
    const window = new MockLauncherWindow(true);
    const controller = createWindowVisibilityController({
      getSettings: () => ({ hideOnBlur: true }),
      window,
    });

    controller.toggle();

    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
  });

  it('hides on blur when the setting is enabled', () => {
    const window = new MockLauncherWindow(true);

    createWindowVisibilityController({
      getSettings: () => ({ hideOnBlur: true }),
      window,
    });

    window.emit('blur');

    expect(window.hide).toHaveBeenCalledOnce();
  });

  it('keeps the window visible on blur when the setting is disabled', () => {
    const window = new MockLauncherWindow(true);

    createWindowVisibilityController({
      getSettings: () => ({ hideOnBlur: false }),
      window,
    });

    window.emit('blur');

    expect(window.hide).not.toHaveBeenCalled();
  });

  it('removes the blur listener when disposed', () => {
    const window = new MockLauncherWindow(true);
    const controller = createWindowVisibilityController({
      getSettings: () => ({ hideOnBlur: true }),
      window,
    });

    controller.dispose();
    window.emit('blur');

    expect(window.hide).not.toHaveBeenCalled();
  });
});
