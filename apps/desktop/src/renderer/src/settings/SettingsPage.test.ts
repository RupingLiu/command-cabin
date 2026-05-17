import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SettingsPage } from './SettingsPage.js';

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
    expect(markup).toContain('快捷键');
    expect(markup).toContain('主题');
    expect(markup).toContain('语言');
    expect(markup).toContain('启动');
    expect(markup).toContain('启动器');
    expect(markup).toContain('保留上次搜索内容');
    expect(markup).toContain('开机自启动');
    expect(markup).toContain('简体中文');
    expect(markup).toContain('繁體中文');
    expect(markup).toContain('English');
    expect(markup).toContain('插件管理');
    expect(markup).toContain('数据目录');
    expect(markup).toContain('收藏');
    expect(markup).toContain('剪贴板历史');
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
    expect(markup).toContain('快捷鍵');
    expect(markup).toContain('主題');
    expect(markup).toContain('語言');
    expect(markup).toContain('啟動');
    expect(markup).toContain('啟動器');
    expect(markup).toContain('保留上次搜尋內容');
    expect(markup).toContain('開機自動啟動');
    expect(markup).toContain('外掛管理');
    expect(markup).toContain('剪貼簿歷史');
    expect(markup).not.toContain('Hotkey');
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
});
