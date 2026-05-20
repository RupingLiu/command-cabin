import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADD_PINNED_APP_CANDIDATE_CHANNEL,
  CHECK_FOR_UPDATES_CHANNEL,
  GET_DATA_DIRECTORY_CHANNEL,
  GET_SETTINGS_CHANNEL,
  GET_UPDATE_STATUS_CHANNEL,
  HOTKEY_INPUT_CAPTURE_CHANNEL,
  ADD_PINNED_APP_CHANNEL,
  INSTALL_PLUGIN_CHANNEL,
  INSTALL_UPDATE_CHANNEL,
  LIST_APP_CANDIDATES_CHANNEL,
  LIST_PLUGINS_CHANNEL,
  OPEN_DATA_DIRECTORY_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  REMOVE_PLUGIN_CHANNEL,
  REMOVE_RECENT_APP_CHANNEL,
  SCREENSHOT_CANCEL_CHANNEL,
  SCREENSHOT_COPY_IMAGE_CHANNEL,
  SCREENSHOT_GET_LAUNCH_STATE_CHANNEL,
  SCREENSHOT_GET_PINNED_IMAGE_STATE_CHANNEL,
  SCREENSHOT_PIN_IMAGE_CHANNEL,
  SCREENSHOT_RUN_OCR_CHANNEL,
  SCREENSHOT_SAVE_IMAGE_CHANNEL,
  SET_PLUGIN_ENABLED_CHANNEL,
  START_HOTKEY_INPUT_CAPTURE_CHANNEL,
  STOP_HOTKEY_INPUT_CAPTURE_CHANNEL,
  UPDATE_STATUS_CHANGED_CHANNEL,
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
      screenshotHotkey: 'Ctrl+Alt+A',
      delayedScreenshotHotkey: 'Ctrl+Alt+D',
      language: 'zh-CN',
      launchAtLogin: false,
      preserveSearchQuery: false,
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
      createdAt: '2026-05-15T10:00:00.000Z',
      id: 'favorite-wps',
      kind: 'file',
      keywords: ['WPS'],
      metadata: {
        launcherPinnedApp: true,
      },
      path: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
      title: 'WPS Office',
      updatedAt: '2026-05-15T10:00:00.000Z',
    });
    await expect(api.addPinnedApp()).resolves.toMatchObject({
      id: 'favorite-wps',
      title: 'WPS Office',
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(ADD_PINNED_APP_CHANNEL);

    electronMock.invoke.mockResolvedValueOnce(undefined);
    await expect(api.addPinnedApp()).resolves.toBeUndefined();

    const candidate = {
      alreadyPinned: false,
      executablePath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
      icon: 'data:image/png;base64,WPS',
      iconPath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe,0',
      id: 'start-menu.app-wps',
      resolutionStatus: 'resolved' as const,
      shortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\WPS Office.lnk',
      source: 'start-menu' as const,
      subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
      title: 'WPS Office',
    };

    electronMock.invoke.mockResolvedValueOnce([candidate]);
    await expect(api.listAppCandidates('wps')).resolves.toEqual([candidate]);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(LIST_APP_CANDIDATES_CHANNEL, 'wps');

    electronMock.invoke.mockResolvedValueOnce({
      createdAt: '2026-05-15T10:00:00.000Z',
      id: 'favorite-wps',
      kind: 'file',
      keywords: ['WPS Office'],
      metadata: {
        launcherPinnedApp: true,
      },
      path: candidate.shortcutPath,
      title: 'WPS Office',
      updatedAt: '2026-05-15T10:00:00.000Z',
    });
    await expect(api.addPinnedAppCandidate(candidate)).resolves.toMatchObject({
      id: 'favorite-wps',
      title: 'WPS Office',
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      ADD_PINNED_APP_CANDIDATE_CHANNEL,
      candidate,
    );

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

    electronMock.invoke.mockResolvedValueOnce(true);
    await expect(api.removeRecentApp('app.wps')).resolves.toBe(true);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(REMOVE_RECENT_APP_CHANNEL, 'app.wps');

    electronMock.invoke.mockResolvedValueOnce({ path: 'C:\\CommandCabin' });
    await expect(api.getDataDirectory()).resolves.toEqual({ path: 'C:\\CommandCabin' });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(GET_DATA_DIRECTORY_CHANNEL);

    electronMock.invoke.mockResolvedValueOnce({ path: 'C:\\CommandCabin' });
    await expect(api.openDataDirectory()).resolves.toEqual({ path: 'C:\\CommandCabin' });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(OPEN_DATA_DIRECTORY_CHANNEL);
  });

  it('exposes a removable open-settings listener', async () => {
    const api = await loadDesktopApi();
    const listener = vi.fn();

    const removeListener = api.onOpenSettings(listener);
    const registeredListener = electronMock.on.mock.calls.find(
      ([channel]) => channel === OPEN_SETTINGS_CHANNEL,
    )?.[1] as (() => void) | undefined;

    registeredListener?.();
    removeListener();

    expect(listener).toHaveBeenCalledOnce();
    expect(electronMock.removeListener).toHaveBeenCalledWith(
      OPEN_SETTINGS_CHANNEL,
      registeredListener,
    );
  });

  it('exposes update IPC methods and a removable update status listener', async () => {
    const api = await loadDesktopApi();
    const status = {
      canCheck: true,
      canInstall: false,
      phase: 'up-to-date' as const,
      version: '0.2.0',
    };

    electronMock.invoke.mockResolvedValueOnce(status);
    await expect(api.getUpdateStatus()).resolves.toEqual({
      ...status,
      error: undefined,
      percent: undefined,
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(GET_UPDATE_STATUS_CHANNEL);

    electronMock.invoke.mockResolvedValueOnce({ ...status, phase: 'checking' });
    await expect(api.checkForUpdates()).resolves.toMatchObject({ phase: 'checking' });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(CHECK_FOR_UPDATES_CHANNEL);

    electronMock.invoke.mockResolvedValueOnce({ ok: false, error: 'Update is not ready.' });
    await expect(api.installUpdate()).resolves.toEqual({
      error: 'Update is not ready.',
      ok: false,
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(INSTALL_UPDATE_CHANNEL);

    const listener = vi.fn();
    const removeListener = api.onUpdateStatusChanged(listener);
    const registeredListener = electronMock.on.mock.calls.find(
      ([channel]) => channel === UPDATE_STATUS_CHANGED_CHANNEL,
    )?.[1] as ((_event: unknown, payload: unknown) => void) | undefined;

    registeredListener?.(undefined, status);
    removeListener();

    expect(listener).toHaveBeenCalledWith({
      ...status,
      error: undefined,
      percent: undefined,
    });
    expect(electronMock.removeListener).toHaveBeenCalledWith(
      UPDATE_STATUS_CHANGED_CHANNEL,
      registeredListener,
    );
  });

  it('exposes captured hotkey input from the main process', async () => {
    const api = await loadDesktopApi();
    const listener = vi.fn();

    const removeListener = api.onHotkeyInputCapture(listener);
    const registeredListener = electronMock.on.mock.calls.find(
      ([channel]) => channel === HOTKEY_INPUT_CAPTURE_CHANNEL,
    )?.[1] as ((_event: unknown, payload: unknown) => void) | undefined;

    registeredListener?.(undefined, {
      altKey: true,
      ctrlKey: false,
      key: ' ',
      metaKey: false,
      shiftKey: false,
    });
    removeListener();

    expect(listener).toHaveBeenCalledWith({
      altKey: true,
      ctrlKey: false,
      key: ' ',
      metaKey: false,
      shiftKey: false,
    });
    expect(electronMock.removeListener).toHaveBeenCalledWith(
      HOTKEY_INPUT_CAPTURE_CHANNEL,
      registeredListener,
    );
  });

  it('exposes hotkey input capture start and stop requests', async () => {
    const api = await loadDesktopApi();

    electronMock.invoke.mockResolvedValueOnce(true);
    await expect(api.startHotkeyInputCapture()).resolves.toBe(true);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(START_HOTKEY_INPUT_CAPTURE_CHANNEL);

    electronMock.invoke.mockResolvedValueOnce(true);
    await expect(api.stopHotkeyInputCapture()).resolves.toBe(true);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(STOP_HOTKEY_INPUT_CAPTURE_CHANNEL);
  });

  it('exposes screenshot IPC methods with validated requests and parsed responses', async () => {
    const api = await loadDesktopApi();
    const launchState = {
      mode: 'capture' as const,
      displays: [
        {
          bounds: { height: 1080, width: 1920, x: 0, y: 0 },
          id: 1,
          imageDataUrl: 'data:image/png;base64,AAAA',
          scaleFactor: 1,
          sourceId: 'screen:1',
        },
      ],
      virtualBounds: { height: 1080, width: 1920, x: 0, y: 0 },
    };

    electronMock.invoke.mockResolvedValueOnce(launchState);
    await expect(api.screenshot!.getLaunchState()).resolves.toEqual(launchState);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(SCREENSHOT_GET_LAUNCH_STATE_CHANNEL);

    electronMock.invoke.mockResolvedValueOnce(true);
    await expect(api.screenshot!.cancel()).resolves.toBe(true);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(SCREENSHOT_CANCEL_CHANNEL);

    electronMock.invoke.mockResolvedValueOnce({ ok: true });
    await expect(
      api.screenshot!.copyImage({ imageDataUrl: 'data:image/png;base64,AAAA' }),
    ).resolves.toEqual({ ok: true });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(SCREENSHOT_COPY_IMAGE_CHANNEL, {
      imageDataUrl: 'data:image/png;base64,AAAA',
    });

    electronMock.invoke.mockResolvedValueOnce({ canceled: false, filePath: 'C:\\capture.jpg' });
    await expect(
      api.screenshot!.saveImage({
        format: 'jpg',
        imageDataUrl: 'data:image/jpeg;base64,BBBB',
      }),
    ).resolves.toEqual({ canceled: false, filePath: 'C:\\capture.jpg' });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(SCREENSHOT_SAVE_IMAGE_CHANNEL, {
      format: 'jpg',
      imageDataUrl: 'data:image/jpeg;base64,BBBB',
    });

    electronMock.invoke.mockResolvedValueOnce({ id: 'pin-1' });
    await expect(
      api.screenshot!.pinImage({ imageDataUrl: 'data:image/png;base64,AAAA' }),
    ).resolves.toEqual({ id: 'pin-1' });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(SCREENSHOT_PIN_IMAGE_CHANNEL, {
      imageDataUrl: 'data:image/png;base64,AAAA',
    });

    electronMock.invoke.mockResolvedValueOnce({
      language: 'en-US',
      lines: ['hello'],
      status: 'success',
      text: 'hello',
    });
    await expect(
      api.screenshot!.runOcr({ imageDataUrl: 'data:image/png;base64,AAAA', language: 'en-US' }),
    ).resolves.toEqual({
      language: 'en-US',
      lines: ['hello'],
      status: 'success',
      text: 'hello',
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(SCREENSHOT_RUN_OCR_CHANNEL, {
      imageDataUrl: 'data:image/png;base64,AAAA',
      language: 'en-US',
    });

    electronMock.invoke.mockResolvedValueOnce({
      imageDataUrl: 'data:image/png;base64,AAAA',
      token: 'pin-1',
    });
    await expect(api.screenshot!.getPinnedImageState('pin-1')).resolves.toEqual({
      imageDataUrl: 'data:image/png;base64,AAAA',
      token: 'pin-1',
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      SCREENSHOT_GET_PINNED_IMAGE_STATE_CHANNEL,
      'pin-1',
    );

    await expect(
      api.screenshot!.copyImage({ imageDataUrl: 'data:image/gif;base64,AAAA' }),
    ).rejects.toThrow(/image data url/i);
  });
});
