import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PluginListRecord } from '../../../shared/settingsApi.js';
import { getUiStrings, type UiStrings } from '../i18n.js';

export interface PluginSettingsApi {
  installPlugin: (pluginRoot: string) => Promise<PluginListRecord>;
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
  strings?: UiStrings['settings']['plugin'] | undefined;
}

function getDefaultPluginSettingsApi(): PluginSettingsApi | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.desktopApi;
}

function formatPermissions(
  permissions: readonly string[],
  strings: UiStrings['settings']['plugin'],
): string {
  return permissions.length === 0 ? strings.noPermissions : permissions.join(', ');
}

export function PluginSettings({
  api,
  state,
  strings = getUiStrings(undefined).settings.plugin,
}: PluginSettingsProps) {
  const pluginApi = useMemo(() => api ?? getDefaultPluginSettingsApi(), [api]);
  const [internalState, setInternalState] = useState<PluginSettingsState>({
    errorMessage: undefined,
    isLoading: false,
    operationPluginId: undefined,
    plugins: [],
  });
  const currentState = state ?? internalState;
  const [pluginRoot, setPluginRoot] = useState('');

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
        errorMessage: error instanceof Error ? error.message : strings.loadError,
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
        errorMessage: strings.unavailable,
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
        errorMessage: error instanceof Error ? error.message : strings.operationError,
      }));
    } finally {
      setInternalState((current) => ({
        ...current,
        operationPluginId: undefined,
      }));
    }
  }

  return (
    <section className="settings-section plugin-settings" aria-label={strings.ariaLabel}>
      <header className="settings-section__header">
        <h2>{strings.title}</h2>
        <span>{currentState.plugins.length}</span>
      </header>
      <form
        className="plugin-settings__install"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedPluginRoot = pluginRoot.trim();

          if (trimmedPluginRoot.length === 0) {
            setInternalState((current) => ({
              ...current,
              errorMessage: strings.pathRequired,
            }));
            return;
          }

          void runPluginOperation('install', () => pluginApi!.installPlugin(trimmedPluginRoot));
          setPluginRoot('');
        }}
      >
        <input
          aria-label={strings.pathLabel}
          placeholder="C:\\CommandCabin\\plugins\\example"
          type="text"
          value={pluginRoot}
          onChange={(event) => setPluginRoot(event.currentTarget.value)}
        />
        <button
          aria-busy={currentState.operationPluginId === 'install'}
          disabled={currentState.operationPluginId === 'install'}
          type="submit"
        >
          {strings.install}
        </button>
      </form>
      {currentState.errorMessage ? (
        <p className="settings-section__error" role="alert">
          {currentState.errorMessage}
        </p>
      ) : null}
      <div className="plugin-settings__list" aria-busy={currentState.isLoading}>
        {currentState.plugins.length === 0 ? (
          <p className="settings-empty">{strings.empty}</p>
        ) : (
          currentState.plugins.map((plugin) => {
            const isBusy = currentState.operationPluginId === plugin.id;

            return (
              <article className="plugin-settings__item" key={plugin.id}>
                <div>
                  <strong>{plugin.name}</strong>
                  <span>{plugin.id}</span>
                  <small>{formatPermissions(plugin.permissions, strings)}</small>
                </div>
                <span className="settings-badge">
                  {plugin.enabled ? strings.enabled : strings.disabled}
                </span>
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
                  {plugin.enabled ? strings.disable : strings.enable}
                </button>
                <button
                  aria-busy={isBusy}
                  disabled={isBusy}
                  type="button"
                  onClick={() =>
                    void runPluginOperation(plugin.id, () => pluginApi!.removePlugin(plugin.id))
                  }
                >
                  {strings.uninstall}
                </button>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
