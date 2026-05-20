import { describe, expect, it } from 'vitest';

import { getUiStrings } from './i18n.js';

describe('renderer i18n strings', () => {
  it('provides Simplified Chinese, Traditional Chinese, and English hotkey labels', () => {
    expect(getUiStrings('zh-CN').settings.hotkey.title).toBe('启动器快捷键');
    expect(getUiStrings('zh-CN').settings.screenshotHotkey.title).toBe('截图快捷键');
    expect(getUiStrings('zh-TW').settings.hotkey.title).toBe('啟動器快捷鍵');
    expect(getUiStrings('zh-TW').settings.screenshotHotkey.title).toBe('截圖快捷鍵');
    expect(getUiStrings('en-US').settings.hotkey.title).toBe('Launcher shortcut');
    expect(getUiStrings('en-US').settings.screenshotHotkey.title).toBe('Screenshot shortcut');
  });

  it('falls back to Simplified Chinese when no language is loaded yet', () => {
    expect(getUiStrings(undefined).launcher.search.label).toBe('搜索');
  });
});
