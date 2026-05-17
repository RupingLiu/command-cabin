import { describe, expect, it } from 'vitest';

import {
  parseDataDirectoryResponse,
  parseHotkeyAccelerator,
  parsePluginRecords,
  parseSettings,
  parseSettingsPatch,
  parseUpdatedPluginRecord,
} from './settingsApi.js';

describe('settingsApi parsers', () => {
  it('parses settings and rejects unknown patch keys', () => {
    expect(
      parseSettings({
        hotkey: 'Ctrl+Alt+K',
        hideOnBlur: true,
        language: 'zh-TW',
        launchAtLogin: false,
        preserveSearchQuery: true,
        theme: 'dark',
        search: {
          appBoost: 1.2,
          fileBoost: 0.9,
          historyBoost: 1.4,
          maxResults: 20,
          pluginBoost: 1,
        },
      }),
    ).toMatchObject({
      hotkey: 'Ctrl+Alt+K',
      language: 'zh-TW',
      preserveSearchQuery: true,
      theme: 'dark',
    });

    expect(parseSettingsPatch({ language: 'zh-TW', preserveSearchQuery: true })).toEqual({
      language: 'zh-TW',
      preserveSearchQuery: true,
    });
    expect(() => parseSettingsPatch({ unknown: true })).toThrow(/unknown setting/i);
  });

  it('rejects malformed and modifier-only hotkey patches from IPC', () => {
    expect(parseHotkeyAccelerator('Ctrl+Alt+K')).toBe('Ctrl+Alt+K');
    expect(parseHotkeyAccelerator('Alt+Space')).toBe('Alt+Space');

    expect(() => parseSettingsPatch({ hotkey: 'Ctrl+Alt' })).toThrow(/non-modifier key/i);
    expect(() => parseSettingsPatch({ hotkey: 'K' })).toThrow(/modifier/i);
    expect(() => parseSettingsPatch({ hotkey: 'Ctrl+Banana' })).toThrow(/unsupported key/i);
  });

  it('parses plugin records and optional plugin update responses', () => {
    const plugin = {
      id: 'com.example.text-tools',
      name: 'Text Tools',
      version: '0.1.0',
      main: 'dist/main.js',
      ui: 'dist/index.html',
      description: 'Local text utilities',
      enabled: true,
      permissions: ['clipboard.read'],
      installedAt: '2026-05-15T10:00:00.000Z',
      updatedAt: '2026-05-15T10:00:00.000Z',
    };

    expect(parsePluginRecords([plugin])).toEqual([plugin]);
    expect(parseUpdatedPluginRecord(undefined)).toBeUndefined();
    expect(parseUpdatedPluginRecord(plugin)).toEqual(plugin);
  });

  it('parses data directory responses', () => {
    expect(
      parseDataDirectoryResponse({ path: 'C:\\Users\\Ruping\\AppData\\CommandCabin' }),
    ).toEqual({
      path: 'C:\\Users\\Ruping\\AppData\\CommandCabin',
    });
  });
});
