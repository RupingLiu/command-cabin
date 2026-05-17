import type { CommandCabinLanguage } from '@command-cabin/core';

import type { LauncherResultItem } from './useLauncherController.js';
import { getUiStrings, localizeLauncherResult } from '../i18n.js';

interface ResultItemProps {
  id: string;
  index: number;
  isDisabled: boolean;
  isSelected: boolean;
  language?: CommandCabinLanguage | undefined;
  onExecute: () => void;
  onOpenPinnedAppMenu?:
    | ((
        favoriteId: string,
        position: {
          x: number;
          y: number;
        },
      ) => void)
    | undefined;
  onSelect: (index: number) => void;
  result: LauncherResultItem;
  variant?: 'compact' | 'detailed';
}

export function getResultIconGlyph(result: LauncherResultItem): string {
  return result.title.trim().slice(0, 1).toUpperCase() || '?';
}

function isImageDataUrl(icon: string | undefined): icon is string {
  return typeof icon === 'string' && icon.startsWith('data:image/');
}

export function ResultItem({
  id,
  index,
  isDisabled,
  isSelected,
  language,
  onExecute,
  onOpenPinnedAppMenu,
  onSelect,
  result: rawResult,
  variant = 'detailed',
}: ResultItemProps) {
  const isCompact = variant === 'compact';
  const strings = getUiStrings(language);
  const result = localizeLauncherResult(rawResult, strings);
  const canOpenPinnedAppMenu =
    result.source === 'app' && result.favoriteId !== undefined && onOpenPinnedAppMenu !== undefined;

  return (
    <li
      aria-haspopup={canOpenPinnedAppMenu ? 'menu' : undefined}
      aria-disabled={isDisabled}
      aria-selected={isSelected}
      className={isCompact ? 'result-item result-item--recent-app' : 'result-item'}
      data-disabled={isDisabled}
      data-manageable={canOpenPinnedAppMenu}
      data-selected={isSelected}
      id={id}
      onClick={() => {
        if (!isDisabled) {
          onExecute();
        }
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onMouseEnter={() => {
        if (!isDisabled) {
          onSelect(index);
        }
      }}
      onContextMenu={(event) => {
        if (!canOpenPinnedAppMenu) {
          return;
        }

        event.preventDefault();
        onSelect(index);
        onOpenPinnedAppMenu(result.favoriteId!, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
      role="option"
    >
      <span className="result-icon" aria-hidden="true">
        {isImageDataUrl(result.icon) ? (
          <img alt="" src={result.icon} />
        ) : (
          getResultIconGlyph(result)
        )}
      </span>
      <span className="result-copy">
        <span className="result-title">{result.title}</span>
        {!isCompact && result.subtitle ? (
          <span className="result-subtitle">{result.subtitle}</span>
        ) : null}
      </span>
      {isCompact ? null : (
        <span className="result-source">{strings.launcher.sources[result.source]}</span>
      )}
    </li>
  );
}
