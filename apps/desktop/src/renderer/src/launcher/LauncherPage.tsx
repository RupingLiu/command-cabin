import type { CommandCabinLanguage } from '@command-cabin/core';
import { useState } from 'react';

import { AddAppPicker } from './AddAppPicker.js';
import { getUiStrings } from '../i18n.js';
import { ResultList } from './ResultList.js';
import { SearchInput } from './SearchInput.js';
import { useLauncherController } from './useLauncherController.js';
import type { PluginHostEntry } from '../plugin-host/PluginHost.js';

export interface LauncherPageProps {
  language?: CommandCabinLanguage | undefined;
  onOpenSettings?: () => void;
  onOpenPluginPage?: (plugin: PluginHostEntry) => void;
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
      <rect x="22" y="22" width="212" height="212" rx="48" fill="#F7F3EA" />
      <rect x="22" y="22" width="212" height="212" rx="48" stroke="#303A39" strokeWidth="12" />
      <path
        d="M157 84H93C75.3 84 61 98.3 61 116v24c0 17.7 14.3 32 32 32h64"
        stroke="#303A39"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="26"
      />
      <path
        d="M88 112L114 128L88 144"
        stroke="#8EA18C"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="12"
      />
      <path d="M157 146V176" stroke="#9DB7BC" strokeLinecap="round" strokeWidth="22" />
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

export function LauncherPage({ language, onOpenPluginPage, onOpenSettings }: LauncherPageProps) {
  const strings = getUiStrings(language);
  const [isAddAppPickerOpen, setIsAddAppPickerOpen] = useState(false);
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
    removePinnedApp,
    state,
  } = useLauncherController({
    onOpenPluginPage,
    onOpenSettings,
  });
  const isBusy = state.status === 'loading' || state.status === 'executing';

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
          onSelect={selectResult}
          query={state.query}
          results={state.results}
          selectedIndex={state.selectedIndex}
          status={state.status}
        />
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
