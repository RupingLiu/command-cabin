import { UPDATE_STATUS_CHANGED_CHANNEL } from '../../shared/ipcChannels.js';
import type {
  UpdateCheckResult,
  UpdateInstallResult,
  UpdateStatus,
} from '../../shared/updateApi.js';

interface UpdateInfoLike {
  version?: string | undefined;
}

interface ProgressInfoLike {
  percent?: number | undefined;
}

interface UpdateVersionKnowledge {
  activeDownloadVersion?: string;
  downloadedVersion?: string;
  latestVersion?: string;
}

type UpdateStatusPatch = Pick<UpdateStatus, 'phase'> &
  Partial<Pick<UpdateStatus, 'error' | 'percent' | 'version'>>;

type UpdaterEvent =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error';

export interface UpdateControllerAutoUpdater {
  autoInstallOnAppQuit: boolean;
  autoDownload: boolean;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  on: (eventName: UpdaterEvent, listener: (...args: unknown[]) => void) => unknown;
  quitAndInstall: () => void;
}

export interface UpdateControllerWindow {
  send: (channel: string, status: UpdateStatus) => void;
}

export interface UpdateController {
  checkForUpdates: () => Promise<UpdateCheckResult>;
  getStatus: () => UpdateStatus;
  installUpdate: () => UpdateInstallResult;
  startAutomaticCheck: () => void;
}

export interface UpdateControllerOptions {
  autoUpdater: UpdateControllerAutoUpdater;
  automaticCheckIntervalMs?: number | undefined;
  getWindows: () => readonly UpdateControllerWindow[];
  isPackaged: boolean;
  logger?: Pick<Console, 'error' | 'log'> | undefined;
}

const defaultAutomaticCheckIntervalMs = 6 * 60 * 60 * 1000;

function getVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const version = (value as UpdateInfoLike).version;
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : undefined;
}

function getPercent(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const percent = (value as ProgressInfoLike).percent;

  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, percent));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  return 'Update check failed.';
}

export function createUpdateController({
  autoUpdater,
  automaticCheckIntervalMs = defaultAutomaticCheckIntervalMs,
  getWindows,
  isPackaged,
  logger = console,
}: UpdateControllerOptions): UpdateController {
  let status: UpdateStatus = isPackaged
    ? {
        canCheck: true,
        canInstall: false,
        phase: 'idle',
      }
    : {
        canCheck: false,
        canInstall: false,
        error: 'Automatic updates are available only in installed builds.',
        phase: 'unavailable',
      };
  let checkInFlight: Promise<UpdateCheckResult> | undefined;
  let automaticCheckStarted = false;
  let automaticCheckTimer: ReturnType<typeof setInterval> | undefined;
  let versionKnowledge: UpdateVersionKnowledge = {};

  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoDownload = false;

  function publish(nextStatus: UpdateStatus): UpdateStatus {
    status = nextStatus;

    for (const window of getWindows()) {
      window.send(UPDATE_STATUS_CHANGED_CHANNEL, status);
    }

    return status;
  }

  function getVersionKnowledgeStatus(): Partial<UpdateStatus> {
    return {
      ...(versionKnowledge.activeDownloadVersion !== undefined
        ? { activeDownloadVersion: versionKnowledge.activeDownloadVersion }
        : {}),
      ...(versionKnowledge.downloadedVersion !== undefined
        ? { downloadedVersion: versionKnowledge.downloadedVersion }
        : {}),
      ...(versionKnowledge.latestVersion !== undefined
        ? { latestVersion: versionKnowledge.latestVersion }
        : {}),
    };
  }

  function mergeStatus(patch: UpdateStatusPatch): UpdateStatus {
    const canInstall =
      patch.phase === 'downloaded' &&
      versionKnowledge.downloadedVersion !== undefined &&
      versionKnowledge.latestVersion !== undefined &&
      versionKnowledge.downloadedVersion === versionKnowledge.latestVersion;
    const isBusy =
      patch.phase === 'checking' || patch.phase === 'available' || patch.phase === 'downloading';
    const canCheck = isPackaged && !isBusy && !(patch.phase === 'downloaded' && canInstall);
    const version = patch.version ?? status.version;

    return publish({
      ...getVersionKnowledgeStatus(),
      canCheck,
      canInstall,
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.percent !== undefined ? { percent: patch.percent } : {}),
      phase: patch.phase,
      ...(version !== undefined ? { version } : {}),
    });
  }

  autoUpdater.on('checking-for-update', () => {
    mergeStatus({ phase: 'checking' });
  });

  autoUpdater.on('update-available', (info: unknown) => {
    const latestVersion = getVersion(info);

    if (latestVersion !== undefined) {
      versionKnowledge = {
        ...versionKnowledge,
        activeDownloadVersion: latestVersion,
        latestVersion,
      };
    }

    mergeStatus({ phase: 'available', version: latestVersion });
    void autoUpdater.downloadUpdate().catch((error: unknown) => {
      logger.error('Update download failed.', error);
      mergeStatus({
        error: getErrorMessage(error),
        phase: 'error',
        version: versionKnowledge.latestVersion,
      });
    });
  });

  autoUpdater.on('update-not-available', (info: unknown) => {
    const latestVersion = getVersion(info);

    if (latestVersion !== undefined) {
      versionKnowledge = {
        ...versionKnowledge,
        latestVersion,
      };
    }

    mergeStatus({ phase: 'up-to-date', version: latestVersion });
  });

  autoUpdater.on('download-progress', (progress: unknown) => {
    mergeStatus({
      percent: getPercent(progress),
      phase: 'downloading',
      version: versionKnowledge.activeDownloadVersion ?? versionKnowledge.latestVersion,
    });
  });

  autoUpdater.on('update-downloaded', (info: unknown) => {
    const downloadedVersion = getVersion(info);

    if (downloadedVersion !== undefined) {
      versionKnowledge = {
        ...versionKnowledge,
        downloadedVersion,
      };
    }

    if (
      downloadedVersion !== undefined &&
      versionKnowledge.latestVersion !== undefined &&
      downloadedVersion === versionKnowledge.latestVersion
    ) {
      delete versionKnowledge.activeDownloadVersion;
      mergeStatus({ phase: 'downloaded', version: downloadedVersion });
      return;
    }

    if (versionKnowledge.activeDownloadVersion !== undefined) {
      mergeStatus({ phase: 'downloading', version: versionKnowledge.activeDownloadVersion });
      return;
    }

    mergeStatus({ phase: 'downloaded', version: downloadedVersion });
  });

  autoUpdater.on('error', (error: unknown) => {
    logger.error('Updater failed.', error);
    mergeStatus({
      error: getErrorMessage(error),
      phase: 'error',
      version: versionKnowledge.latestVersion,
    });
  });

  async function checkForUpdates(): Promise<UpdateCheckResult> {
    if (!isPackaged) {
      return status;
    }

    if (
      status.phase === 'checking' ||
      status.phase === 'available' ||
      status.phase === 'downloading' ||
      (status.phase === 'downloaded' && status.canInstall)
    ) {
      return status;
    }

    if (checkInFlight) {
      return checkInFlight;
    }

    mergeStatus({ phase: 'checking' });

    checkInFlight = autoUpdater
      .checkForUpdates()
      .then(() => {
        if (status.phase === 'checking') {
          return mergeStatus({ phase: 'up-to-date' });
        }

        return status;
      })
      .catch((error: unknown) => {
        logger.error('Update check failed.', error);
        return mergeStatus({ error: getErrorMessage(error), phase: 'error' });
      })
      .finally(() => {
        checkInFlight = undefined;
      });

    return checkInFlight;
  }

  return {
    checkForUpdates,
    getStatus: () => status,
    installUpdate: () => {
      if (status.phase !== 'downloaded' || !status.canInstall) {
        return {
          error: 'Update is not ready to install.',
          ok: false,
        };
      }

      autoUpdater.quitAndInstall();
      return { ok: true };
    },
    startAutomaticCheck: () => {
      if (automaticCheckStarted) {
        return;
      }

      automaticCheckStarted = true;
      void checkForUpdates();
      if (isPackaged && automaticCheckIntervalMs > 0 && !automaticCheckTimer) {
        automaticCheckTimer = setInterval(() => {
          void checkForUpdates();
        }, automaticCheckIntervalMs);
      }
    },
  };
}
