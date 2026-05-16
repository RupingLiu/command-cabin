import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GET_DATA_DIRECTORY_CHANNEL,
  GET_SETTINGS_CHANNEL,
  INSTALL_PLUGIN_CHANNEL,
  LIST_PLUGINS_CHANNEL,
  OPEN_DATA_DIRECTORY_CHANNEL,
  REMOVE_PLUGIN_CHANNEL,
  SET_PLUGIN_ENABLED_CHANNEL,
  UPDATE_SETTINGS_CHANNEL,
} from '../shared/ipcChannels.js';
import type { DesktopApi } from './index.js';

const electronMock = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMock.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    removeListener: electronMock.removeListener,
  },
}));

async function loadDesktopApi(): Promise<DesktopApi> {
  vi.resetModules();
  await import('./index.js');
  return electronMock.exposeInMainWorld.mock.calls.at(-1)?.[1] as DesktopApi;
}

describe('preload desktopApi settings bridge', () => {
  beforeEach(() => {
    electronMock.exposeInMainWorld.mockClear();
    electronMock.invoke.mockReset();
    electronMock.on.mockClear();
    electronMock.removeListener.mockClear();
  });

  it('exposes settings, plugin, and data directory IPC methods', async () => {
    const api = await loadDesktopApi();
    const settings = {
      hideOnBlur: true,
      hotkey: 'Alt+Space',
      language: 'zh-CN',
      launchAtLogin: false,
      search: {
        appBoost: 1.2,
        fileBoost: 0.9,
        historyBoost: 1.4,
        maxResults: 20,
        pluginBoost: 1,
      },
      theme: 'system',
    };
    const plugin = {
      enabled: true,
      id: 'com.example.text-tools',
      installedAt: '2026-05-15T10:00:00.000Z',
      main: 'dist/main.js',
      name: 'Text Tools',
      permissions: [],
      updatedAt: '2026-05-15T10:00:00.000Z',
      version: '0.1.0',
    };

    electronMock.invoke.mockResolvedValueOnce(settings);
    await expect(api.getSettings()).resolves.toEqual(settings);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(GET_SETTINGS_CHANNEL);

    electronMock.invoke.mockResolvedValueOnce({ ...settings, theme: 'dark' });
    await expect(api.updateSettings({ theme: 'dark' })).resolves.toMatchObject({
      theme: 'dark',
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(UPDATE_SETTINGS_CHANNEL, {
      theme: 'dark',
    });

    electronMock.invoke.mockResolvedValueOnce([plugin]);
    await expect(api.listPlugins()).resolves.toEqual([plugin]);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(LIST_PLUGINS_CHANNEL);

    electronMock.invoke.mockResolvedValueOnce({
      ...plugin,
      pluginRoot: 'C:\\Plugins\\TextTools',
    });
    await expect(api.installPlugin('C:\\Plugins\\TextTools')).resolves.toMatchObject({
      id: plugin.id,
      pluginRoot: 'C:\\Plugins\\TextTools',
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      INSTALL_PLUGIN_CHANNEL,
      'C:\\Plugins\\TextTools',
    );

    electronMock.invoke.mockResolvedValueOnce({ ...plugin, enabled: false });
    await expect(api.setPluginEnabled(plugin.id, false)).resolves.toMatchObject({
      enabled: false,
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      SET_PLUGIN_ENABLED_CHANNEL,
      plugin.id,
      false,
    );

    electronMock.invoke.mockResolvedValueOnce(true);
    await expect(api.removePlugin(plugin.id)).resolves.toBe(true);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(REMOVE_PLUGIN_CHANNEL, plugin.id);

    electronMock.invoke.mockResolvedValueOnce({ path: 'C:\\CommandCabin' });
    await expect(api.getDataDirectory()).resolves.toEqual({ path: 'C:\\CommandCabin' });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(GET_DATA_DIRECTORY_CHANNEL);

    electronMock.invoke.mockResolvedValueOnce({ path: 'C:\\CommandCabin' });
    await expect(api.openDataDirectory()).resolves.toEqual({ path: 'C:\\CommandCabin' });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(OPEN_DATA_DIRECTORY_CHANNEL);
  });
});
