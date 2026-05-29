import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createSettingsHotkeyPatch,
  isSettingsHotkeyRecorderActive,
  SettingsPage,
  startSettingsHotkeyRecorder,
} from './SettingsPage.js';

describe('SettingsPage', () => {
  it('renders the settings page in Simplified Chinese', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsPage, {
        language: 'zh-CN',
        onReturnToLauncher: vi.fn(),
      }),
    );

    expect(markup).toContain('CommandCabin');
    expect(markup).toContain('设置');
    expect(markup).toContain('返回');
    expect(markup).toContain('关于与更新');
    expect(markup).toContain('GitHub 仓库');
    expect(markup).toContain('CommandCabin v0.0.0');
    expect(markup).toContain('启动器快捷键');
    expect(markup).toContain('截图快捷键');
    expect(markup).toContain('延时截图快捷键');
    expect(markup).toContain('Ctrl+Alt+A');
    expect(markup).toContain('Ctrl+Alt+D');
    expect(markup).toContain('主题');
    expect(markup).toContain('语言');
    expect(markup).toContain('启动');
    expect(markup).toContain('启动器');
    expect(markup).toContain('保留上次搜索内容');
    expect(markup).toContain('开机自启动');
    expect(markup).toContain('简体中文');
    expect(markup).toContain('繁體中文');
    expect(markup).toContain('English');
    expect(markup).toContain('剪贴板历史');
    expect(markup).not.toContain('插件管理');
    expect(markup).not.toContain('数据目录');
    expect(markup).not.toContain('收藏');
    expect(markup).not.toContain('Hotkey');
    expect(markup).not.toContain('Launch at login');
  });

  it('renders the settings page in Traditional Chinese', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsPage, {
        language: 'zh-TW',
        onReturnToLauncher: vi.fn(),
      }),
    );

    expect(markup).toContain('設定');
    expect(markup).toContain('關於與更新');
    expect(markup).toContain('GitHub 倉庫');
    expect(markup).toContain('啟動器快捷鍵');
    expect(markup).toContain('截圖快捷鍵');
    expect(markup).toContain('延遲截圖快捷鍵');
    expect(markup).toContain('主題');
    expect(markup).toContain('語言');
    expect(markup).toContain('啟動');
    expect(markup).toContain('啟動器');
    expect(markup).toContain('保留上次搜尋內容');
    expect(markup).toContain('開機自動啟動');
    expect(markup).toContain('剪貼簿歷史');
    expect(markup).not.toContain('外掛管理');
    expect(markup).not.toContain('Hotkey');
  });

  it('renders the settings page in English', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsPage, {
        language: 'en-US',
        onReturnToLauncher: vi.fn(),
      }),
    );

    expect(markup).toContain('Settings');
    expect(markup).toContain('About and Updates');
    expect(markup).toContain('GitHub Repository');
    expect(markup).toContain('Launcher shortcut');
    expect(markup).toContain('Screenshot shortcut');
    expect(markup).toContain('Delayed screenshot shortcut');
    expect(markup).toContain('Alt+Space');
    expect(markup).toContain('Ctrl+Alt+A');
    expect(markup).toContain('Ctrl+Alt+D');
    expect(markup).toContain('Theme');
    expect(markup).toContain('Language');
    expect(markup).toContain('Startup');
    expect(markup).toContain('Launcher');
    expect(markup).toContain('Clipboard History');
    expect(markup).not.toContain('Plugin Management');
    expect(markup).not.toContain('Data Directory');
    expect(markup).not.toContain('Favorites');
    expect(markup).not.toContain('快捷键');
  });

  it('renders the current theme selection before persisted settings load', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsPage, {
        language: 'zh-CN',
        theme: 'light',
        onReturnToLauncher: vi.fn(),
      }),
    );

    expect(markup).toMatch(
      /<label data-selected="true"><input type="radio" name="theme" checked="" value="light"\/><span>浅色<\/span><\/label>/,
    );
    expect(markup).toContain('<span>浅色</span>');
  });

  it('creates only a launcher hotkey patch for launcher recording', () => {
    expect(createSettingsHotkeyPatch('launcher', 'Ctrl+Alt+K')).toEqual({
      hotkey: 'Ctrl+Alt+K',
    });
  });

  it('creates only a screenshot hotkey patch for screenshot recording', () => {
    expect(createSettingsHotkeyPatch('screenshot', 'Ctrl+Shift+S')).toEqual({
      screenshotHotkey: 'Ctrl+Shift+S',
    });
  });

  it('creates only a delayed screenshot hotkey patch for delayed screenshot recording', () => {
    expect(createSettingsHotkeyPatch('delayedScreenshot', 'Ctrl+Shift+D')).toEqual({
      delayedScreenshotHotkey: 'Ctrl+Shift+D',
    });
  });

  it('keeps only one active hotkey recorder when another starts', () => {
    const launcherActive = startSettingsHotkeyRecorder('launcher');
    const screenshotActive = startSettingsHotkeyRecorder('screenshot');
    const delayedScreenshotActive = startSettingsHotkeyRecorder('delayedScreenshot');

    expect(isSettingsHotkeyRecorderActive(launcherActive, 'launcher')).toBe(true);
    expect(isSettingsHotkeyRecorderActive(screenshotActive, 'launcher')).toBe(false);
    expect(isSettingsHotkeyRecorderActive(screenshotActive, 'screenshot')).toBe(true);
    expect(isSettingsHotkeyRecorderActive(delayedScreenshotActive, 'screenshot')).toBe(false);
    expect(isSettingsHotkeyRecorderActive(delayedScreenshotActive, 'delayedScreenshot')).toBe(
      true,
    );
  });
});
