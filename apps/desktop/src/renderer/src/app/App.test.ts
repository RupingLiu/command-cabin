import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  AppView,
  appReducer,
  getRendererMode,
  initialAppState,
  isScreenshotRendererMode,
  subscribeToOpenSettings,
  type AppState,
} from './App.js';
import type { PluginHostEntry } from '../plugin-host/PluginHost.js';

function createPluginEntry(): PluginHostEntry {
  return {
    allowedBaseUrl: 'file:///C:/CommandCabin/plugins/text-tools/',
    entryUrl: 'file:///C:/CommandCabin/plugins/text-tools/ui/index.html',
    launchToken: 'launch-1',
    name: 'Text Tools',
    partition: 'command-cabin-plugin:com-example-text-tools:launch-1',
    pluginId: 'com.example.text-tools',
  };
}

describe('App plugin host routing', () => {
  it('opens and closes the reachable settings view from app state', () => {
    const settingsOpen = appReducer(initialAppState, {
      type: 'open-settings',
    });

    expect(settingsOpen).toEqual({
      activePlugin: undefined,
      lastPluginFailure: undefined,
      view: 'settings',
    });

    expect(
      appReducer(settingsOpen, {
        type: 'open-launcher',
      }),
    ).toEqual(initialAppState);
  });

  it('opens and closes a plugin host from launcher state', () => {
    const plugin = createPluginEntry();
    const opened = appReducer(initialAppState, {
      plugin,
      type: 'open-plugin',
    });

    expect(opened).toEqual({
      activePlugin: plugin,
      lastPluginFailure: undefined,
      view: 'launcher',
    });

    expect(
      appReducer(opened, {
        type: 'close-plugin',
      }),
    ).toEqual(initialAppState);
  });

  it('returns to the launcher and records a plugin failure', () => {
    const plugin = createPluginEntry();
    const state: AppState = {
      activePlugin: plugin,
      lastPluginFailure: undefined,
    };
    const failure = {
      message: 'Plugin page failed to load.',
      reason: 'load-failed' as const,
    };

    expect(
      appReducer(state, {
        failure,
        type: 'plugin-failed',
      }),
    ).toEqual({
      activePlugin: undefined,
      lastPluginFailure: failure,
      view: 'launcher',
    });
  });

  it('renders PluginHost when a plugin is active and LauncherPage otherwise', () => {
    const plugin = createPluginEntry();
    const launcherMarkup = renderToStaticMarkup(
      createElement(AppView, {
        language: 'zh-CN',
        state: initialAppState,
        theme: 'system',
        onClosePlugin: vi.fn(),
        onLanguageUpdated: vi.fn(),
        onOpenPluginPage: vi.fn(),
        onOpenSettings: vi.fn(),
        onPluginHostFailure: vi.fn(),
        onReturnToLauncher: vi.fn(),
        onThemeUpdated: vi.fn(),
      }),
    );
    const pluginMarkup = renderToStaticMarkup(
      createElement(AppView, {
        language: 'zh-CN',
        state: {
          activePlugin: plugin,
          lastPluginFailure: undefined,
        },
        theme: 'system',
        onClosePlugin: vi.fn(),
        onLanguageUpdated: vi.fn(),
        onOpenPluginPage: vi.fn(),
        onOpenSettings: vi.fn(),
        onPluginHostFailure: vi.fn(),
        onReturnToLauncher: vi.fn(),
        onThemeUpdated: vi.fn(),
      }),
    );

    expect(launcherMarkup).toContain('launcher-brand-mark');
    expect(launcherMarkup).toContain('aria-label="打开设置"');
    expect(launcherMarkup).toContain('搜索');
    expect(launcherMarkup).toContain('输入命令');
    expect(launcherMarkup).not.toContain('Desktop Launcher');
    expect(launcherMarkup).not.toContain('>Settings</button>');
    expect(launcherMarkup).not.toContain('Electron ');
    expect(launcherMarkup).not.toContain('runtime-pill');
    expect(pluginMarkup).toContain('plugin-host-webview');
    expect(pluginMarkup).toContain('file:///C:/CommandCabin/plugins/text-tools/ui/index.html');
  });

  it('renders the clipboard history clear control in the reachable settings view', () => {
    const markup = renderToStaticMarkup(
      createElement(AppView, {
        language: 'zh-TW',
        state: {
          ...initialAppState,
          view: 'settings',
        },
        theme: 'system',
        onClosePlugin: vi.fn(),
        onLanguageUpdated: vi.fn(),
        onOpenPluginPage: vi.fn(),
        onOpenSettings: vi.fn(),
        onPluginHostFailure: vi.fn(),
        onReturnToLauncher: vi.fn(),
        onThemeUpdated: vi.fn(),
      }),
    );

    expect(markup).toContain('設定');
    expect(markup).toContain('剪貼簿歷史');
    expect(markup).toContain('清除歷史');
  });

  it('routes the desktop open-settings signal through the app listener', () => {
    const cleanup = vi.fn();
    const onOpenSettings = vi.fn();
    const desktopApi = {
      onOpenSettings: vi.fn((listener: () => void) => {
        listener();
        return cleanup;
      }),
    } as unknown as Window['desktopApi'];

    expect(subscribeToOpenSettings(desktopApi, onOpenSettings)).toBe(cleanup);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('detects screenshot renderer mode from the URL query', () => {
    expect(isScreenshotRendererMode('https://command-cabin.local/?mode=screenshot')).toBe(true);
    expect(isScreenshotRendererMode('https://command-cabin.local/?mode=launcher')).toBe(false);
    expect(isScreenshotRendererMode('not a url')).toBe(false);
    expect(getRendererMode('https://command-cabin.local/?mode=pinned-image')).toBe('pinned-image');
  });
});
