import type { CommandCabinLanguage } from '@command-cabin/core';
import { useState } from 'react';

import type { LauncherResultItem } from './useLauncherController.js';
import { getUiStrings, localizeLauncherResult } from '../i18n.js';

interface ResultItemProps {
  id: string;
  index: number;
  isManageable?: boolean | undefined;
  isDisabled: boolean;
  isSelected: boolean;
  language?: CommandCabinLanguage | undefined;
  onExecute: (commandId: string) => void;
  onOpenAppMenu?:
    | ((
        result: LauncherResultItem,
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

const QUICK_CONVERTER_RESULT_COMMAND_ID = 'quick-converter.result';
const STRUCTURED_RESULT_SEPARATOR_PATTERN = /\s+=\s+/u;

export function getResultIconGlyph(result: LauncherResultItem): string {
  return result.title.trim().slice(0, 1).toUpperCase() || '?';
}

export function getStructuredResultTitleLines(
  result: LauncherResultItem,
): readonly string[] | undefined {
  if (result.id !== QUICK_CONVERTER_RESULT_COMMAND_ID) {
    return undefined;
  }

  const lines = result.title
    .split(STRUCTURED_RESULT_SEPARATOR_PATTERN)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.length > 1 ? lines : undefined;
}

function isImageDataUrl(icon: string | undefined): icon is string {
  return typeof icon === 'string' && icon.startsWith('data:image/');
}

export type RenderableResultIcon =
  | {
      kind: 'glyph';
      value: string;
    }
  | {
      kind: 'image';
      src: string;
    };

export function getRenderableResultIcon(
  result: LauncherResultItem,
  failedImageIcon?: string | undefined,
): RenderableResultIcon {
  if (isImageDataUrl(result.icon) && result.icon !== failedImageIcon) {
    return {
      kind: 'image',
      src: result.icon,
    };
  }

  return {
    kind: 'glyph',
    value: getResultIconGlyph(result),
  };
}

function ResultIcon({ result }: { result: LauncherResultItem }) {
  const [failedImageIcon, setFailedImageIcon] = useState<string | undefined>(undefined);
  const renderableIcon = getRenderableResultIcon(result, failedImageIcon);

  return (
    <span className="result-icon" aria-hidden="true">
      {renderableIcon.kind === 'image' ? (
        <img
          alt=""
          src={renderableIcon.src}
          onError={() => {
            setFailedImageIcon(renderableIcon.src);
          }}
        />
      ) : (
        renderableIcon.value
      )}
    </span>
  );
}

export function ResultItem({
  id,
  index,
  isManageable = false,
  isDisabled,
  isSelected,
  language,
  onExecute,
  onOpenAppMenu,
  onSelect,
  result: rawResult,
  variant = 'detailed',
}: ResultItemProps) {
  const isCompact = variant === 'compact';
  const strings = getUiStrings(language);
  const result = localizeLauncherResult(rawResult, strings);
  const canOpenAppMenu = result.source === 'app' && isManageable && onOpenAppMenu !== undefined;
  const structuredTitleLines = isCompact ? undefined : getStructuredResultTitleLines(result);
  const itemClassName = [
    'result-item',
    isCompact ? 'result-item--recent-app' : undefined,
    structuredTitleLines === undefined ? undefined : 'result-item--structured',
  ]
    .filter((className): className is string => className !== undefined)
    .join(' ');

  return (
    <li
      aria-haspopup={canOpenAppMenu ? 'menu' : undefined}
      aria-disabled={isDisabled}
      aria-selected={isSelected}
      className={itemClassName}
      data-disabled={isDisabled}
      data-manageable={canOpenAppMenu}
      data-selected={isSelected}
      id={id}
      onClick={() => {
        if (!isDisabled) {
          onExecute(result.id);
        }
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onMouseMove={() => {
        if (!isDisabled && !isSelected) {
          onSelect(index);
        }
      }}
      onContextMenu={(event) => {
        if (!canOpenAppMenu) {
          return;
        }

        event.preventDefault();
        onSelect(index);
        onOpenAppMenu(result, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
      role="option"
    >
      <ResultIcon result={result} />
      <span className="result-copy">
        {structuredTitleLines === undefined ? (
          <span className="result-title" title={result.title}>
            {result.title}
          </span>
        ) : (
          <span
            aria-label={result.title}
            className="result-title result-title--structured"
            title={result.title}
          >
            {structuredTitleLines.map((line, lineIndex) => (
              <span
                className={
                  lineIndex === 0
                    ? 'result-title__line result-title__line--source'
                    : 'result-title__line'
                }
                key={`${lineIndex}-${line}`}
              >
                {line}
              </span>
            ))}
          </span>
        )}
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
