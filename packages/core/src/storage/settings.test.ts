import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COMMAND_CABIN_SETTINGS,
  createDefaultCommandCabinSettings,
  createInMemorySettingsStore,
} from './settings.js';

describe('CommandCabin settings', () => {
  it('uses Task 3 launcher defaults without requiring persistence', () => {
    expect(createDefaultCommandCabinSettings()).toEqual({
      hotkey: 'Alt+Space',
      screenshotHotkey: 'Ctrl+Alt+A',
      hideOnBlur: true,
      theme: 'system',
      language: 'zh-CN',
      launchAtLogin: false,
      preserveSearchQuery: false,
      search: {
        maxResults: 20,
        historyBoost: 1.4,
        pluginBoost: 1,
        appBoost: 1.2,
        fileBoost: 0.9,
      },
    });
  });

  it('keeps in-memory settings isolated from caller mutations', () => {
    const store = createInMemorySettingsStore({
      hotkey: 'Ctrl+Space',
      search: {
        maxResults: 12,
      },
    });

    const settings = store.getSettings();
    settings.search.maxResults = 99;

    expect(store.getSettings()).toMatchObject({
      hotkey: 'Ctrl+Space',
      search: {
        maxResults: 12,
        historyBoost: 1.4,
      },
    });
  });

  it('updates only the provided in-memory setting fields', () => {
    const store = createInMemorySettingsStore();

    const updatedSettings = store.updateSettings({
      hideOnBlur: false,
      search: {
        pluginBoost: 1.6,
      },
    });

    expect(updatedSettings).toMatchObject({
      hotkey: 'Alt+Space',
      screenshotHotkey: 'Ctrl+Alt+A',
      hideOnBlur: false,
      search: {
        maxResults: 20,
        pluginBoost: 1.6,
      },
    });
  });

  it('prevents mutations of exported canonical defaults from corrupting future defaults', () => {
    const mutableDefaults = DEFAULT_COMMAND_CABIN_SETTINGS as {
      hotkey: string;
      search: {
        maxResults: number;
      };
    };

    expect(() => {
      mutableDefaults.hotkey = 'Ctrl+Space';
    }).toThrow(TypeError);
    expect(() => {
      mutableDefaults.search.maxResults = 99;
    }).toThrow(TypeError);
    expect(createDefaultCommandCabinSettings()).toMatchObject({
      hotkey: 'Alt+Space',
      screenshotHotkey: 'Ctrl+Alt+A',
      search: {
        maxResults: 20,
      },
    });
  });
});
