import { describe, expect, it, vi } from 'vitest';

import { bootstrapPersistedTheme } from './themeStartup.js';

describe('theme startup', () => {
  it('loads persisted settings and applies the resolved theme before settings page mounts', async () => {
    const attributes = new Map<string, string>();
    const root = {
      removeAttribute: (name: string) => attributes.delete(name),
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    };
    const getSettings = vi.fn(async () => ({
      hideOnBlur: true,
      hotkey: 'Alt+Space',
      language: 'zh-CN' as const,
      launchAtLogin: false,
      search: {
        appBoost: 1.2,
        fileBoost: 0.9,
        historyBoost: 1.4,
        maxResults: 20,
        pluginBoost: 1,
      },
      theme: 'system' as const,
    }));

    await bootstrapPersistedTheme(
      {
        getSettings,
      },
      root,
      () => true,
    );

    expect(attributes.get('data-theme')).toBe('light');
  });
});
