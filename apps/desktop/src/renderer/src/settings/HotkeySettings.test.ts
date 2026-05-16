import { describe, expect, it, vi } from 'vitest';

import {
  createHotkeySettingsState,
  formatHotkeyFromKeyEvent,
  saveRecordedHotkey,
} from './HotkeySettings.js';

describe('HotkeySettings helpers', () => {
  it('formats key events as Electron-style accelerators', () => {
    expect(
      formatHotkeyFromKeyEvent({
        altKey: true,
        ctrlKey: true,
        key: 'k',
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe('Ctrl+Alt+K');

    expect(
      formatHotkeyFromKeyEvent({
        altKey: true,
        ctrlKey: false,
        key: ' ',
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe('Alt+Space');
  });

  it('rejects modifier-only and empty key events', () => {
    expect(
      formatHotkeyFromKeyEvent({
        altKey: true,
        ctrlKey: false,
        key: 'Alt',
        metaKey: false,
        shiftKey: false,
      }),
    ).toBeUndefined();

    expect(
      formatHotkeyFromKeyEvent({
        altKey: false,
        ctrlKey: false,
        key: '',
        metaKey: false,
        shiftKey: false,
      }),
    ).toBeUndefined();
  });

  it('rolls optimistic hotkey state back to the persisted value when save fails', async () => {
    const state = createHotkeySettingsState('Alt+Space');

    await expect(
      saveRecordedHotkey(state, 'Ctrl+Alt+K', async () => {
        throw new Error('Shortcut conflict.');
      }),
    ).resolves.toEqual({
      currentHotkey: 'Alt+Space',
      errorMessage: 'Shortcut conflict.',
      isRecording: true,
      persistedHotkey: 'Alt+Space',
    });

    expect(state.currentHotkey).toBe('Alt+Space');
  });

  it('commits optimistic hotkey state after save succeeds', async () => {
    const state = createHotkeySettingsState('Alt+Space');
    const saveHotkey = vi.fn(async () => undefined);

    await expect(saveRecordedHotkey(state, 'Ctrl+Alt+K', saveHotkey)).resolves.toMatchObject({
      currentHotkey: 'Ctrl+Alt+K',
      errorMessage: undefined,
      isRecording: false,
    });
    expect(saveHotkey).toHaveBeenCalledWith('Ctrl+Alt+K');
  });
});
