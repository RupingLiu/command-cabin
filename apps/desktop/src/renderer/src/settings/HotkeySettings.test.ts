import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { getUiStrings } from '../i18n.js';
import {
  createHotkeySettingsState,
  formatHotkeyFromKeyEvent,
  HotkeySettings,
  isHotkeyRecorderActive,
  isModifierOnlyHotkeyEvent,
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

  it('waits for a non-modifier key while recording a modifier chord', () => {
    expect(
      isModifierOnlyHotkeyEvent({
        altKey: true,
        ctrlKey: false,
        key: 'Alt',
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);

    expect(
      isModifierOnlyHotkeyEvent({
        altKey: true,
        ctrlKey: false,
        key: ' ',
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
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

  it('renders a caller-provided screenshot shortcut string set', () => {
    const markup = renderToStaticMarkup(
      createElement(HotkeySettings, {
        strings: getUiStrings('en-US').settings.screenshotHotkey,
        value: 'Ctrl+Alt+A',
      }),
    );

    expect(markup).toContain('aria-label="Screenshot shortcut settings"');
    expect(markup).toContain('<h2>Screenshot shortcut</h2>');
    expect(markup).toContain('<span>Ctrl+Alt+A</span>');
    expect(markup).toContain('Record shortcut');
  });

  it('uses the controlled active recorder to render recording state', () => {
    const activeMarkup = renderToStaticMarkup(
      createElement(HotkeySettings, {
        activeRecorderId: 'screenshot',
        recorderId: 'screenshot',
        strings: getUiStrings('en-US').settings.screenshotHotkey,
        value: 'Ctrl+Alt+A',
      }),
    );
    const inactiveMarkup = renderToStaticMarkup(
      createElement(HotkeySettings, {
        activeRecorderId: 'screenshot',
        recorderId: 'launcher',
        strings: getUiStrings('en-US').settings.hotkey,
        value: 'Alt+Space',
      }),
    );

    expect(activeMarkup).toContain('Press shortcut');
    expect(inactiveMarkup).toContain('Record shortcut');
    expect(inactiveMarkup).not.toContain('Press shortcut');
  });

  it('treats a local recorder as inactive when another controlled recorder is active', () => {
    expect(
      isHotkeyRecorderActive({
        activeRecorderId: 'screenshot',
        localIsRecording: true,
        recorderId: 'launcher',
      }),
    ).toBe(false);
    expect(
      isHotkeyRecorderActive({
        activeRecorderId: 'screenshot',
        localIsRecording: false,
        recorderId: 'screenshot',
      }),
    ).toBe(true);
  });
});
