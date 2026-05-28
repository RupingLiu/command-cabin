import type { CommandCabinLanguage } from '@command-cabin/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { UpdateInstallResult, UpdateStatus } from '../../../shared/updateApi.js';
import { AddAppPicker } from './AddAppPicker.js';
import { getUiStrings } from '../i18n.js';
import { ResultList } from './ResultList.js';
import { SearchInput } from './SearchInput.js';
import { useLauncherController } from './useLauncherController.js';
import type { PluginHostEntry } from '../plugin-host/PluginHost.js';

export interface LauncherPageProps {
  language?: CommandCabinLanguage | undefined;
  onOpenSettings?: () => void;
  onOpenUnitConverter?: () => void;
  onOpenPluginPage?: (plugin: PluginHostEntry) => void;
  updateState?: LauncherUpdateState | undefined;
  updatesApi?: LauncherUpdateApi | undefined;
}

export interface LauncherUpdateApi {
  checkForUpdates: () => Promise<UpdateStatus>;
  installUpdate: () => Promise<UpdateInstallResult>;
  onFocusSearchInput: (listener: () => void) => () => void;
  onUpdateStatusChanged: (listener: (status: UpdateStatus) => void) => () => void;
}

export interface LauncherUpdateState {
  errorMessage: string | undefined;
  isInstalling: boolean;
  status: UpdateStatus;
}

function CommandCabinMark() {
  return (
    <svg
      aria-hidden="true"
      className="launcher-brand-mark"
      fill="none"
      viewBox="0 0 256 256"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="commandCabinLauncherMarkBg"
          gradientUnits="userSpaceOnUse"
          x1="46"
          x2="218"
          y1="34"
          y2="218"
        >
          <stop offset="0" stopColor="#FF2D55" />
          <stop offset="0.52" stopColor="#FF9810" />
          <stop offset="1" stopColor="#0A84FF" />
        </linearGradient>
      </defs>
      <rect x="17" y="17" width="222" height="222" rx="58" fill="#FFF9F1" />
      <rect
        x="27"
        y="27"
        width="202"
        height="202"
        rx="50"
        fill="url(#commandCabinLauncherMarkBg)"
      />
      <rect
        x="31"
        y="31"
        width="194"
        height="194"
        rx="46"
        stroke="#FFE3C6"
        strokeOpacity="0.74"
        strokeWidth="7"
      />
      <path
        d="M163 84H98C75.9 84 58 101.9 58 124v24c0 22.1 17.9 40 40 40h65"
        stroke="#FFF4E8"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="27"
      />
      <path
        d="M89 114L119 132L89 150"
        stroke="#FFB000"
        strokeOpacity="0.92"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="15"
      />
      <path d="M162 149V180" stroke="#0A84FF" strokeLinecap="round" strokeWidth="24" />
    </svg>
  );
}

function SettingsGearIcon() {
  return (
    <svg
      aria-hidden="true"
      className="launcher-settings-icon"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="m19.1 13.4.1-1.4-.1-1.4 2-1.5-2-3.4-2.4 1a8 8 0 0 0-2.4-1.4L14 2.8h-4l-.3 2.5a8 8 0 0 0-2.4 1.4l-2.4-1-2 3.4 2 1.5-.1 1.4.1 1.4-2 1.5 2 3.4 2.4-1a8 8 0 0 0 2.4 1.4l.3 2.5h4l.3-2.5a8 8 0 0 0 2.4-1.4l2.4 1 2-3.4-2-1.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

const initialLauncherUpdateState: LauncherUpdateState = {
  errorMessage: undefined,
  isInstalling: false,
  status: {
    canCheck: false,
    canInstall: false,
    phase: 'idle',
  },
};

function getDefaultLauncherUpdateApi(): LauncherUpdateApi | undefined {
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

export function LauncherPage({
  language,
  onOpenPluginPage,
  onOpenSettings,
  onOpenUnitConverter,
  updateState,
  updatesApi,
}: LauncherPageProps) {
  const strings = getUiStrings(language);
  const launcherUpdateApi = useMemo(
    () => updatesApi ?? getDefaultLauncherUpdateApi(),
    [updatesApi],
  );
  const [isAddAppPickerOpen, setIsAddAppPickerOpen] = useState(false);
  const [internalUpdateState, setInternalUpdateState] = useState<LauncherUpdateState>(
    initialLauncherUpdateState,
  );
  const currentUpdateState = updateState ?? internalUpdateState;
  const {
    activeDescendantId,
    appInfo,
    editPinnedApp,
    executeSelectedCommand,
    handleKeyDown,
    inputRef,
    isExecutionDisabled,
    isExpanded,
    resultListboxId,
    refreshCurrentQuery,
    searchInputId,
    selectResult,
    setQuery,
    startScreenshotCapture,
    removePinnedApp,
    removeRecentApp,
    state,
  } = useLauncherController({
    onOpenPluginPage,
    onOpenSettings,
  });
  const isBusy = state.status === 'loading' || state.status === 'executing';
  const updateBanner = useMemo(() => {
    const version = currentUpdateState.status.version ?? '';

    if (currentUpdateState.status.phase === 'downloading') {
      return {
        action: 'none' as const,
        detail: undefined,
        text: formatTemplate(strings.launcher.updateBanner.downloading, {
          percent: formatPercent(currentUpdateState.status.percent),
          version,
        }),
      };
    }

    if (currentUpdateState.status.phase === 'downloaded') {
      return {
        action: currentUpdateState.status.canInstall ? ('install' as const) : ('none' as const),
        detail: undefined,
        text: formatTemplate(strings.launcher.updateBanner.ready, { version }),
      };
    }

    if (currentUpdateState.status.phase === 'error') {
      return {
        action: 'settings' as const,
        detail:
          currentUpdateState.status.error ??
          currentUpdateState.errorMessage ??
          strings.launcher.updateBanner.error,
        text: strings.launcher.updateBanner.checkFailed,
      };
    }

    return undefined;
  }, [
    currentUpdateState.errorMessage,
    currentUpdateState.status.canInstall,
    currentUpdateState.status.error,
    currentUpdateState.status.percent,
    currentUpdateState.status.phase,
    currentUpdateState.status.version,
    strings.launcher.updateBanner.checkFailed,
    strings.launcher.updateBanner.downloading,
    strings.launcher.updateBanner.error,
    strings.launcher.updateBanner.ready,
  ]);

  const checkForUpdates = useCallback(async () => {
    if (!launcherUpdateApi || updateState) {
      return;
    }

    try {
      const status = await launcherUpdateApi.checkForUpdates();
      setInternalUpdateState((current) => ({
        ...current,
        errorMessage: undefined,
        status,
      }));
    } catch {
      setInternalUpdateState((current) => ({
        ...current,
        errorMessage: undefined,
      }));
    }
  }, [launcherUpdateApi, updateState]);

  const installUpdate = useCallback(async () => {
    if (!launcherUpdateApi || updateState) {
      return;
    }

    setInternalUpdateState((current) => ({
      ...current,
      errorMessage: undefined,
      isInstalling: true,
    }));

    try {
      const result = await launcherUpdateApi.installUpdate();

      if (!result.ok) {
        setInternalUpdateState((current) => ({
          ...current,
          errorMessage: result.error,
        }));
      }
    } catch (error) {
      setInternalUpdateState((current) => ({
        ...current,
        errorMessage: error instanceof Error ? error.message : strings.launcher.updateBanner.error,
      }));
    } finally {
      setInternalUpdateState((current) => ({
        ...current,
        isInstalling: false,
      }));
    }
  }, [launcherUpdateApi, strings.launcher.updateBanner.error, updateState]);

  useEffect(() => {
    if (!launcherUpdateApi || updateState) {
      return;
    }

    const removeStatusListener = launcherUpdateApi.onUpdateStatusChanged((status) => {
      setInternalUpdateState((current) => ({
        ...current,
        errorMessage: undefined,
        status,
      }));
    });
    const removeFocusListener = launcherUpdateApi.onFocusSearchInput(() => {
      void checkForUpdates();
    });

    void checkForUpdates();

    return () => {
      removeStatusListener();
      removeFocusListener();
    };
  }, [checkForUpdates, launcherUpdateApi, updateState]);

  return (
    <main className="launcher-shell">
      <section className="launcher-frame" aria-label={strings.launcher.ariaLabel}>
        <header className="launcher-titlebar">
          <div className="launcher-title">
            <CommandCabinMark />
            <h1>{appInfo.name}</h1>
          </div>
          <div className="launcher-titlebar__actions">
            <button
              aria-label={strings.launcher.openSettings}
              className="launcher-settings-button"
              title={strings.launcher.openSettings}
              type="button"
              onClick={onOpenSettings}
            >
              <SettingsGearIcon />
            </button>
          </div>
        </header>

        <SearchInput
          activeDescendantId={activeDescendantId}
          inputRef={inputRef}
          isBusy={isBusy}
          isExpanded={isExpanded}
          label={strings.launcher.search.label}
          listboxId={resultListboxId}
          onKeyDown={handleKeyDown}
          onQueryChange={setQuery}
          placeholder={strings.launcher.search.placeholder}
          query={state.query}
          searchInputId={searchInputId}
        />

        <ResultList
          errorMessage={state.errorMessage}
          isExecutionDisabled={isExecutionDisabled}
          language={language}
          listboxId={resultListboxId}
          onAddPinnedApp={() => {
            setIsAddAppPickerOpen(true);
          }}
          onEditPinnedApp={editPinnedApp}
          onExecute={executeSelectedCommand}
          onRemovePinnedApp={removePinnedApp}
          onRemoveRecentApp={removeRecentApp}
          onSelect={selectResult}
          query={state.query}
          results={state.results}
          selectedIndex={state.selectedIndex}
          status={state.status}
        />
        {state.query.trim().length === 0 && updateBanner ? (
          <div className="launcher-update-banner" role="status" aria-live="polite">
            <div className="launcher-update-banner__copy">
              <strong>{updateBanner.text}</strong>
              {updateBanner.detail ? <span role="alert">{updateBanner.detail}</span> : null}
            </div>
            {updateBanner.action === 'install' ? (
              <button
                disabled={!currentUpdateState.status.canInstall || currentUpdateState.isInstalling}
                type="button"
                onClick={() => {
                  void installUpdate();
                }}
              >
                {currentUpdateState.isInstalling
                  ? strings.launcher.updateBanner.installing
                  : strings.launcher.updateBanner.install}
              </button>
            ) : null}
            {updateBanner.action === 'settings' && onOpenSettings ? (
              <button type="button" onClick={onOpenSettings}>
                {strings.launcher.updateBanner.openSettings}
              </button>
            ) : null}
          </div>
        ) : null}
        {state.query.trim().length === 0 ? (
          <div className="launcher-home-actions" aria-label={strings.launcher.homeActionsLabel}>
            <button type="button" onClick={onOpenUnitConverter}>
              <span className="launcher-home-actions__icon" aria-hidden="true">
                ⇄
              </span>
              <span>{strings.launcher.homeActions.unitConverter}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                void startScreenshotCapture();
              }}
            >
              <span className="launcher-home-actions__icon" aria-hidden="true">
                ⛶
              </span>
              <span>{strings.launcher.homeActions.screenshot}</span>
            </button>
          </div>
        ) : null}
        {isAddAppPickerOpen ? (
          <AddAppPicker
            language={language}
            onClose={() => {
              setIsAddAppPickerOpen(false);
            }}
            onPinnedAppAdded={refreshCurrentQuery}
          />
        ) : null}
      </section>
    </main>
  );
}
