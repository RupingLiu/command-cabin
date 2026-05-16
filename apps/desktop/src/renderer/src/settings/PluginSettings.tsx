import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PluginListRecord } from '../../../shared/settingsApi.js';

export interface PluginSettingsApi {
  listPlugins: () => Promise<PluginListRecord[]>;
  removePlugin: (id: string) => Promise<boolean>;
  setPluginEnabled: (id: string, enabled: boolean) => Promise<PluginListRecord | undefined>;
}

export interface PluginSettingsState {
  errorMessage: string | undefined;
  isLoading: boolean;
  operationPluginId: string | undefined;
  plugins: PluginListRecord[];
}

export interface PluginSettingsProps {
  api?: PluginSettingsApi;
  state?: PluginSettingsState;
}

function getDefaultPluginSettingsApi(): PluginSettingsApi | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.desktopApi;
}

function formatPermissions(permissions: readonly string[]): string {
  return permissions.length === 0 ? 'No permissions' : permissions.join(', ');
}

export function PluginSettings({ api, state }: PluginSettingsProps) {
  const pluginApi = useMemo(() => api ?? getDefaultPluginSettingsApi(), [api]);
  const [internalState, setInternalState] = useState<PluginSettingsState>({
    errorMessage: undefined,
    isLoading: false,
    operationPluginId: undefined,
    plugins: [],
  });
  const currentState = state ?? internalState;

  const loadPlugins = useCallback(async () => {
    if (!pluginApi || state) {
      return;
    }

    setInternalState((current) => ({
      ...current,
      errorMessage: undefined,
      isLoading: true,
    }));

    try {
      const plugins = await pluginApi.listPlugins();
      setInternalState((current) => ({
        ...current,
        isLoading: false,
        plugins,
      }));
    } catch (error) {
      setInternalState((current) => ({
        ...current,
        errorMessage: error instanceof Error ? error.message : 'Plugins could not be loaded.',
        isLoading: false,
        plugins: [],
      }));
    }
  }, [pluginApi, state]);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  async function runPluginOperation(
    pluginId: string,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    if (!pluginApi) {
      setInternalState((current) => ({
        ...current,
        errorMessage: 'Plugin API unavailable.',
      }));
      return;
    }

    setInternalState((current) => ({
      ...current,
      errorMessage: undefined,
      operationPluginId: pluginId,
    }));

    try {
      await operation();
      await loadPlugins();
    } catch (error) {
      setInternalState((current) => ({
        ...current,
        errorMessage: error instanceof Error ? error.message : 'Plugin operation failed.',
      }));
    } finally {
      setInternalState((current) => ({
        ...current,
        operationPluginId: undefined,
      }));
    }
  }

  return (
    <section className="settings-section plugin-settings" aria-label="Plugin management settings">
      <header className="settings-section__header">
        <h2>Plugin Management</h2>
        <span>{currentState.plugins.length}</span>
      </header>
      {currentState.errorMessage ? (
        <p className="settings-section__error" role="alert">
          {currentState.errorMessage}
        </p>
      ) : null}
      <div className="plugin-settings__list" aria-busy={currentState.isLoading}>
        {currentState.plugins.length === 0 ? (
          <p className="settings-empty">No local plugins installed</p>
        ) : (
          currentState.plugins.map((plugin) => {
            const isBusy = currentState.operationPluginId === plugin.id;

            return (
              <article className="plugin-settings__item" key={plugin.id}>
                <div>
                  <strong>{plugin.name}</strong>
                  <span>{plugin.id}</span>
                  <small>{formatPermissions(plugin.permissions)}</small>
                </div>
                <span className="settings-badge">{plugin.enabled ? 'Enabled' : 'Disabled'}</span>
                <button
                  aria-busy={isBusy}
                  disabled={isBusy}
                  type="button"
                  onClick={() =>
                    void runPluginOperation(plugin.id, () =>
                      pluginApi!.setPluginEnabled(plugin.id, !plugin.enabled),
                    )
                  }
                >
                  {plugin.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  aria-busy={isBusy}
                  disabled={isBusy}
                  type="button"
                  onClick={() =>
                    void runPluginOperation(plugin.id, () => pluginApi!.removePlugin(plugin.id))
                  }
                >
                  Uninstall
                </button>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
