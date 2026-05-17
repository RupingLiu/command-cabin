import { describe, expect, it, vi } from 'vitest';

import type { CommandCabinTrayMenuItem } from './trayController.js';

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: vi.fn((items) => items),
  },
  Tray: vi.fn(),
  nativeImage: {
    createFromPath: vi.fn((iconPath) => iconPath),
  },
}));

class MockTray {
  readonly destroy = vi.fn();
  readonly listeners = new Map<string, () => void>();
  readonly on = vi.fn((eventName: string, listener: () => void) => {
    this.listeners.set(eventName, listener);
  });
  readonly setContextMenu = vi.fn();
  readonly setToolTip = vi.fn();

  constructor(readonly iconPath: string) {}
}

describe('createCommandCabinTrayController', () => {
  it('creates a tray icon with tooltip and menu actions', async () => {
    const { createCommandCabinTrayController } = await import('./trayController.js');
    const trayInstances: MockTray[] = [];
    const show = vi.fn();
    const openSettings = vi.fn();
    const quit = vi.fn();
    const controller = createCommandCabinTrayController({
      createMenu: vi.fn((items: CommandCabinTrayMenuItem[]) => items),
      createTray: vi.fn((iconPath) => {
        const tray = new MockTray(iconPath);
        trayInstances.push(tray);
        return tray;
      }),
      iconPath: 'C:\\CommandCabin\\icon.ico',
      language: 'en-US',
      openSettings,
      quit,
      show,
      toggle: vi.fn(),
    });

    expect(controller.available).toBe(true);
    expect(trayInstances[0]?.setToolTip).toHaveBeenCalledWith('CommandCabin');
    expect(trayInstances[0]?.setContextMenu).toHaveBeenCalledWith([
      expect.objectContaining({ label: 'Show CommandCabin' }),
      expect.objectContaining({ label: 'Settings' }),
      expect.objectContaining({ type: 'separator' }),
      expect.objectContaining({ label: 'Quit' }),
    ]);

    const menu = trayInstances[0]?.setContextMenu.mock.calls[0]?.[0] as CommandCabinTrayMenuItem[];
    menu[0]?.click?.();
    menu[1]?.click?.();
    menu[3]?.click?.();

    expect(show).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();

    controller.dispose();
    expect(trayInstances[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('creates a Simplified Chinese tray menu from the selected language', async () => {
    const { createCommandCabinTrayController } = await import('./trayController.js');
    const tray = new MockTray('C:\\CommandCabin\\icon.ico');

    createCommandCabinTrayController({
      createMenu: vi.fn((items: CommandCabinTrayMenuItem[]) => items),
      createTray: vi.fn(() => tray),
      iconPath: tray.iconPath,
      language: 'zh-CN',
      openSettings: vi.fn(),
      quit: vi.fn(),
      show: vi.fn(),
      toggle: vi.fn(),
    });

    expect(tray.setContextMenu).toHaveBeenCalledWith([
      expect.objectContaining({ label: '显示 CommandCabin' }),
      expect.objectContaining({ label: '设置' }),
      expect.objectContaining({ type: 'separator' }),
      expect.objectContaining({ label: '退出' }),
    ]);
  });

  it('rebuilds the tray menu when the display language changes', async () => {
    const { createCommandCabinTrayController } = await import('./trayController.js');
    const tray = new MockTray('C:\\CommandCabin\\icon.ico');
    const controller = createCommandCabinTrayController({
      createMenu: vi.fn((items: CommandCabinTrayMenuItem[]) => items),
      createTray: vi.fn(() => tray),
      iconPath: tray.iconPath,
      language: 'en-US',
      openSettings: vi.fn(),
      quit: vi.fn(),
      show: vi.fn(),
      toggle: vi.fn(),
    });

    controller.updateLanguage('zh-CN');

    expect(tray.setContextMenu).toHaveBeenLastCalledWith([
      expect.objectContaining({ label: '显示 CommandCabin' }),
      expect.objectContaining({ label: '设置' }),
      expect.objectContaining({ type: 'separator' }),
      expect.objectContaining({ label: '退出' }),
    ]);
  });

  it('left-clicks the tray to toggle the launcher', async () => {
    const { createCommandCabinTrayController } = await import('./trayController.js');
    const tray = new MockTray('C:\\CommandCabin\\icon.ico');
    const toggle = vi.fn();

    createCommandCabinTrayController({
      createMenu: vi.fn((items) => items),
      createTray: vi.fn(() => tray),
      iconPath: tray.iconPath,
      openSettings: vi.fn(),
      quit: vi.fn(),
      show: vi.fn(),
      toggle,
    });

    tray.listeners.get('click')?.();

    expect(toggle).toHaveBeenCalledOnce();
  });

  it('logs and stays unavailable when tray creation fails', async () => {
    const { createCommandCabinTrayController } = await import('./trayController.js');
    const logger = { error: vi.fn() };

    const controller = createCommandCabinTrayController({
      createMenu: vi.fn((items) => items),
      createTray: vi.fn(() => {
        throw new Error('missing icon');
      }),
      iconPath: 'C:\\CommandCabin\\missing.ico',
      logger,
      openSettings: vi.fn(),
      quit: vi.fn(),
      show: vi.fn(),
      toggle: vi.fn(),
    });

    expect(controller.available).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to create CommandCabin tray.',
      expect.any(Error),
    );
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe('resolveTrayIconPath', () => {
  it('resolves the packaged icon next to the app resources', async () => {
    const { resolveTrayIconPath } = await import('./trayController.js');
    expect(resolveTrayIconPath('C:\\Program Files\\CommandCabin\\resources\\app\\out\\main')).toBe(
      'C:\\Program Files\\CommandCabin\\resources\\app\\build\\icon.ico',
    );
  });
});
