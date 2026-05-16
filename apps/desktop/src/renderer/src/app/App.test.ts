import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AppView, appReducer, initialAppState, type AppState } from './App.js';
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
        state: initialAppState,
        onClosePlugin: vi.fn(),
        onOpenPluginPage: vi.fn(),
        onOpenSettings: vi.fn(),
        onPluginHostFailure: vi.fn(),
        onReturnToLauncher: vi.fn(),
      }),
    );
    const pluginMarkup = renderToStaticMarkup(
      createElement(AppView, {
        state: {
          activePlugin: plugin,
          lastPluginFailure: undefined,
        },
        onClosePlugin: vi.fn(),
        onOpenPluginPage: vi.fn(),
        onOpenSettings: vi.fn(),
        onPluginHostFailure: vi.fn(),
        onReturnToLauncher: vi.fn(),
      }),
    );

    expect(launcherMarkup).toContain('Desktop Launcher');
    expect(pluginMarkup).toContain('plugin-host-webview');
    expect(pluginMarkup).toContain('file:///C:/CommandCabin/plugins/text-tools/ui/index.html');
  });

  it('renders the clipboard history clear control in the reachable settings view', () => {
    const markup = renderToStaticMarkup(
      createElement(AppView, {
        state: {
          ...initialAppState,
          view: 'settings',
        },
        onClosePlugin: vi.fn(),
        onOpenPluginPage: vi.fn(),
        onOpenSettings: vi.fn(),
        onPluginHostFailure: vi.fn(),
        onReturnToLauncher: vi.fn(),
      }),
    );

    expect(markup).toContain('Settings');
    expect(markup).toContain('Clipboard History');
    expect(markup).toContain('Clear history');
  });
});
