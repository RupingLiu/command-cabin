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

  it('does not re-check once an update package is downloaded', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-downloaded', { version: '0.3.0' });

    await expect(controller.checkForUpdates()).resolves.toMatchObject({
      canInstall: true,
      phase: 'downloaded',
      version: '0.3.0',
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('publishes download progress and downloaded state', () => {
    createUpdateController({
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
        canInstall: true,
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

    expect(controller.installUpdate()).toEqual({ ok: true });
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });
});
