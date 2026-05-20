import { describe, expect, it, vi } from 'vitest';

import { createInMemorySettingsStore } from '@command-cabin/core';

import { updateSettingsWithHotkeyRegistration } from './updateSettingsWithHotkeyRegistration.js';

describe('updateSettingsWithHotkeyRegistration', () => {
  it('does not persist a conflicting hotkey when registration fails', () => {
    const settingsStore = createInMemorySettingsStore({
      hotkey: 'Alt+Space',
      theme: 'dark',
    });
    const tryRegisterLauncherHotkey = vi.fn(() => false);
    const tryRegisterScreenshotHotkey = vi.fn(() => true);

    expect(() =>
      updateSettingsWithHotkeyRegistration({
        settingsPatch: {
          hotkey: 'Ctrl+Alt+K',
          theme: 'light',
        },
        settingsStore,
        tryRegisterLauncherHotkey,
        tryRegisterScreenshotHotkey,
      }),
    ).toThrow(/could not register/i);

    expect(settingsStore.getSettings()).toMatchObject({
      hotkey: 'Alt+Space',
      theme: 'dark',
    });
    expect(tryRegisterLauncherHotkey).toHaveBeenCalledWith('Ctrl+Alt+K');
    expect(tryRegisterScreenshotHotkey).not.toHaveBeenCalled();
  });

  it('persists settings after changed launcher and screenshot hotkeys register', () => {
    const settingsStore = createInMemorySettingsStore({
      hotkey: 'Alt+Space',
      screenshotHotkey: 'Ctrl+Alt+A',
    });
    const tryRegisterLauncherHotkey = vi.fn(() => true);
    const tryRegisterScreenshotHotkey = vi.fn(() => true);

    expect(
      updateSettingsWithHotkeyRegistration({
        settingsPatch: {
          hotkey: 'Ctrl+Alt+K',
          screenshotHotkey: 'Ctrl+Shift+S',
        },
        settingsStore,
        tryRegisterLauncherHotkey,
        tryRegisterScreenshotHotkey,
      }),
    ).toMatchObject({
      hotkey: 'Ctrl+Alt+K',
      screenshotHotkey: 'Ctrl+Shift+S',
    });
    expect(tryRegisterLauncherHotkey).toHaveBeenCalledWith('Ctrl+Alt+K');
    expect(tryRegisterScreenshotHotkey).toHaveBeenCalledWith('Ctrl+Shift+S');
  });

  it('does not persist either changed hotkey when screenshot registration fails', () => {
    const settingsStore = createInMemorySettingsStore({
      hotkey: 'Alt+Space',
      screenshotHotkey: 'Ctrl+Alt+A',
      theme: 'dark',
    });
    const tryRegisterLauncherHotkey = vi.fn(() => true);
    const tryRegisterScreenshotHotkey = vi.fn(() => false);

    expect(() =>
      updateSettingsWithHotkeyRegistration({
        settingsPatch: {
          hotkey: 'Ctrl+Alt+K',
          screenshotHotkey: 'Ctrl+Shift+S',
          theme: 'light',
        },
        settingsStore,
        tryRegisterLauncherHotkey,
        tryRegisterScreenshotHotkey,
      }),
    ).toThrow(/could not register/i);

    expect(settingsStore.getSettings()).toMatchObject({
      hotkey: 'Alt+Space',
      screenshotHotkey: 'Ctrl+Alt+A',
      theme: 'dark',
    });
    expect(tryRegisterLauncherHotkey).toHaveBeenCalledWith('Ctrl+Alt+K');
    expect(tryRegisterScreenshotHotkey).toHaveBeenCalledWith('Ctrl+Shift+S');
  });

  it('rolls back launcher registration when screenshot registration fails', () => {
    const settingsStore = createInMemorySettingsStore({
      hotkey: 'Alt+Space',
      screenshotHotkey: 'Ctrl+Alt+A',
    });
    const tryRegisterLauncherHotkey = vi.fn(() => true);
    const tryRegisterScreenshotHotkey = vi.fn(() => false);

    expect(() =>
      updateSettingsWithHotkeyRegistration({
        settingsPatch: {
          hotkey: 'Ctrl+Alt+K',
          screenshotHotkey: 'Ctrl+Shift+S',
        },
        settingsStore,
        tryRegisterLauncherHotkey,
        tryRegisterScreenshotHotkey,
      }),
    ).toThrow(/could not register/i);

    expect(tryRegisterLauncherHotkey).toHaveBeenNthCalledWith(1, 'Ctrl+Alt+K');
    expect(tryRegisterLauncherHotkey).toHaveBeenNthCalledWith(2, 'Alt+Space');
    expect(tryRegisterScreenshotHotkey).toHaveBeenCalledWith('Ctrl+Shift+S');
    expect(settingsStore.getSettings()).toMatchObject({
      hotkey: 'Alt+Space',
      screenshotHotkey: 'Ctrl+Alt+A',
    });
  });

  it('rolls back screenshot registration when persistence fails after registration', () => {
    const settingsStore = {
      getSettings: () => ({
        ...createInMemorySettingsStore().getSettings(),
        hotkey: 'Alt+Space',
        screenshotHotkey: 'Ctrl+Alt+A',
      }),
      resetSettings: () => createInMemorySettingsStore().getSettings(),
      updateSettings: () => {
        throw new Error('write failed');
      },
    };
    const tryRegisterLauncherHotkey = vi.fn(() => false);
    const tryRegisterScreenshotHotkey = vi.fn(() => true);

    expect(() =>
      updateSettingsWithHotkeyRegistration({
        settingsPatch: {
          screenshotHotkey: 'Ctrl+Shift+S',
        },
        settingsStore,
        tryRegisterLauncherHotkey,
        tryRegisterScreenshotHotkey,
      }),
    ).toThrow(/write failed/);

    expect(tryRegisterLauncherHotkey).not.toHaveBeenCalled();
    expect(tryRegisterScreenshotHotkey).toHaveBeenNthCalledWith(1, 'Ctrl+Shift+S');
    expect(tryRegisterScreenshotHotkey).toHaveBeenNthCalledWith(2, 'Ctrl+Alt+A');
  });

  it('rolls back screenshot registration when launcher registration fails after it', () => {
    const settingsStore = createInMemorySettingsStore({
      hotkey: 'Alt+Space',
      screenshotHotkey: 'Ctrl+Alt+A',
    });
    const tryRegisterLauncherHotkey = vi.fn(() => false);
    const tryRegisterScreenshotHotkey = vi.fn(() => true);

    expect(() =>
      updateSettingsWithHotkeyRegistration({
        settingsPatch: {
          screenshotHotkey: 'Ctrl+Shift+S',
          hotkey: 'Ctrl+Alt+K',
        },
        settingsStore,
        tryRegisterLauncherHotkey,
        tryRegisterScreenshotHotkey,
      }),
    ).toThrow(/could not register/i);

    expect(tryRegisterScreenshotHotkey).toHaveBeenNthCalledWith(1, 'Ctrl+Shift+S');
    expect(tryRegisterScreenshotHotkey).toHaveBeenNthCalledWith(2, 'Ctrl+Alt+A');
    expect(tryRegisterLauncherHotkey).toHaveBeenCalledWith('Ctrl+Alt+K');
    expect(settingsStore.getSettings()).toMatchObject({
      hotkey: 'Alt+Space',
      screenshotHotkey: 'Ctrl+Alt+A',
    });
  });
});
