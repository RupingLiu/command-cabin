import { ResultItem } from './ResultItem.js';
import {
  getLauncherOptionId,
  type LauncherResultItem,
  type LauncherStatus,
} from './useLauncherController.js';

interface ResultListProps {
  errorMessage: string | undefined;
  isExecutionDisabled: boolean;
  listboxId: string;
  onExecute: () => void;
  onSelect: (index: number) => void;
  query: string;
  results: LauncherResultItem[];
  selectedIndex: number;
  status: LauncherStatus;
}

function StatePanel({
  detail,
  listboxId,
  title,
  tone,
}: {
  detail: string;
  listboxId: string;
  title: string;
  tone: 'error' | 'muted';
}) {
  return (
    <div
      aria-label="Command results"
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

function LoadingRows({ listboxId }: { listboxId: string }) {
  return (
    <div
      aria-busy="true"
      aria-label="Command results"
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

export function ResultList({
  errorMessage,
  isExecutionDisabled,
  listboxId,
  onExecute,
  onSelect,
  query,
  results,
  selectedIndex,
  status,
}: ResultListProps) {
  if (status === 'loading' || status === 'idle') {
    return <LoadingRows listboxId={listboxId} />;
  }

  if (status === 'error') {
    return (
      <StatePanel
        detail={errorMessage ?? 'The launcher could not complete the request.'}
        listboxId={listboxId}
        title="Something went wrong"
        tone="error"
      />
    );
  }

  if (status === 'empty') {
    return (
      <StatePanel
        detail={query.trim().length > 0 ? 'No matching commands.' : 'No commands available.'}
        listboxId={listboxId}
        title="No results"
        tone="muted"
      />
    );
  }

  return (
    <ul aria-label="Command results" className="result-list" id={listboxId} role="listbox">
      {results.map((result, index) => (
        <ResultItem
          id={getLauncherOptionId(result.id)}
          index={index}
          isDisabled={isExecutionDisabled}
          isSelected={index === selectedIndex}
          key={result.id}
          onExecute={onExecute}
          onSelect={onSelect}
          result={result}
        />
      ))}
    </ul>
  );
}
