import { useCallback, useEffect, useMemo, useState } from 'react';

import type { DataDirectoryResponse } from '../../../shared/settingsApi.js';

export interface DataSettingsApi {
  getDataDirectory: () => Promise<DataDirectoryResponse>;
  openDataDirectory: () => Promise<DataDirectoryResponse>;
}

export interface DataSettingsState {
  errorMessage: string | undefined;
  isLoading: boolean;
  isOpening: boolean;
  path: string | undefined;
}

export interface DataSettingsProps {
  api?: DataSettingsApi;
  state?: DataSettingsState;
}

function getDefaultDataSettingsApi(): DataSettingsApi | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.desktopApi;
}

export function DataSettings({ api, state }: DataSettingsProps) {
  const dataApi = useMemo(() => api ?? getDefaultDataSettingsApi(), [api]);
  const [internalState, setInternalState] = useState<DataSettingsState>({
    errorMessage: undefined,
    isLoading: false,
    isOpening: false,
    path: undefined,
  });
  const currentState = state ?? internalState;

  const loadDataDirectory = useCallback(async () => {
    if (!dataApi || state) {
      return;
    }

    setInternalState((current) => ({
      ...current,
      errorMessage: undefined,
      isLoading: true,
    }));

    try {
      const response = await dataApi.getDataDirectory();
      setInternalState((current) => ({
        ...current,
        isLoading: false,
        path: response.path,
      }));
    } catch (error) {
      setInternalState((current) => ({
        ...current,
        errorMessage: error instanceof Error ? error.message : 'Data directory unavailable.',
        isLoading: false,
      }));
    }
  }, [dataApi, state]);

  useEffect(() => {
    void loadDataDirectory();
  }, [loadDataDirectory]);

  async function handleOpenDataDirectory(): Promise<void> {
    if (!dataApi) {
      setInternalState((current) => ({
        ...current,
        errorMessage: 'Data directory API unavailable.',
      }));
      return;
    }

    setInternalState((current) => ({
      ...current,
      errorMessage: undefined,
      isOpening: true,
    }));

    try {
      await dataApi.openDataDirectory();
    } catch (error) {
      setInternalState((current) => ({
        ...current,
        errorMessage:
          error instanceof Error ? error.message : 'Data directory could not be opened.',
      }));
    } finally {
      setInternalState((current) => ({
        ...current,
        isOpening: false,
      }));
    }
  }

  return (
    <section className="settings-section data-settings" aria-label="Data directory settings">
      <header className="settings-section__header">
        <h2>Data Directory</h2>
      </header>
      {currentState.errorMessage ? (
        <p className="settings-section__error" role="alert">
          {currentState.errorMessage}
        </p>
      ) : null}
      <div className="data-settings__path" aria-busy={currentState.isLoading}>
        {currentState.path ?? 'Loading data directory'}
      </div>
      <button
        aria-busy={currentState.isOpening}
        disabled={currentState.isLoading || currentState.isOpening || !currentState.path}
        type="button"
        onClick={() => void handleOpenDataDirectory()}
      >
        {currentState.isOpening ? 'Opening' : 'Open'}
      </button>
    </section>
  );
}
