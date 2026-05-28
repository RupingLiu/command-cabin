import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UPDATE_STATUS_CHANGED_CHANNEL } from '../../shared/ipcChannels.js';
import { createUpdateController, type UpdateControllerAutoUpdater } from './updateController.js';

class MockAutoUpdater extends EventEmitter implements UpdateControllerAutoUpdater {
  autoInstallOnAppQuit = true;
  autoDownload = false;
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
}

describe('createUpdateController', () => {
  let updater: MockAutoUpdater;
  let sender: { send: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useRealTimers();
    updater = new MockAutoUpdater();
    sender = { send: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports unavailable status for unpackaged builds', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: false,
      logger: console,
    });

    await expect(controller.checkForUpdates()).resolves.toMatchObject({
      canCheck: false,
      phase: 'unavailable',
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('publishes checking status immediately when a check starts', () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    void controller.checkForUpdates();

    expect(controller.getStatus()).toMatchObject({
      canCheck: false,
      phase: 'checking',
    });
    expect(sender.send).toHaveBeenLastCalledWith(
      UPDATE_STATUS_CHANGED_CHANNEL,
      expect.objectContaining({
        canCheck: false,
        phase: 'checking',
      }),
    );
  });

  it('does not leave the updater stuck in checking when no result event is emitted', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    await expect(controller.checkForUpdates()).resolves.toMatchObject({
      canCheck: true,
      phase: 'up-to-date',
    });
  });

  it('checks for updates and starts automatic downloads when available', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    const check = controller.checkForUpdates();
    updater.emit('update-available', { version: '0.3.0' });
    await check;

    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.autoDownload).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toMatchObject({
      canCheck: false,
      phase: 'available',
      version: '0.3.0',
    });
  });

  it('ignores manual checks while an update download is starting', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    const check = controller.checkForUpdates();
    updater.emit('update-available', { version: '0.3.0' });
    await check;

    await expect(controller.checkForUpdates()).resolves.toMatchObject({
      phase: 'available',
      version: '0.3.0',
    });
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('checks immediately and then on the automatic background interval', async () => {
    vi.useFakeTimers();
    const controller = createUpdateController({
      autoUpdater: updater,
      automaticCheckIntervalMs: 1_000,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    controller.startAutomaticCheck();
    await vi.advanceTimersByTimeAsync(0);

    expect(updater.checkForUpdates).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(999);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('does not re-check once the latest update package is downloaded', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-available', { version: '0.3.0' });
    updater.emit('update-downloaded', { version: '0.3.0' });

    await expect(controller.checkForUpdates()).resolves.toMatchObject({
      canInstall: true,
      downloadedVersion: '0.3.0',
      latestVersion: '0.3.0',
      phase: 'downloaded',
      version: '0.3.0',
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('hides a downloaded package after a newer remote version is discovered', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-available', { version: '1.0.1' });
    updater.emit('update-downloaded', { version: '1.0.1' });
    expect(controller.getStatus()).toMatchObject({
      canInstall: true,
      downloadedVersion: '1.0.1',
      latestVersion: '1.0.1',
      phase: 'downloaded',
    });

    updater.emit('update-available', { version: '1.0.2' });

    expect(controller.getStatus()).toMatchObject({
      activeDownloadVersion: '1.0.2',
      canInstall: false,
      downloadedVersion: '1.0.1',
      latestVersion: '1.0.2',
      phase: 'available',
      version: '1.0.2',
    });
  });

  it('does not mark a stale downloaded event as installable while a newer version is active', () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-available', { version: '1.0.1' });
    updater.emit('update-available', { version: '1.0.2' });
    updater.emit('update-downloaded', { version: '1.0.1' });

    expect(controller.getStatus()).toMatchObject({
      activeDownloadVersion: '1.0.2',
      canInstall: false,
      downloadedVersion: '1.0.1',
      latestVersion: '1.0.2',
      phase: 'downloading',
      version: '1.0.2',
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not fall back to an older downloaded package after a newer download fails', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-available', { version: '1.0.1' });
    updater.emit('update-downloaded', { version: '1.0.1' });

    updater.downloadUpdate = vi.fn(async () => {
      throw new Error('Network timeout');
    });
    updater.emit('update-available', { version: '1.0.2' });
    await Promise.resolve();

    expect(controller.getStatus()).toMatchObject({
      canInstall: false,
      downloadedVersion: '1.0.1',
      error: 'Network timeout',
      latestVersion: '1.0.2',
      phase: 'error',
      version: '1.0.2',
    });
  });

  it('keeps install disabled when downloaded version metadata is missing', () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-downloaded', {});

    expect(controller.getStatus()).toMatchObject({
      canCheck: true,
      canInstall: false,
      phase: 'downloaded',
    });
    expect(controller.installUpdate()).toEqual({
      error: 'Update is not ready to install.',
      ok: false,
    });
  });

  it('publishes download progress and keeps unconfirmed downloads unavailable to install', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('download-progress', { percent: 55.2 });
    updater.emit('update-downloaded', { version: '0.3.0' });

    expect(sender.send).toHaveBeenCalledWith(
      UPDATE_STATUS_CHANGED_CHANNEL,
      expect.objectContaining({
        percent: 55.2,
        phase: 'downloading',
      }),
    );
    expect(sender.send).toHaveBeenLastCalledWith(
      UPDATE_STATUS_CHANGED_CHANNEL,
      expect.objectContaining({
        canCheck: true,
        canInstall: false,
        downloadedVersion: '0.3.0',
        phase: 'downloaded',
        version: '0.3.0',
      }),
    );
    expect(sender.send.mock.lastCall?.[1]).not.toHaveProperty('latestVersion');

    await controller.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('only installs after the latest update is downloaded', () => {
    createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-available', { version: '0.3.0' });
    updater.emit('update-downloaded', { version: '0.3.0' });

    expect(sender.send).toHaveBeenLastCalledWith(
      UPDATE_STATUS_CHANGED_CHANNEL,
      expect.objectContaining({
        canInstall: true,
        latestVersion: '0.3.0',
        phase: 'downloaded',
        version: '0.3.0',
      }),
    );
  });

  it('only installs after an update is downloaded', () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    expect(controller.installUpdate()).toEqual({
      error: 'Update is not ready to install.',
      ok: false,
    });

    updater.emit('update-downloaded', { version: '0.3.0' });

    expect(controller.installUpdate()).toEqual({
      error: 'Update is not ready to install.',
      ok: false,
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    updater.emit('update-available', { version: '0.3.0' });
    updater.emit('update-downloaded', { version: '0.3.0' });

    expect(controller.installUpdate()).toEqual({ ok: true });
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });
});
