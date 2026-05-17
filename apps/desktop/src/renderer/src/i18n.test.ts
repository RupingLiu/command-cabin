import { describe, expect, it } from 'vitest';

import { getUiStrings } from './i18n.js';

describe('renderer i18n strings', () => {
  it('provides Simplified Chinese, Traditional Chinese, and English UI labels', () => {
    expect(getUiStrings('zh-CN').settings.hotkey.title).toBe('快捷键');
    expect(getUiStrings('zh-TW').settings.hotkey.title).toBe('快捷鍵');
    expect(getUiStrings('en-US').settings.hotkey.title).toBe('Hotkey');
  });

  it('falls back to Simplified Chinese when no language is loaded yet', () => {
    expect(getUiStrings(undefined).launcher.search.label).toBe('搜索');
  });
});
