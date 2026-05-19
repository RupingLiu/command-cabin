import type { CommandCabinLanguage } from '@command-cabin/core';
import { useEffect, useState } from 'react';

import { ResultItem } from './ResultItem.js';
import {
  getLauncherOptionId,
  type LauncherResultItem,
  type LauncherStatus,
} from './useLauncherController.js';
import { getUiStrings } from '../i18n.js';

interface ResultListProps {
  errorMessage: string | undefined;
  isExecutionDisabled: boolean;
  language?: CommandCabinLanguage | undefined;
  listboxId: string;
  onAddPinnedApp?: (() => void) | undefined;
  onEditPinnedApp?: ((favoriteId: string) => void) | undefined;
  onExecute: () => void;
  onRemovePinnedApp?: ((favoriteId: string) => void) | undefined;
  onRemoveRecentApp?: ((commandId: string) => void) | undefined;
  onSelect: (index: number) => void;
  query: string;
  results: LauncherResultItem[];
  selectedIndex: number;
  status: LauncherStatus;
}

function StatePanel({
  ariaLabel,
  detail,
  listboxId,
  title,
  tone,
}: {
  ariaLabel: string;
  detail: string;
  listboxId: string;
  title: string;
  tone: 'error' | 'muted';
}) {
  return (
    <div
      aria-label={ariaLabel}
      className="result-state"
      data-tone={tone}
      id={listboxId}
      role="listbox"
    >
      <div role={tone === 'error' ? 'alert' : 'status'}>
        <p>{title}</p>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function LoadingRows({ ariaLabel, listboxId }: { ariaLabel: string; listboxId: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={ariaLabel}
      className="result-skeleton"
      id={listboxId}
      role="listbox"
    >
      <span />
      <span />
      <span />
    </div>
  );
}

interface PinnedAppMenuState {
  favoriteId?: string | undefined;
  commandId: string;
  x: number;
  y: number;
}

function shouldUseRecentAppGrid(query: string, results: readonly LauncherResultItem[]): boolean {
  return (
    query.trim().length === 0 &&
    results.length > 0 &&
    results.every((result) => result.source === 'app')
  );
}

function AddPinnedAppItem({
  label,
  onAddPinnedApp,
}: {
  label: string;
  onAddPinnedApp: () => void;
}) {
  return (
    <li className="result-item result-item--recent-app result-item--add-app">
      <button
        aria-label={label}
        type="button"
        onClick={onAddPinnedApp}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
      >
        <span className="result-icon result-icon--add" aria-hidden="true">
          +
        </span>
        <span className="result-copy">
          <span className="result-title">{label}</span>
        </span>
      </button>
    </li>
  );
}

export function ResultList({
  errorMessage,
  isExecutionDisabled,
  listboxId,
  onAddPinnedApp,
  onEditPinnedApp,
  onExecute,
  onRemovePinnedApp,
  onRemoveRecentApp,
  onSelect,
  language,
  query,
  results,
  selectedIndex,
  status,
}: ResultListProps) {
  const strings = getUiStrings(language);
  const [pinnedAppMenu, setPinnedAppMenu] = useState<PinnedAppMenuState | undefined>(undefined);

  function canManageAppResult(result: LauncherResultItem): boolean {
    if (result.source !== 'app') {
      return false;
    }

    if (result.favoriteId !== undefined) {
      return onEditPinnedApp !== undefined || onRemovePinnedApp !== undefined;
    }

    return onRemoveRecentApp !== undefined;
  }

  useEffect(() => {
    if (pinnedAppMenu === undefined) {
      return;
    }

    const closeMenu = () => {
      setPinnedAppMenu(undefined);
    };
    const closeMenuWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };

    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', closeMenuWithKeyboard);
    window.addEventListener('blur', closeMenu);

    return () => {
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', closeMenuWithKeyboard);
      window.removeEventListener('blur', closeMenu);
    };
  }, [pinnedAppMenu]);

  if (status === 'loading' || status === 'idle') {
    return <LoadingRows ariaLabel={strings.launcher.results.ariaLabel} listboxId={listboxId} />;
  }

  if (status === 'error') {
    return (
      <StatePanel
        ariaLabel={strings.launcher.results.ariaLabel}
        detail={errorMessage ?? strings.launcher.results.errorDetail}
        listboxId={listboxId}
        title={strings.launcher.results.errorTitle}
        tone="error"
      />
    );
  }

  const canAddPinnedApp = query.trim().length === 0 && onAddPinnedApp !== undefined;

  if (status === 'empty' && canAddPinnedApp) {
    return (
      <ul
        aria-label={strings.launcher.results.ariaLabel}
        className="result-list result-list--recent-apps"
        id={listboxId}
        role="listbox"
      >
        <AddPinnedAppItem label={strings.launcher.addPinnedApp} onAddPinnedApp={onAddPinnedApp} />
      </ul>
    );
  }

  if (status === 'empty') {
    return (
      <StatePanel
        ariaLabel={strings.launcher.results.ariaLabel}
        detail={
          query.trim().length > 0
            ? strings.launcher.results.noMatches
            : strings.launcher.results.noCommands
        }
        listboxId={listboxId}
        title={strings.launcher.results.noResults}
        tone="muted"
      />
    );
  }

  const useRecentAppGrid = shouldUseRecentAppGrid(query, results);

  return (
    <>
      <ul
        aria-label={strings.launcher.results.ariaLabel}
        className={useRecentAppGrid ? 'result-list result-list--recent-apps' : 'result-list'}
        id={listboxId}
        role="listbox"
      >
        {results.map((result, index) => (
          <ResultItem
            id={getLauncherOptionId(result.id)}
            index={index}
            isManageable={canManageAppResult(result)}
            isDisabled={isExecutionDisabled}
            isSelected={index === selectedIndex}
            key={result.id}
            language={language}
            onOpenAppMenu={
              canManageAppResult(result)
                ? (menuResult, position) => {
                    setPinnedAppMenu({
                      commandId: menuResult.id,
                      favoriteId: menuResult.favoriteId,
                      x: position.x,
                      y: position.y,
                    });
                  }
                : undefined
            }
            onExecute={onExecute}
            onSelect={onSelect}
            result={result}
            variant={useRecentAppGrid ? 'compact' : 'detailed'}
          />
        ))}
        {useRecentAppGrid && onAddPinnedApp ? (
          <AddPinnedAppItem label={strings.launcher.addPinnedApp} onAddPinnedApp={onAddPinnedApp} />
        ) : null}
      </ul>
      {pinnedAppMenu ? (
        <div
          className="pinned-app-menu"
          role="menu"
          style={{
            left: pinnedAppMenu.x,
            top: pinnedAppMenu.y,
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          {pinnedAppMenu.favoriteId !== undefined && onEditPinnedApp ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                const favoriteId = pinnedAppMenu.favoriteId;

                if (favoriteId === undefined) {
                  return;
                }

                setPinnedAppMenu(undefined);
                onEditPinnedApp(favoriteId);
              }}
            >
              {strings.launcher.pinnedAppMenu.edit}
            </button>
          ) : null}
          {pinnedAppMenu.favoriteId !== undefined && onRemovePinnedApp ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                const favoriteId = pinnedAppMenu.favoriteId;

                if (favoriteId === undefined) {
                  return;
                }

                setPinnedAppMenu(undefined);
                onRemovePinnedApp(favoriteId);
              }}
            >
              {strings.launcher.pinnedAppMenu.remove}
            </button>
          ) : null}
          {pinnedAppMenu.favoriteId === undefined && onRemoveRecentApp ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                const { commandId } = pinnedAppMenu;
                setPinnedAppMenu(undefined);
                onRemoveRecentApp(commandId);
              }}
            >
              {strings.launcher.pinnedAppMenu.remove}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
