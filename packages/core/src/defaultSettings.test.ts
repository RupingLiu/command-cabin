import { describe, expect, it } from 'vitest';

import { createDefaultSettings } from './defaultSettings.js';

describe('createDefaultSettings', () => {
  it('uses the Windows-first launcher defaults', () => {
    expect(createDefaultSettings()).toEqual({
      appId: 'com.commandcabin.app',
      defaultHotkey: 'Alt+Space',
      platformPriority: 'windows',
      plugins: {
        allowLocalThirdPartyPlugins: true,
      },
    });
  });
});
