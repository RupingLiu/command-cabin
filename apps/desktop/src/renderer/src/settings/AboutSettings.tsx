import { useCallback, useEffect, useMemo, useState } from 'react';

import type { DesktopAppInfo } from '../../../preload/index.js';
import type { UpdateInstallResult, UpdateStatus } from '../../../shared/updateApi.js';
import { getUiStrings, type UiStrings } from '../i18n.js';

export interface AboutSettingsApi {
  checkForUpdates: () => Promise<UpdateStatus>;
  getUpdateStatus: () => Promise<UpdateStatus>;
  installUpdate: () => Promise<UpdateInstallResult>;
  onUpdateStatusChanged: (listener: (status: UpdateStatus) => void) => () => void;
  openRepository: () => Promise<boolean>;
}

export interface AboutSettingsState {
  errorMessage: string | undefined;
  isChecking: boolean;
  isInstalling: boolean;
  status: UpdateStatus;
}

export interface AboutSettingsProps {
  api?: AboutSettingsApi | undefined;
  appInfo: DesktopAppInfo;
  state?: AboutSettingsState | undefined;
  strings?: UiStrings['settings']['about'] | undefined;
}

const initialStatus: UpdateStatus = {
  canCheck: false,
  canInstall: false,
  phase: 'idle',
};

function getDefaultAboutSettingsApi(): AboutSettingsApi | undefined {
  if (typeof window === 'undefined' || !('desktopApi' in window)) {
    return undefined;
  }

  return window.desktopApi;
}

function formatTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (formatted, [key, value]) => formatted.replaceAll(`{${key}}`, value),
    template,
  );
}

function formatPercent(percent: number | undefined): string {
  return Math.round(percent ?? 0).toString();
}

function getStatusText(status: UpdateStatus, strings: UiStrings['settings']['about']): string {
  const version = status.version ?? '';

  if (status.phase === 'checking') {
    return strings.checking;
  }
  if (status.phase === 'available') {
    return formatTemplate(strings.updateAvailable, { version });
  }
  if (status.phase === 'downloading') {
    return formatTemplate(strings.downloading, {
      percent: formatPercent(status.percent),
      version,
    });
  }
  if (status.phase === 'downloaded') {
    return formatTemplate(strings.downloaded, { version });
  }
  if (status.phase === 'up-to-date') {
    return strings.upToDate;
  }
  if (status.phase === 'error') {
    return status.error ?? strings.error;
  }
  if (status.phase === 'unavailable') {
    return status.error ?? strings.unavailable;
  }

  return strings.idle;
}

export function openRepositoryFromSettings(
  api: Pick<AboutSettingsApi, 'openRepository'> | undefined,
): Promise<boolean> {
  return api?.openRepository() ?? Promise.resolve(false);
}

export function AboutSettings({
  api,
  appInfo,
  state,
  strings = getUiStrings(undefined).settings.about,
}: AboutSettingsProps) {
  const updatesApi = useMemo(() => api ?? getDefaultAboutSettingsApi(), [api]);
  const [internalState, setInternalState] = useState<AboutSettingsState>({
    errorMessage: undefined,
    isChecking: false,
    isInstalling: false,
    status: initialStatus,
  });
  const currentState = state ?? internalState;
  const versionText = formatTemplate(strings.version, {
    name: appInfo.name,
    version: appInfo.version,
  });
  const statusText = getStatusText(currentState.status, strings);

  useEffect(() => {
    if (!updatesApi || state) {
      return;
    }

    let isCurrent = true;

    updatesApi
      .getUpdateStatus()
      .then((status) => {
        if (isCurrent) {
          setInternalState((current) => ({ ...current, status }));
        }
      })
      .catch((error: unknown) => {
        if (isCurrent) {
          setInternalState((current) => ({
            ...current,
            errorMessage: error instanceof Error ? error.message : strings.error,
          }));
        }
      });

    const removeListener = updatesApi.onUpdateStatusChanged((status) => {
      setInternalState((current) => ({ ...current, errorMessage: undefined, status }));
    });

    return () => {
      isCurrent = false;
      removeListener();
    };
  }, [state, strings.error, updatesApi]);

  const handleCheckForUpdates = useCallback(async () => {
    if (!updatesApi || state) {
      return;
    }

    setInternalState((current) => ({ ...current, errorMessage: undefined, isChecking: true }));

    try {
      const status = await updatesApi.checkForUpdates();
      setInternalState((current) => ({ ...current, status }));
    } catch (error) {
      setInternalState((current) => ({
        ...current,
        errorMessage: error instanceof Error ? error.message : strings.error,
      }));
    } finally {
      setInternalState((current) => ({ ...current, isChecking: false }));
    }
  }, [state, strings.error, updatesApi]);

  const handleInstallUpdate = useCallback(async () => {
    if (!updatesApi || state) {
      return;
    }

    setInternalState((current) => ({ ...current, errorMessage: undefined, isInstalling: true }));

    try {
      const result = await updatesApi.installUpdate();

      if (!result.ok) {
        setInternalState((current) => ({ ...current, errorMessage: result.error }));
      }
    } catch (error) {
      setInternalState((current) => ({
        ...current,
        errorMessage: error instanceof Error ? error.message : strings.error,
      }));
    } finally {
      setInternalState((current) => ({ ...current, isInstalling: false }));
    }
  }, [state, strings.error, updatesApi]);

  const handleOpenRepository = useCallback(async () => {
    try {
      await openRepositoryFromSettings(updatesApi);
    } catch (error) {
      setInternalState((current) => ({
        ...current,
        errorMessage: error instanceof Error ? error.message : strings.error,
      }));
    }
  }, [strings.error, updatesApi]);

  return (
    <section className="settings-section about-settings" aria-label={strings.ariaLabel}>
      <header className="settings-section__header">
        <h2>{strings.title}</h2>
        <span>{versionText}</span>
      </header>
      <p className="about-settings__status" role="status" aria-live="polite">
        {statusText}
      </p>
      {currentState.errorMessage ? (
        <p className="settings-section__error" role="alert">
          {currentState.errorMessage}
        </p>
      ) : null}
      <div className="about-settings__actions">
        <button
          disabled={!updatesApi?.openRepository}
          type="button"
          onClick={() => void handleOpenRepository()}
        >
          {strings.repository}
        </button>
        <button
          disabled={!currentState.status.canCheck || currentState.isChecking}
          type="button"
          onClick={() => void handleCheckForUpdates()}
        >
          {currentState.isChecking ? strings.checking : strings.check}
        </button>
        {currentState.status.canInstall ? (
          <button
            disabled={currentState.isInstalling}
            type="button"
            onClick={() => void handleInstallUpdate()}
          >
            {currentState.isInstalling ? strings.installing : strings.install}
          </button>
        ) : null}
      </div>
    </section>
  );
}
