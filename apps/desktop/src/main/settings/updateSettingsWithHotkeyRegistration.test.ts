import { describe, expect, it, vi } from 'vitest';

import { createInMemorySettingsStore } from '@command-cabin/core';

import { updateSettingsWithHotkeyRegistration } from './updateSettingsWithHotkeyRegistration.js';

describe('updateSettingsWithHotkeyRegistration', () => {
  it('does not persist a conflicting hotkey when registration fails', () => {
    const settingsStore = createInMemorySettingsStore({
      hotkey: 'Alt+Space',
      theme: 'dark',
    });
    const tryRegisterHotkey = vi.fn(() => false);

    expect(() =>
      updateSettingsWithHotkeyRegistration({
        settingsPatch: {
          hotkey: 'Ctrl+Alt+K',
          theme: 'light',
        },
        settingsStore,
        tryRegisterHotkey,
      }),
    ).toThrow(/could not register/i);

    expect(settingsStore.getSettings()).toMatchObject({
      hotkey: 'Alt+Space',
      theme: 'dark',
    });
    expect(tryRegisterHotkey).toHaveBeenCalledWith('Ctrl+Alt+K');
  });

  it('persists settings after the new hotkey registers', () => {
    const settingsStore = createInMemorySettingsStore({
      hotkey: 'Alt+Space',
    });

    expect(
      updateSettingsWithHotkeyRegistration({
        settingsPatch: {
          hotkey: 'Ctrl+Alt+K',
        },
        settingsStore,
        tryRegisterHotkey: () => true,
      }),
    ).toMatchObject({
      hotkey: 'Ctrl+Alt+K',
    });
  });
});
