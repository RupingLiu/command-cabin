import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  CommandCabinSettings,
  CommandCabinSettingsPatch,
  CommandCabinTheme,
} from '@command-cabin/core';

import { ClipboardHistorySettings } from './ClipboardHistorySettings.js';
import { DataSettings } from './DataSettings.js';
import { FavoritesSettings } from './FavoritesSettings.js';
import { HotkeySettings } from './HotkeySettings.js';
import { PluginSettings } from './PluginSettings.js';
import { ThemeSettings } from './ThemeSettings.js';

export interface SettingsPageApi {
  getSettings: () => Promise<CommandCabinSettings>;
  updateSettings: (patch: CommandCabinSettingsPatch) => Promise<CommandCabinSettings>;
}

export interface SettingsPageProps {
  api?: SettingsPageApi;
  onReturnToLauncher: () => void;
}

function getDefaultSettingsPageApi(): SettingsPageApi | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.desktopApi;
}

export function SettingsPage({ api, onReturnToLauncher }: SettingsPageProps) {
  const settingsApi = useMemo(() => api ?? getDefaultSettingsPageApi(), [api]);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);
  const [settings, setSettings] = useState<CommandCabinSettings | undefined>();

  useEffect(() => {
    if (!settingsApi) {
      return;
    }

    let isCurrent = true;

    settingsApi
      .getSettings()
      .then((loadedSettings) => {
        if (isCurrent) {
          setSettings(loadedSettings);
        }
      })
      .catch((error: unknown) => {
        if (isCurrent) {
          setErrorMessage(error instanceof Error ? error.message : 'Settings could not be loaded.');
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [settingsApi]);

  const updateSettings = useCallback(
    async (patch: CommandCabinSettingsPatch) => {
      if (!settingsApi) {
        throw new Error('Settings API unavailable.');
      }

      setIsSaving(true);
      setErrorMessage(undefined);

      try {
        const updatedSettings = await settingsApi.updateSettings(patch);
        setSettings(updatedSettings);
        return updatedSettings;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Settings could not be saved.';
        setErrorMessage(message);
        throw new Error(message, { cause: error });
      } finally {
        setIsSaving(false);
      }
    },
    [settingsApi],
  );

  return (
    <main className="settings-shell">
      <section className="settings-frame" aria-label="CommandCabin settings">
        <header className="settings-titlebar">
          <div>
            <p className="launcher-kicker">Settings</p>
            <h1>CommandCabin</h1>
          </div>
          <button className="settings-back" type="button" onClick={onReturnToLauncher}>
            Back
          </button>
        </header>

        {errorMessage ? (
          <p className="settings-section__error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <div className="settings-grid">
          <HotkeySettings
            errorMessage={settingsApi ? undefined : 'Settings API unavailable.'}
            isSaving={isSaving}
            value={settings?.hotkey}
            onHotkeyChange={(hotkey) => updateSettings({ hotkey })}
          />
          <ThemeSettings
            isSaving={isSaving}
            value={settings?.theme}
            onThemeChange={(theme: CommandCabinTheme) => updateSettings({ theme })}
          />
          <PluginSettings />
          <DataSettings />
          <FavoritesSettings />
          <ClipboardHistorySettings />
        </div>
      </section>
    </main>
  );
}
