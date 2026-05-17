import { useReducer } from 'react';

import { getUiStrings, type UiStrings } from '../i18n.js';

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
  strings?: UiStrings['settings']['clipboardHistory'] | undefined;
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

function formatUnknownError(
  error: unknown,
  fallbackMessage = getUiStrings(undefined).settings.clipboardHistory.clearError,
): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  return fallbackMessage;
}

export async function runClipboardHistoryClear(
  api: ClipboardHistorySettingsApi | undefined,
  dispatch: (action: ClipboardHistorySettingsAction) => void,
  strings = getUiStrings(undefined).settings.clipboardHistory,
): Promise<number | undefined> {
  if (!api) {
    dispatch({
      error: strings.unavailable,
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
      error: formatUnknownError(error, strings.clearError),
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

export function ClipboardHistorySettings({
  api,
  state,
  strings = getUiStrings(undefined).settings.clipboardHistory,
}: ClipboardHistorySettingsProps) {
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

    await runClipboardHistoryClear(settingsApi, dispatch, strings);
  }

  return (
    <section className="clipboard-history-settings" aria-label={strings.ariaLabel}>
      <header className="clipboard-history-settings__header">
        <h2>{strings.title}</h2>
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
        {currentState.isClearing ? strings.clearing : strings.clear}
      </button>
    </section>
  );
}
