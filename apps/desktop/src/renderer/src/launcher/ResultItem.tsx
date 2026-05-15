import type { LauncherResultItem } from './useLauncherController.js';

interface ResultItemProps {
  id: string;
  index: number;
  isDisabled: boolean;
  isSelected: boolean;
  onExecute: () => void;
  onSelect: (index: number) => void;
  result: LauncherResultItem;
}

function formatSource(source: LauncherResultItem['source']): string {
  switch (source) {
    case 'app':
      return 'App';
    case 'file':
      return 'File';
    case 'plugin':
      return 'Plugin';
    case 'system':
      return 'System';
    case 'url':
      return 'URL';
  }
}

export function ResultItem({
  id,
  index,
  isDisabled,
  isSelected,
  onExecute,
  onSelect,
  result,
}: ResultItemProps) {
  return (
    <li
      aria-disabled={isDisabled}
      aria-selected={isSelected}
      className="result-item"
      data-disabled={isDisabled}
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
      role="option"
    >
      <span className="result-icon" aria-hidden="true">
        {result.icon ?? result.title.slice(0, 1).toUpperCase()}
      </span>
      <span className="result-copy">
        <span className="result-title">{result.title}</span>
        {result.subtitle ? <span className="result-subtitle">{result.subtitle}</span> : null}
      </span>
      <span className="result-source">{formatSource(result.source)}</span>
    </li>
  );
}
