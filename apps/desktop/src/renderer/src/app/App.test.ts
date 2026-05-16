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
  it('opens and closes a plugin host from launcher state', () => {
    const plugin = createPluginEntry();
    const opened = appReducer(initialAppState, {
      plugin,
      type: 'open-plugin',
    });

    expect(opened).toEqual({
      activePlugin: plugin,
      lastPluginFailure: undefined,
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
    });
  });

  it('renders PluginHost when a plugin is active and LauncherPage otherwise', () => {
    const plugin = createPluginEntry();
    const launcherMarkup = renderToStaticMarkup(
      createElement(AppView, {
        state: initialAppState,
        onClosePlugin: vi.fn(),
        onOpenPluginPage: vi.fn(),
        onPluginHostFailure: vi.fn(),
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
        onPluginHostFailure: vi.fn(),
      }),
    );

    expect(launcherMarkup).toContain('Desktop Launcher');
    expect(pluginMarkup).toContain('plugin-host-webview');
    expect(pluginMarkup).toContain('file:///C:/CommandCabin/plugins/text-tools/ui/index.html');
  });
});
