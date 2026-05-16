import { useReducer } from 'react';

export interface ClipboardHistorySettingsApi {
  clearClipboardHistory: () => Promise<number>;
}

export interface ClipboardHistorySettingsState {
  clearError: string | undefined;
  isClearing: boolean;
  removedCount?: number;
}

export type ClipboardHistorySettingsAction =
  | {
      type: 'clear-started';
    }
  | {
      removedCount: number;
      type: 'clear-succeeded';
    }
  | {
      error: string;
      type: 'clear-failed';
    };

export interface ClipboardHistorySettingsProps {
  api?: ClipboardHistorySettingsApi;
  state?: ClipboardHistorySettingsState;
}

export interface ClipboardHistoryClearGate {
  finish: () => void;
  isBusy: () => boolean;
  tryStart: () => boolean;
}

export function createClipboardHistoryClearGate(): ClipboardHistoryClearGate {
  let isClearing = false;

  return {
    finish: () => {
      isClearing = false;
    },
    isBusy: () => isClearing,
    tryStart: () => {
      if (isClearing) {
        return false;
      }

      isClearing = true;
      return true;
    },
  };
}

export const initialClipboardHistorySettingsState: ClipboardHistorySettingsState = {
  clearError: undefined,
  isClearing: false,
};

export function clipboardHistorySettingsReducer(
  state: ClipboardHistorySettingsState,
  action: ClipboardHistorySettingsAction,
): ClipboardHistorySettingsState {
  switch (action.type) {
    case 'clear-started':
      return {
        clearError: undefined,
        isClearing: true,
      };
    case 'clear-succeeded':
      return {
        clearError: undefined,
        isClearing: false,
        removedCount: action.removedCount,
      };
    case 'clear-failed':
      return {
        clearError: action.error,
        isClearing: false,
      };
  }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  return 'Could not clear clipboard history.';
}

export async function runClipboardHistoryClear(
  api: ClipboardHistorySettingsApi | undefined,
  dispatch: (action: ClipboardHistorySettingsAction) => void,
): Promise<number | undefined> {
  if (!api) {
    dispatch({
      error: 'Clipboard history API is unavailable.',
      type: 'clear-failed',
    });
    return undefined;
  }

  dispatch({
    type: 'clear-started',
  });

  try {
    const removedCount = await api.clearClipboardHistory();
    dispatch({
      removedCount,
      type: 'clear-succeeded',
    });
    return removedCount;
  } catch (error) {
    dispatch({
      error: formatUnknownError(error),
      type: 'clear-failed',
    });
    return undefined;
  }
}

function getDefaultClipboardHistorySettingsApi(): ClipboardHistorySettingsApi | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.desktopApi;
}

export function ClipboardHistorySettings({ api, state }: ClipboardHistorySettingsProps) {
  const settingsApi = api ?? getDefaultClipboardHistorySettingsApi();
  const [internalState, dispatch] = useReducer(
    clipboardHistorySettingsReducer,
    initialClipboardHistorySettingsState,
  );
  const currentState = state ?? internalState;

  async function handleClearHistory(): Promise<void> {
    if (currentState.isClearing) {
      return;
    }

    await runClipboardHistoryClear(settingsApi, dispatch);
  }

  return (
    <section className="clipboard-history-settings" aria-label="Clipboard history settings">
      <header className="clipboard-history-settings__header">
        <h2>Clipboard History</h2>
      </header>
      {currentState.clearError ? (
        <p className="clipboard-history-settings__error" role="alert">
          {currentState.clearError}
        </p>
      ) : undefined}
      <button
        aria-busy={currentState.isClearing}
        disabled={currentState.isClearing}
        type="button"
        onClick={() => void handleClearHistory()}
      >
        {currentState.isClearing ? 'Clearing history' : 'Clear history'}
      </button>
    </section>
  );
}
